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
 * Src proposal: claude/reports/archive/2026-06-20_evm-solidity-onramp-proposal.md
 * (Tier 3). XChain contracts are plain JS, so an LLM writes them well; the
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
 *      with the Solidity->XChain guide and the deploy gate.
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

// Canonical knowledge base. Sourced from developer-guide/Solidity_To_XChain.md
// (itself verified against src/gateway.js / gateway-emit.js). Kept as structured
// data so it drives the prompt AND is assertable in tests; a drift here is a
// drift the authoring prompt would teach the model, so it is worth pinning.

// The three model shifts an EVM author must internalize.
const MODEL_SHIFTS = [
    'Contracts orchestrate; they never mutate the ledger. You cannot write a ' +
        'balance. You emit a validated ACTION (xchain.emit.*) and the protocol\'s ' +
        'audited handler moves tokens. A contract may only emit ACTIONs a user could.',
    'There is no msg.value. Value does not ride a call. Tokens enter a contract ' +
        'via a separate DEPOSIT action to the contract address; logic runs via ' +
        'EXECUTE; the caller makes them atomic with BATCH. Trust your own balance ' +
        '(xchain.getBalance(getContractAddress(), tick)), never a caller-supplied amount.',
    'Emissions are deferred (snapshot semantics). Emitted actions apply only after ' +
        'your method returns; getBalance/getTokenInfo reflect start-of-call state. ' +
        'A contract cannot observe its own emissions mid-call, so classic reentrancy ' +
        'is largely a non-issue. Compute from start-of-call state.'
];

// "Reach for a native primitive before writing a contract." { want, solidity, xchain }
const NATIVE_PRIMITIVES = [
    { want: 'A fungible token', solidity: 'write an ERC-20', xchain: 'ISSUE action (tokens are first-class); no contract' },
    { want: 'Transfer a token', solidity: 'transfer()', xchain: 'SEND action' },
    { want: 'Check a balance', solidity: 'balanceOf()', xchain: 'explorer/SDK query, or in-contract getBalance(addr, tick)' },
    { want: 'An NFT', solidity: 'ERC-721', xchain: 'ISSUE with DECIMALS=0 + LOCK_MAX_SUPPLY=1' },
    { want: 'Token sale', solidity: 'crowdsale contract', xchain: 'DISPENSER action, or the crowdsale template' },
    { want: 'Swap two tokens', solidity: 'a DEX pair', xchain: 'ORDER / SWAP actions, or the amm template' },
    { want: 'Pay dividends', solidity: 'loop transfers', xchain: 'DIVIDEND action' },
    { want: 'Airdrop', solidity: 'loop transfers', xchain: 'AIRDROP action over a LIST' },
    { want: 'Enforced royalties / transfer rules', solidity: 'ERC-20 hooks / ERC-2981', xchain: 'controller-bound token: a guard contract bound at ISSUE (v6)' }
];

// Solidity -> XChain concept map. { solidity, xchain, note }
const CONCEPT_MAP = [
    { solidity: 'constructor', xchain: 'initialize(xchain)', note: 'runs once at DEPLOY with CONSTRUCTOR_PARAMS' },
    { solidity: 'function f() public', xchain: 'f: function (xchain) { ... }', note: 'invoked by name via EXECUTE' },
    { solidity: 'function arguments', xchain: 'xchain.getInputParam(i) / getInputParamCount()', note: 'all params are strings' },
    { solidity: 'msg.sender', xchain: 'xchain.getSourceAddress()', note: 'the calling address' },
    { solidity: 'address(this)', xchain: 'xchain.getContractAddress()', note: 'C:CHAIN:index' },
    { solidity: 'msg.value', xchain: '(none)', note: 'use DEPOSIT + BATCH; read getBalance(getContractAddress(), tick)' },
    { solidity: 'block.number', xchain: 'xchain.getBlockHeight()', note: '' },
    { solidity: 'block.timestamp', xchain: 'xchain.getBlockTimestamp()', note: '' },
    { solidity: 'blockhash(n)', xchain: 'xchain.getBlockHash()', note: 'current block only' },
    { solidity: 'storage variable', xchain: 'xchain.state.set/get/has/delete', note: 'flat k/v; values are strings (JSON for structs)' },
    { solidity: 'mapping(k => v)', xchain: 'composed key, e.g. state.set("bal:" + addr, amt)', note: 'no native map type' },
    { solidity: 'struct', xchain: 'JSON string in one key', note: 'state.set("cfg", JSON.stringify(obj))' },
    { solidity: 'require(c, "m")', xchain: 'xchain.require(c, "m")', note: 'reverts the whole execution + emissions' },
    { solidity: 'revert("m")', xchain: 'xchain.revert("m")', note: '' },
    { solidity: 'emit Event(...)', xchain: 'xchain.emit.broadcast(...)', note: 'or rely on the indexer action log' },
    { solidity: 'uint math / SafeMath', xchain: 'xchain.math.add/subtract/multiply/divide/compare/gt/gte/lt/lte/eq/...', note: 'bignumber, no overflow; FLOATS ARE REJECTED AT DEPLOY' },
    { solidity: 'transfer / send value', xchain: 'xchain.emit.send({ ... })', note: 'emits SEND; applied after return' },
    { solidity: 'external call returning a value', xchain: 'xchain.emit.execute({ contractIndex, method, params, gasLimit })', note: 'ASYNC, NO return value; respond via a callback method' },
    { solidity: 'cross-chain call', xchain: 'xchain.emit.crossExecute({ targetChain, contractIndex, method, params, gasLimit, callbackMethod, callbackParams, deadlineBlocks })', note: 'bridgeless; target must export crossCallable' },
    { solidity: 'modifier onlyOwner', xchain: 'a guard helper from patterns/', note: 'check getSourceAddress() against stored owner' },
    { solidity: 'Ownable / AccessControl', xchain: 'patterns/ access control (OZ-equivalent, audited)', note: '' },
    { solidity: 'Pausable', xchain: 'patterns/ pausable (or token-level SLEEP)', note: '' },
    { solidity: 'ReentrancyGuard', xchain: 'usually unnecessary', note: 'snapshot semantics; keep state-before-emit discipline' },
    { solidity: 'view / pure', xchain: 'a method that only reads', note: 'just do not write state or emit' },
    { solidity: 'oracle price feed (Chainlink)', xchain: 'xchain.oracle.getPrice(coinPair)', note: 'validator-attested, built in' },
    { solidity: 'external data / API', xchain: 'xchain.attestation.request(providerId, payload, callbackMethod, callbackParams, opts)', note: 'PBFT-certified; http_get and llm providers' },
    { solidity: 'payable receive()', xchain: '(none)', note: 'DEPOSIT' },
    { solidity: 'selfdestruct / delegatecall', xchain: '(none)', note: 'not in the model' },
    { solidity: 'gas limit', xchain: 'GAS_LIMIT on deploy/execute; sdk.suggestGasLimit(...)', note: 'metered per the gas schedule' }
];

