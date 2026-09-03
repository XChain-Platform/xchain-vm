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
 * Toolkit: AI-assisted contract authoring harness (Tier 3).
 *
 * Pure/static: the `complete` LLM client is injected (fake), and validation
 * runs the acorn-only deploy gate, so this suite needs no isolated-vm and runs
 * on any OS/CPU. Require the module DIRECTLY (not the toolkit index) to keep it
 * runnable where isolated-vm cannot dlopen.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const {
    KNOWLEDGE,
    buildSystemPrompt,
    buildUserPrompt,
    buildAuthoringPrompt,
    buildRepairPrompt,
    extractContractCode,
    authorContract
} = require('../../src/toolkit/authoring.js');
const { runGate } = require('../../src/toolkit/gate.js');
const SHARED = require('../../src/stripped-globals.js');

// sandbox.js requires isolated-vm at the top level, so it is loaded defensively
// (same convention as test/unit/lint-shared-rules.test.js): the strip-set parity
// guard below runs for real on Node 22 / Linux and skips where the binding
// cannot dlopen. Everything else in this suite stays isolate-free.
let sandboxMod = null;
try { sandboxMod = require('../../src/sandbox.js'); } catch (e) { /* no isolate */ }

// A gate-clean counter contract used as the model's "good" answer.
const CLEAN_CONTRACT = `// SPDX-License-Identifier: MIT
module.exports = {
    initialize: function (xchain) {
        xchain.state.set('count', '0');
    },
    increment: function (xchain) {
        var c = xchain.state.get('count') || '0';
        xchain.state.set('count', xchain.math.add(c, '1'));
        return xchain.state.get('count');
    }
};`;

// A contract that FAILS the deploy gate: native Math.pow (banned transcendental).
const BAD_CONTRACT = `module.exports = {
    initialize: function (xchain) {
        xchain.state.set('x', String(Math.pow(2, 3)));
    }
};`;

// Wrap contract source in a model-style fenced reply, optionally with notes.
function reply(code, lang, notes) {
    let out = '```' + (lang || 'javascript') + '\n' + code + '\n```';
    if (notes) out += '\n\nNotes:\n' + notes;
    return out;
}

// A fake LLM: returns queued replies in order; asserts it is called correctly.
function fakeComplete(replies) {
    let i = 0;
    const calls = [];
    const fn = function (messages) {
        calls.push(messages);
        const r = replies[Math.min(i, replies.length - 1)];
        i++;
        return r;
    };
    fn.calls = calls;
    return fn;
}

describe('Toolkit authoring: knowledge base', function () {
    it('exposes the canonical concept map and hard rules', function () {
        assert(Array.isArray(KNOWLEDGE.conceptMap) && KNOWLEDGE.conceptMap.length > 10);
        assert(Array.isArray(KNOWLEDGE.hardRules) && KNOWLEDGE.hardRules.length > 0);
        assert(Array.isArray(KNOWLEDGE.modelShifts) && KNOWLEDGE.modelShifts.length === 3);
        // The most important mapping must be present.
        assert(KNOWLEDGE.conceptMap.some(r => /msg\.sender/.test(r.solidity)));
        assert(KNOWLEDGE.conceptMap.some(r => /msg\.value/.test(r.solidity)));
    });

    it('teaches the one shared definition, not a copy of it', function () {
        // authoring.js must stay isolated-vm-free (the gate is pure acorn and the
        // harness runs on any OS), so it requires src/stripped-globals.js, the same
        // module sandbox.js and lint-core.js require, and this identity check runs
        // without the binding rather than skipping wherever isolated-vm will not load.
        assert.strictEqual(KNOWLEDGE.strippedGlobals, SHARED.STRIPPED_GLOBAL_NAMES,
            'the authoring knowledge base must teach the very array stripped-globals.js ' +
            'froze; a distinct array means a second literal crept back in');
        assert.strictEqual(KNOWLEDGE.strippedGlobals,
            require('../../src/lint-core.js').STRIPPED_GLOBAL_NAMES,
            'the knowledge base and the linter must read one source of truth');
    });

    it('the taught stripped-global list stays equal to sandbox.js STRIPPED_GLOBAL_NAMES', function () {
        // Defence in depth for the identity check above: sandbox.js interpolates
        // these names into the real strip script, so this proves the taught set is
        // what the isolate actually deletes. Skips without the binding, which is
        // why it is no longer the only guard.
        if (!sandboxMod || !sandboxMod.STRIPPED_GLOBAL_NAMES) return this.skip();
        assert.deepStrictEqual(
            KNOWLEDGE.strippedGlobals.slice().sort(),
            [...sandboxMod.STRIPPED_GLOBAL_NAMES].sort(),
            'the authoring prompt teaches a different set of stripped globals than the sandbox ' +
            'actually deletes; a name missing here is a global a model will happily emit, that ' +
            'lints clean, deploys, and then throws a ReferenceError on first execution'
        );
    });

    it('every taught stripped global reaches the rendered hard rules', function () {
        // The mirror only helps if it is actually rendered: a rule that dropped the
        // interpolation would still satisfy the equality test above.
        const text = KNOWLEDGE.hardRules.join('\n');
        for (const name of KNOWLEDGE.strippedGlobals) {
            assert.ok(new RegExp('\\b' + name + '\\b').test(text),
                'the hard rules never name the stripped global ' + name);
        }
    });

    it('KNOWLEDGE.contractShape is itself a gate-clean contract', function () {
        // If our own teaching example would be rejected on deploy, the prompt is lying.
        const g = runGate(KNOWLEDGE.contractShape);
        assert.strictEqual(g.ok, true, 'contractShape must pass the deploy gate: ' + JSON.stringify(g.errors));
    });
});

