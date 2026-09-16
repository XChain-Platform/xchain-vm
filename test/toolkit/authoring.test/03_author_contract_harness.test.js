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
const { authorContract } = require('../../../src/toolkit/authoring.js');

// A gate-clean counter contract used as the model's "good" answer. It carries
// `meta` because CONTRACT_META_REQUIRED makes identity a deploy verdict: a
// nameless contract is gate-BLOCKED, which is what NAMELESS_CONTRACT below drives.
const CLEAN_CONTRACT = `// SPDX-License-Identifier: MIT
module.exports = {
    meta: { name: 'Counter', description: 'A counter anyone may increment.', version: '1.0.0' },
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
// It carries a valid `meta` so it fails on exactly one axis.
const BAD_CONTRACT = `module.exports = {
    meta: { name: 'Powers', description: 'Stores a power of two.', version: '1.0.0' },
    initialize: function (xchain) {
        xchain.state.set('x', String(Math.pow(2, 3)));
    }
};`;

// Determinism-clean but with no identity: the shape CONTRACT_META_REQUIRED
// rejects on chain, and therefore the shape the repair loop has to fix.
const NAMELESS_CONTRACT = `module.exports = {
    initialize: function (xchain) {
        xchain.state.set('count', '0');
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

    it('repairs a model answer that omits meta, citing the consensus string', async function () {
        const complete = fakeComplete([reply(NAMELESS_CONTRACT), reply(CLEAN_CONTRACT)]);
        const res = await authorContract({ mode: 'describe', input: 'a counter', complete, maxRepairs: 2 });
        assert.strictEqual(res.ok, true);
        assert.strictEqual(res.attempts, 2, 'the nameless answer must cost exactly one repair round');
        const repairMsg = res.transcript.find(m => m.role === 'user' &&
            /invalid: CONTRACT_MANIFEST \(meta required\)/.test(m.content));
        assert(repairMsg, 'the repair prompt must feed back the chain\'s own verdict string');
        assert(/contract-meta/.test(repairMsg.content), 'and name the rule that blocked it');
    });

    it('reports a still-nameless contract as a gate failure after the retry budget', async function () {
        const complete = fakeComplete([reply(NAMELESS_CONTRACT)]); // never adds meta
        const res = await authorContract({ mode: 'describe', input: 'x', complete, maxRepairs: 1 });
        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.attempts, 2);
        assert(res.gate.errors.some(e => e.rule === 'contract-meta'),
            'the unrepaired failure must surface as a blocking contract-meta error');
    });

    it('gives up after maxRepairs and returns the last gate failure', async function () {
        const complete = fakeComplete([reply(BAD_CONTRACT)]); // always bad
        const res = await authorContract({ mode: 'describe', input: 'x', complete, maxRepairs: 2 });
        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.attempts, 3, 'first try + 2 repairs');
        assert(res.gate && res.gate.errors.some(e => e.rule === 'banned-math'));
    });

});

describe('Toolkit authoring: authorContract harness', function () {
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
    meta: { name: 'Typed', description: 'A typed counter.', version: '1.0.0' },
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

});

describe('Toolkit authoring: authorContract harness', function () {
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