// Non-negotiable rules the generated contract MUST satisfy (these are exactly
// what the deploy gate blocks on; teaching them up front cuts repair rounds).
const HARD_RULES = [
    'Export a CommonJS module: `module.exports = { initialize, methodA, ... }` (object of methods) or a single `module.exports = function (xchain) {...}`. Each method takes exactly one argument: the `xchain` gateway.',
    'No floats anywhere. No numeric literal with a decimal point, no native Math.sqrt/pow/log/log2/log10 (use xchain.math.* bignumber ops). Token amounts are decimal STRINGS.',
    'No BigInt literals, no RegExp literals, no `new RegExp`.',
    'No async surface: no `async`, no `await`, no `Promise`. Methods are synchronous.',
    'No banned globals: no Date, setTimeout, setInterval, fetch, eval, Function, Proxy, Reflect, SharedArrayBuffer. No `.constructor` access. No `require`/`import`/filesystem/network.',
    'ES2020 syntax maximum (no numeric separators, no logical-assignment, no top-level await).',
    'Do not reference identifiers beginning `__gas`/`__concat`/`__tmpl`/`__arrspread`/`__objspread` (reserved by the metering pass).',
    'State keys <= 1024 bytes, values <= 65536 bytes (JSON), <= 10000 keys total; at most 50 emitted actions per call.'
];

const CONTRACT_SHAPE = [
    '// SPDX-License-Identifier: MIT',
    'module.exports = {',
    '    initialize: function (xchain) {           // constructor; runs once at DEPLOY',
    '        var owner = xchain.getInputParam(0);  // params arrive as strings',
    '        xchain.require(owner, "owner required");',
    '        xchain.state.set("owner", owner);',
    '    },',
    '    doThing: function (xchain) {               // a public method, invoked by name',
    '        xchain.require(xchain.getSourceAddress() === xchain.state.get("owner"), "not owner");',
    '        var n = xchain.state.get("n") || "0";',
    '        xchain.state.set("n", xchain.math.add(n, "1"));  // bignumber math, never native +',
    '    }',
    '};'
].join('\n');

const KNOWLEDGE = {
    modelShifts: MODEL_SHIFTS,
    nativePrimitives: NATIVE_PRIMITIVES,
    conceptMap: CONCEPT_MAP,
    hardRules: HARD_RULES,
    contractShape: CONTRACT_SHAPE
};

// Prompt construction

function renderConceptMap() {
    return CONCEPT_MAP
        .map((r) => '- `' + r.solidity + '` -> ' + r.xchain + (r.note ? '  (' + r.note + ')' : ''))
        .join('\n');
}

function renderNativePrimitives() {
    return NATIVE_PRIMITIVES
        .map((r) => '- ' + r.want + ': in Solidity you\'d ' + r.solidity + '; on XChain use ' + r.xchain)
        .join('\n');
}

function renderNumbered(list) {
    return list.map((s, i) => (i + 1) + '. ' + s).join('\n');
}

/**
 * The system prompt: everything the model needs to write a gate-clean XChain
 * contract, independent of the specific request. Deterministic (no timestamps),
 * so it is snapshot-testable.
 * @param {object} [opts]
 * @param {boolean} [opts.typescript] - ask for a TypeScript contract (types erased at build)
 * @returns {string}
 */
