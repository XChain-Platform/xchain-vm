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
    buildRepairPrompt
} = require('../../../src/toolkit/authoring.js');
const { runGate } = require('../../../src/toolkit/gate.js');

// A contract that FAILS the deploy gate: native Math.pow (banned transcendental).
// It carries a valid `meta` so it fails on exactly one axis.
const BAD_CONTRACT = `module.exports = {
    meta: { name: 'Powers', description: 'Stores a power of two.', version: '1.0.0' },
    initialize: function (xchain) {
        xchain.state.set('x', String(Math.pow(2, 3)));
    }
};`;


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

    it('never claims a decimal literal is rejected at deploy, and still names the Math ban as blocking', function () {
        // Enforcement parity, derived from the gate rather than from prose: rule
        // 'float-literal' is absent from CONSENSUS_RULES, so a contract with `0.5`
        // deploys with a warning (test/toolkit/gate.test.js pins that), while
        // 'banned-math' IS in the set and rejects. Guidance that welds the two into
        // one "floats are rejected at deploy" sentence teaches a rule the chain does
        // not enforce; this asserts the wording cannot drift back.
        const sys = buildSystemPrompt();

        assert.strictEqual(runGate('module.exports = function(xchain) { var r = 0.5; return String(r); };').ok,
            true, 'precondition: a decimal literal must still be gate-clean');
        assert.strictEqual(runGate('module.exports = function(xchain) { return String(Math.pow(2, 3)); };').ok,
            false, 'precondition: native Math.pow must still be gate-rejected');

        // The affirmative claim, in every phrasing the guidance has actually used.
        const FALSE_CLAIMS = [
            /FLOATS ARE REJECTED AT DEPLOY/i,
            /floats?\s+(?:are|is)\s+rejected/i,
            /(?:decimal|number|numeric)\s+literals?\s+(?:are|is)\s+rejected/i,
            /No floats anywhere/i
        ];
        for (const re of FALSE_CLAIMS)
            assert(!re.test(sys), 'guidance still claims deploy rejects floats: ' + re);

        // The genuinely blocking half must survive the split.
        assert(/Math\.sqrt\/pow\/log/.test(sys), 'the banned Math calls must still be named');
        assert(/decimal literal[\s\S]{0,120}WARNING|WARNING[\s\S]{0,120}decimal literal/i.test(sys),
            'the decimal-literal rule must be stated as a warning');
    });

});

describe('Toolkit authoring: prompt construction', function () {
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

    it('asks for the contract identity up front, in both modes', function () {
        // A missing `meta` is a deploy REJECTION, not a style note, so the ask is in
        // the user message before the brief rather than left to a repair round.
        for (const mode of ['describe', 'from-solidity']) {
            const u = buildUserPrompt({ mode, input: 'a vesting vault' });
            assert(/`meta`/.test(u), mode + ': the prompt must name the meta export');
            assert(/FIRST key/.test(u), mode + ': meta must be asked for as the first key');
            assert(/`name` \(1\.\.64 bytes\)/.test(u), mode + ': the name ask must carry its cap');
            assert(/one-line `description` \(1\.\.512 bytes\)/.test(u), mode + ': the description ask must carry its cap');
            assert(/REQUIRED/.test(u), mode + ': the ask must say the fields are required');
            assert(/rejected/.test(u), mode + ': the ask must say a deploy without them is rejected');
        }
    });

    it('pins the caller-supplied name and description when given', function () {
        const u = buildUserPrompt({ mode: 'describe', input: 'x', name: 'Escrow', description: 'Two-party escrow.' });
        assert(/Use exactly this name: "Escrow"/.test(u));
        assert(/Use exactly this description: "Two-party escrow\."/.test(u));
        assert(!/Choose a name/.test(u), 'nothing is left to the model once both are pinned');
        const half = buildUserPrompt({ mode: 'describe', input: 'x', name: 'Escrow' });
        assert(/Choose a one-line description/.test(half));
    });

    it('the hard rules teach the identity export', function () {
        const text = KNOWLEDGE.hardRules.join('\n');
        assert(/meta: \{ name, description, version \}/.test(text));
        assert(/contract\.meta = \{ \.\.\. \}/.test(text), 'the function-export form must be taught (spec R1)');
        const sys = buildSystemPrompt();
        assert(/1\.\.64 bytes/.test(sys) && /1\.\.512 bytes/.test(sys),
            'the rendered system prompt must carry the identity caps');
    });

});

describe('Toolkit authoring: prompt construction', function () {
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
