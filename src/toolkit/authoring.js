/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * XChain VM Toolkit: AI-assisted contract authoring (Tier-3 on-ramp)
 *
 * Tier 3 of the contract-authoring on-ramp. XChain contracts are plain JS, so an LLM writes them well; the
 * differentiated on-ramp is "describe your contract in English -> a typed,
 * linted XChain contract" and "paste your Solidity -> the XChain equivalent
 * with the differences explained." That reframes "we don't run Solidity" into
 * "you don't need it," and for EVM migration it is an LLM task, not a compiler
 * to build and maintain.
 *
 * This module is the HARNESS around that idea, not an LLM. It is deliberately
 * model/provider-agnostic and network-free:
 *
 *   1. A canonical KNOWLEDGE base (concept map, model shifts, native-primitive
 *      shortcuts, gateway surface, and hard determinism rules), kept in lockstep
 *      with the Solidity->XChain guide, the deploy gate and the sandbox's
 *      stripped-global list. Note the last of those is NOT deploy-blocking: the
 *      globals are deleted from the isolate at runtime, so a contract using one
 *      passes the gate and throws on its first execution. The taught list is not
 *      a copy: it is required from src/stripped_globals.js, the one definition
 *      sandbox.js and lint_core.js consume too, which is dependency-free so this
 *      module stays isolated-vm-free while sandbox.js is not.
 *   2. buildAuthoringPrompt() turns an English brief or a Solidity source into a
 *      well-formed system+user message pair embedding that knowledge.
 *   3. authorContract() runs a caller-injected `complete()` (any LLM client) and
 *      pipes the result through the SAME static determinism gate the on-chain
 *      deploy validator uses (toolkit gate.runGate), with an automatic repair
 *      loop: gate errors are fed back as a fix-it prompt until the contract is
 *      gate-clean or the retry budget is spent.
 *
 * Because `complete` is injected, the whole harness (including the repair loop)
 * is unit-testable with a fake completion and runs on any OS/CPU: the gate is
 * pure acorn, no isolated-vm. Wiring a real model (or the platform's own `llm`
 * attestation provider) is the caller's concern.
 ********************************************************************/
// @ts-nocheck

const { runGate } = require('./gate.js');
const { isTypeScript, toContractJs } = require('./transpile.js');

const {
    MODEL_SHIFTS,
    NATIVE_PRIMITIVES,
    CONCEPT_MAP,
    RESERVED_NAMES_TAUGHT,
    HARD_RULES,
    CONTRACT_SHAPE
} = require('./authoring/authoring_knowledge.js');
const { STRIPPED_GLOBAL_NAMES: STRIPPED_GLOBALS_TAUGHT } = require('../stripped_globals.js');
const {
    buildSystemPrompt,
    buildUserPrompt,
    buildAuthoringPrompt,
    buildRepairPrompt
} = require('./authoring/prompt_builders.js');

const KNOWLEDGE = {
    modelShifts: MODEL_SHIFTS,
    nativePrimitives: NATIVE_PRIMITIVES,
    conceptMap: CONCEPT_MAP,
    hardRules: HARD_RULES,
    // The sandbox's stripped-global list, straight from src/stripped_globals.js.
    // Exported so a test can compare it to the enforced list by value rather
    // than by grepping rendered prose.
    strippedGlobals: STRIPPED_GLOBALS_TAUGHT,
    // The deploy gate's reserved identifiers, derived from metering.js and
    // lint_core.js. Exported for the same reason strippedGlobals is: a test
    // compares it to the enforced lists by value instead of grepping prose.
    reservedIdentifiers: RESERVED_NAMES_TAUGHT,
    contractShape: CONTRACT_SHAPE
};

// Response parsing

// Pull the FIRST fenced code block. Accepts ```js / ```javascript / ```ts /
// ```typescript / bare ```. Returns null if no fence is present (some models
// answer with raw code; the caller falls back to the whole text then).
function firstFencedBlock(text) {
    const s = String(text == null ? '' : text);
    const re = /```[ \t]*([a-zA-Z0-9_+-]*)[ \t]*\r?\n([\s\S]*?)```/;
    const m = re.exec(s);
    if (!m) return null;
    // NB: `re` has no /g flag, so re.lastIndex stays 0; derive the end from the match.
    const endIndex = m.index + m[0].length;
    return { lang: (m[1] || '').toLowerCase(), code: m[2].replace(/\s+$/, ''), index: m.index, endIndex };
}

/**
 * Extract the contract source and any "Notes:" prose from an LLM response.
 * @param {string} text
 * @returns {{ code:string|null, lang:string, notes:string, hadFence:boolean }}
 *   code  - the contract source (fenced block if present, else the raw trimmed text)
 *   lang  - the fence language tag lowercased ('' if none/bare)
 *   notes - text AFTER the code block (the "differences explained" for Solidity mode)
 *   hadFence - whether a real code fence was found
 */
