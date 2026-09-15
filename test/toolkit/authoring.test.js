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
    KNOWLEDGE
} = require('../../src/toolkit/authoring.js');
const { runGate } = require('../../src/toolkit/gate.js');
const SHARED = require('../../src/stripped_globals.js');
// The two authorities behind the taught reserved-identifier list. Both are
// acorn-only, so they load wherever this suite does.
const meteringMod = require('../../src/metering.js');
const lintCoreMod = require('../../src/lint_core.js');

// sandbox.js requires isolated-vm at the top level, so it is loaded defensively
// (same convention as test/unit/lint-shared-rules.test.js): the strip-set parity
// guard below runs for real on Node 22 / Linux and skips where the binding
// cannot dlopen. Everything else in this suite stays isolate-free.
let sandboxMod = null;
try { sandboxMod = require('../../src/sandbox.js'); } catch (e) { /* no isolate */ }

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
        // harness runs on any OS), so it requires src/stripped_globals.js, the same
        // module sandbox.js and lint_core.js require, and this identity check runs
        // without the binding rather than skipping wherever isolated-vm will not load.
        assert.strictEqual(KNOWLEDGE.strippedGlobals, SHARED.STRIPPED_GLOBAL_NAMES,
            'the authoring knowledge base must teach the very array stripped_globals.js ' +
            'froze; a distinct array means a second literal crept back in');
        assert.strictEqual(KNOWLEDGE.strippedGlobals,
            require('../../src/lint_core.js').STRIPPED_GLOBAL_NAMES,
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

});

describe('Toolkit authoring: knowledge base', function () {
    it('the taught reserved identifiers are the set the deploy gate rejects', function () {
        // Pins the taught set against both gate authorities rather than a hand-typed
        // sketch, which drifts in both directions: missing names the gate rejects and
        // banning ordinary ones it allows. Both authorities are acorn-only, so this
        // runs without the isolate binding.
        assert.deepStrictEqual(
            KNOWLEDGE.reservedIdentifiers.slice().sort(),
            meteringMod.RESERVED_IDENTIFIERS
                .concat(lintCoreMod.RESERVED_CONTROL_BINDINGS).sort(),
            'the authoring prompt teaches a different reserved set than the deploy gate ' +
            'enforces; a name missing here is one a model will happily emit and the ' +
            'reserved-identifier rule then rejects on deploy');
    });

    it('every taught reserved identifier reaches the rendered hard rules', function () {
        // Same defence as the stripped-global renderer above: an edit that dropped
        // the interpolation would still satisfy the equality test.
        const text = KNOWLEDGE.hardRules.join('\n');
        for (const name of KNOWLEDGE.reservedIdentifiers) {
            assert.ok(new RegExp('\\b' + name + '\\b').test(text),
                'the hard rules never name the reserved identifier ' + name);
        }
    });

    it('KNOWLEDGE.contractShape is itself a gate-clean contract', function () {
        // If our own teaching example would be rejected on deploy, the prompt is lying.
        const g = runGate(KNOWLEDGE.contractShape);
        assert.strictEqual(g.ok, true, 'contractShape must pass the deploy gate: ' + JSON.stringify(g.errors));
    });
});