describe('Toolkit authoring: prompt construction', function () {
    it('system prompt embeds the model shifts, concept map, and hard rules', function () {
        const sys = buildSystemPrompt();
        assert(/msg\.sender/.test(sys) && /getSourceAddress/.test(sys));
        assert(/DEPOSIT/.test(sys) && /BATCH/.test(sys));
        assert(/REJECTS/.test(sys), 'must warn the gate rejects violations');
        // The stripped globals are NOT deploy-blocking: they are deleted from the
        // isolate, so that contract deploys and throws at execution. The prompt has
        // to say so, or an author reads a gate-clean lint as proof it will run.
        assert(/THROWS on its first execution/.test(sys),
            'must distinguish the runtime-throw class from the deploy-reject class');
        assert(/\bstructuredClone\b/.test(sys) && /\bperformance\b/.test(sys),
            'the rendered hard rules must carry the full stripped-global list');
        assert(/deterministic/i.test(sys));
    });

    it('describe mode puts the English brief in the user prompt', function () {
        const u = buildUserPrompt({ mode: 'describe', input: 'a vesting vault for TEAM tokens' });
        assert(/vesting vault for TEAM tokens/.test(u));
    });

    it('from-solidity mode fences the source and asks for a differences section', function () {
        const u = buildUserPrompt({ mode: 'from-solidity', input: 'contract C { uint x; }' });
        assert(/```solidity/.test(u));
        assert(/contract C \{ uint x; \}/.test(u));
        assert(/DIFFERENCES/.test(u));
    });

    it('buildAuthoringPrompt returns a chat-style messages array', function () {
        const p = buildAuthoringPrompt({ mode: 'describe', input: 'x' });
        assert.strictEqual(p.messages.length, 2);
        assert.strictEqual(p.messages[0].role, 'system');
        assert.strictEqual(p.messages[1].role, 'user');
    });

    it('typescript flag asks for erasable-types-only TS', function () {
        const sys = buildSystemPrompt({ typescript: true });
        assert(/TypeScript/.test(sys));
        assert(/no enums/i.test(sys));
    });

    it('rejects an unknown mode', function () {
        assert.throws(() => buildAuthoringPrompt({ mode: 'nope', input: 'x' }), /unknown authoring mode/);
    });

    it('repair prompt lists the gate errors and echoes the previous code', function () {
        const g = runGate(BAD_CONTRACT);
        assert.strictEqual(g.ok, false);
        const rp = buildRepairPrompt(BAD_CONTRACT, g);
        assert(/FAILS the XChain deploy determinism gate/.test(rp));
        assert(/banned-math/.test(rp));
        assert(/Math\.pow/.test(rp));
    });
});

describe('Toolkit authoring: response extraction', function () {
    it('pulls the first fenced block and separates trailing notes', function () {
        const r = reply(CLEAN_CONTRACT, 'javascript', 'value enters via DEPOSIT, not msg.value.');
        const ex = extractContractCode(r);
        assert.strictEqual(ex.hadFence, true);
        assert(/module\.exports/.test(ex.code));
        assert(/DEPOSIT/.test(ex.notes));
        assert(!/```/.test(ex.notes), 'notes must not include the fence');
    });

    it('reads the fence language tag', function () {
        const ex = extractContractCode(reply('const x = 1;', 'typescript'));
        assert.strictEqual(ex.lang, 'typescript');
    });

    it('falls back to raw text when there is no fence', function () {
        const ex = extractContractCode('module.exports = function (xchain) { return "1"; };');
        assert.strictEqual(ex.hadFence, false);
        assert(/module\.exports/.test(ex.code));
    });

    it('returns null code for empty input', function () {
        assert.strictEqual(extractContractCode('').code, null);
        assert.strictEqual(extractContractCode(null).code, null);
    });
});