function extractContractCode(text) {
    const s = String(text == null ? '' : text);
    const block = firstFencedBlock(s);
    if (!block) {
        // No fence: treat the whole response as code, but strip an obvious
        // leading "Notes:"/prose tail we cannot attribute. Keep it simple: raw.
        const trimmed = s.trim();
        return { code: trimmed.length ? trimmed : null, lang: '', notes: '', hadFence: false };
    }
    let notes = s.slice(block.endIndex);
    // Trim a leading "Notes:" label and surrounding whitespace for a clean field.
    notes = notes.replace(/^\s*(notes?\s*:?\s*)/i, '').trim();
    return { code: block.code || null, lang: block.lang, notes, hadFence: true };
}

// The harness

// A fence tag like 'ts'/'typescript' means the returned code is TypeScript and
// must be stripped before the gate (which is JS-only) sees it.
function looksTypeScript(lang, requestedTs) {
    if (lang === 'ts' || lang === 'typescript') return true;
    if (lang === 'js' || lang === 'javascript') return false;
    return !!requestedTs; // bare fence: honor what we asked for
}

function prepareAuthoringRun(opts) {
    const complete = opts.complete;
    if (typeof complete !== 'function') {
        throw new Error('authorContract requires an injected `complete(messages)` function');
    }
    const gate = typeof opts.gate === 'function' ? opts.gate : runGate;
    const maxRepairs = Number.isInteger(opts.maxRepairs) ? Math.max(0, opts.maxRepairs) : 2;
    const requestedTs = !!opts.typescript;
    const { messages } = buildAuthoringPrompt({
        mode: opts.mode,
        input: opts.input,
        typescript: requestedTs,
        name: opts.name,
        description: opts.description
    });
    return { complete, gate, maxRepairs, requestedTs, transcript: messages.slice() };
}

/**
 * Author a contract with an injected LLM `complete`, validating and repairing
 * against the real deploy gate until clean or out of retries.
 *
 * @param {object} opts
 * @param {'describe'|'from-solidity'} opts.mode
 * @param {string} opts.input                     - English brief or Solidity source
 * @param {(messages:Array)=>(string|Promise<string>)} opts.complete
 *        The LLM client. Receives a [{role,content}] array, returns the model's
 *        text. Injected so the harness is provider-agnostic and testable; the
 *        caller wires a real model (or the platform `llm` attestation provider).
 * @param {boolean} [opts.typescript]             - request/allow a TS contract
 * @param {string}  [opts.name]                   - pin the contract's meta.name
 * @param {string}  [opts.description]            - pin the contract's meta.description
 * @param {number}  [opts.maxRepairs=2]           - gate-driven repair attempts after the first
 * @param {(code:string)=>object} [opts.gate=runGate] - override the gate (tests)
 * @returns {Promise<{ ok:boolean, code:string|null, contractJs:string|null,
 *   notes:string, gate:object|null, attempts:number, transcript:Array }>}
 *   code       - contract source as returned (TS if the model wrote TS)
 *   contractJs - the JS the gate saw (TS stripped); what you deploy/simulate
 *   gate       - the final runGate() result (ok/errors/advisories/warnings/gas)
 *   attempts   - number of model calls made
 *   transcript - [{ role, content }] of every message + model reply, for audit
 */
async function authorContract(opts = {}) {
    const { complete, gate, maxRepairs, requestedTs, transcript } = prepareAuthoringRun(opts);

    let attempts = 0;
    let last = { ok: false, code: null, contractJs: null, notes: '', gate: null };

    for (let round = 0; round <= maxRepairs; round++) {
        const reply = await complete(transcript.slice());
        attempts++;
        transcript.push({ role: 'assistant', content: String(reply == null ? '' : reply) });

        const extracted = extractContractCode(reply);
        const code = extracted.code;
        if (!code) {
            // Nothing usable came back; ask again with an explicit shape reminder.
            last = { ok: false, code: null, contractJs: null, notes: extracted.notes, gate: null };
            if (round < maxRepairs) {
                transcript.push({ role: 'user', content: buildRepairPrompt('', { errors: [{ rule: 'no-code', message: 'no fenced contract code was returned' }] }) });
            }
            continue;
        }

        // TS -> JS for the gate. A strip failure is itself a fixable error.
        let contractJs = code;
        const isTs = looksTypeScript(extracted.lang, requestedTs);
        if (isTs) {
            try {
                contractJs = toContractJs(code, 'contract.ts');
            } catch (e) {
                last = { ok: false, code, contractJs: null, notes: extracted.notes, gate: { ok: false, errors: [{ rule: 'ts-strip', message: e.message }], advisories: [], warnings: [], gas: null } };
                if (round < maxRepairs) transcript.push({ role: 'user', content: buildRepairPrompt(code, last.gate) });
                continue;
            }
        }

        const result = gate(contractJs);
        last = { ok: result.ok, code, contractJs, notes: extracted.notes, gate: result };
        if (result.ok) break;

        if (round < maxRepairs) {
            transcript.push({ role: 'user', content: buildRepairPrompt(contractJs, result) });
        }
    }

    return {
        ok: last.ok,
        code: last.code,
        contractJs: last.contractJs,
        notes: last.notes,
        gate: last.gate,
        attempts,
        transcript
    };
}

module.exports = {
    KNOWLEDGE,
    buildSystemPrompt,
    buildUserPrompt,
    buildAuthoringPrompt,
    buildRepairPrompt,
    extractContractCode,
    authorContract,
    // exported for the CLI / advanced callers
    isTypeScript
};