function buildSystemPrompt(opts = {}) {
    const lang = opts.typescript ? 'TypeScript (erasable types only: no enums, namespaces, or decorators)' : 'JavaScript';
    return [
        'You are an expert XChain Platform smart-contract author. An XChain contract is a ' +
            'DETERMINISTIC ' + lang + ' program run in a sandboxed V8 isolate. It custodies tokens ' +
            'and emits validated protocol ACTIONs; it never mutates the ledger directly.',
        '',
        'THREE MODEL SHIFTS an EVM/Solidity developer must respect:',
        renderNumbered(MODEL_SHIFTS),
        '',
        'BEFORE writing a contract, prefer a native protocol primitive when one fits:',
        renderNativePrimitives(),
        '',
        'SOLIDITY -> XCHAIN CONCEPT MAP:',
        renderConceptMap(),
        '',
        'HARD RULES (the on-chain deploy gate REJECTS any violation, so the contract will not deploy):',
        renderNumbered(HARD_RULES),
        '',
        'CONTRACT SHAPE:',
        '```javascript',
        CONTRACT_SHAPE,
        '```',
        '',
        'OUTPUT FORMAT: reply with exactly one fenced code block containing the complete ' +
            'single-file contract, then (optional) a short "Notes:" section. Do not split the ' +
            'contract across multiple code blocks. No prose inside the code block except comments.'
    ].join('\n');
}

/**
 * Build the user message for an authoring request.
 * @param {object} opts
 * @param {'describe'|'from-solidity'} opts.mode
 * @param {string} opts.input - English brief (describe) or Solidity source (from-solidity)
 * @returns {string}
 */
function buildUserPrompt(opts = {}) {
    const mode = opts.mode || 'describe';
    const input = String(opts.input == null ? '' : opts.input);
    if (mode === 'from-solidity') {
        return [
            'Translate the following Solidity contract into the equivalent XChain contract. ' +
                'Where a native XChain primitive replaces the whole contract (e.g. an ERC-20 is ' +
                'just an ISSUE action), say so instead of porting it. In a "Notes:" section after ' +
                'the code, explain the meaningful DIFFERENCES from the Solidity original ' +
                '(msg.value -> DEPOSIT, synchronous return -> callback, reentrancy handling, etc.).',
            '',
            'Solidity source:',
            '```solidity',
            input,
            '```'
        ].join('\n');
    }
    // describe (English brief)
    return [
        'Write an XChain smart contract that does the following:',
        '',
        input,
        '',
        'If a native protocol primitive already covers this without a contract, say so in a ' +
            '"Notes:" section and provide the smallest useful contract (or none).'
    ].join('\n');
}

/**
 * Full prompt for one authoring request: { system, user, messages }.
 * `messages` is the chat-style array ([{role,content}...]) most clients accept.
 * @param {object} opts - { mode, input, typescript? }
 */
function buildAuthoringPrompt(opts = {}) {
    if (opts.mode && opts.mode !== 'describe' && opts.mode !== 'from-solidity') {
        throw new Error('unknown authoring mode: ' + opts.mode + ' (use "describe" or "from-solidity")');
    }
    const system = buildSystemPrompt(opts);
    const user = buildUserPrompt(opts);
    return {
        system,
        user,
        messages: [
            { role: 'system', content: system },
            { role: 'user', content: user }
        ]
    };
}

/**
 * A repair message that feeds the deploy-gate errors back to the model so it can
 * fix the previous attempt. This is the loop that makes the harness reliable:
 * the model does not have to be perfect, it has to converge.
 * @param {string} previousCode - the (already TS-stripped) code that failed
 * @param {object} gateResult   - a runGate() result with .errors
 * @returns {string}
 */
function buildRepairPrompt(previousCode, gateResult) {
    const errs = (gateResult && gateResult.errors) || [];
    const lines = errs.map((e) => '- ' + (e.line ? 'line ' + e.line + ': ' : '') +
        (e.rule ? e.rule + ': ' : '') + e.message);
    return [
        'The previous contract FAILS the XChain deploy determinism gate and would be rejected ' +
            'on deploy. Fix every error below and return the corrected complete contract in one ' +
            'fenced code block. Do not introduce new violations of the HARD RULES.',
        '',
        'Gate errors:',
        lines.length ? lines.join('\n') : '- (none reported; ensure the export shape is a module.exports object or function)',
        '',
        'Previous contract:',
        '```javascript',
        String(previousCode),
        '```'
    ].join('\n');
}

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
    const complete = opts.complete;
    if (typeof complete !== 'function') {
        throw new Error('authorContract requires an injected `complete(messages)` function');
    }
    const gate = typeof opts.gate === 'function' ? opts.gate : runGate;
    const maxRepairs = Number.isInteger(opts.maxRepairs) ? Math.max(0, opts.maxRepairs) : 2;
    const requestedTs = !!opts.typescript;

    const { messages } = buildAuthoringPrompt({ mode: opts.mode, input: opts.input, typescript: requestedTs });
    const transcript = messages.slice();

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