describe('Toolkit authoring: authorContract harness', function () {
    it('happy path: a clean first answer passes the gate in one attempt', async function () {
        const complete = fakeComplete([reply(CLEAN_CONTRACT)]);
        const res = await authorContract({ mode: 'describe', input: 'a counter', complete });
        assert.strictEqual(res.ok, true);
        assert.strictEqual(res.attempts, 1);
        assert(res.gate.ok);
        assert(/module\.exports/.test(res.code));
    });

    it('repair loop: a bad first answer is fixed on the second attempt', async function () {
        const complete = fakeComplete([reply(BAD_CONTRACT), reply(CLEAN_CONTRACT)]);
        const res = await authorContract({ mode: 'describe', input: 'a counter', complete, maxRepairs: 2 });
        assert.strictEqual(res.ok, true);
        assert.strictEqual(res.attempts, 2, 'should have taken exactly one repair round');
        // The transcript must contain the repair prompt fed back to the model.
        const repairMsg = res.transcript.find(m => m.role === 'user' && /banned-math/.test(m.content));
        assert(repairMsg, 'a repair prompt citing banned-math must be in the transcript');
    });

    it('gives up after maxRepairs and returns the last gate failure', async function () {
        const complete = fakeComplete([reply(BAD_CONTRACT)]); // always bad
        const res = await authorContract({ mode: 'describe', input: 'x', complete, maxRepairs: 2 });
        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.attempts, 3, 'first try + 2 repairs');
        assert(res.gate && res.gate.errors.some(e => e.rule === 'banned-math'));
    });

    it('maxRepairs: 0 makes exactly one model call', async function () {
        const complete = fakeComplete([reply(BAD_CONTRACT)]);
        const res = await authorContract({ mode: 'describe', input: 'x', complete, maxRepairs: 0 });
        assert.strictEqual(res.attempts, 1);
        assert.strictEqual(res.ok, false);
    });

    it('handles a reply with no code by asking again', async function () {
        const complete = fakeComplete(['I cannot help with that.', reply(CLEAN_CONTRACT)]);
        const res = await authorContract({ mode: 'describe', input: 'x', complete, maxRepairs: 2 });
        assert.strictEqual(res.ok, true);
        assert.strictEqual(res.attempts, 2);
    });

    it('from-solidity: captures the model differences notes on success', async function () {
        const notes = 'msg.value has no equivalent; fund via DEPOSIT + BATCH.';
        const complete = fakeComplete([reply(CLEAN_CONTRACT, 'javascript', notes)]);
        const res = await authorContract({ mode: 'from-solidity', input: 'contract C {}', complete });
        assert.strictEqual(res.ok, true);
        assert(/DEPOSIT/.test(res.notes));
    });

    it('strips TypeScript before gating when the model returns TS', async function () {
        const tsContract = `module.exports = {
    initialize: function (xchain: any): void {
        let n: string = '0';
        xchain.state.set('n', n);
    }
};`;
        const complete = fakeComplete([reply(tsContract, 'typescript')]);
        const res = await authorContract({ mode: 'describe', input: 'x', complete, typescript: true });
        assert.strictEqual(res.ok, true, JSON.stringify(res.gate && res.gate.errors));
        // The gate saw JS: no type annotations survive in contractJs.
        assert(!/:\s*string/.test(res.contractJs), 'types must be erased before the gate');
    });

    it('throws when no complete function is injected', async function () {
        await assert.rejects(
            () => authorContract({ mode: 'describe', input: 'x' }),
            /requires an injected `complete/
        );
    });

    it('accepts an injected gate override (deterministic, no isolate)', async function () {
        let seen = null;
        const gate = (code) => { seen = code; return { ok: true, errors: [], advisories: [], warnings: [], gas: { suggested: 1 } }; };
        const complete = fakeComplete([reply('module.exports = function(x){};')]);
        const res = await authorContract({ mode: 'describe', input: 'x', complete, gate });
        assert.strictEqual(res.ok, true);
        assert(/module\.exports/.test(seen));
    });
});
