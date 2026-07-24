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
 * Toolkit: determinism gate + gas profiler. Pure/static (no isolated-vm),
 * so this suite runs on any OS/CPU, which is the whole point of the gate.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
// Require the module DIRECTLY (not the toolkit index) so this stays runnable
// on a host where isolated-vm cannot dlopen. gate.js pulls in only acorn.
const { runGate, estimateGas } = require('../../src/toolkit/gate.js');
// lint-core (not index.js) so this suite still runs where isolated-vm cannot
// dlopen; mirrors the boundary fixtures in test/unit/lint-cli.test.js.
const { MAX_CODE_SIZE } = require('../../src/lint-core.js');

// Pad a clean contract to exactly `bytes` UTF-8 bytes with a trailing line
// comment, so the padded source stays otherwise lint-clean.
function padTo(bytes) {
    const base = 'module.exports = function(xchain) { return xchain.state.get("a"); };\n';
    const need = bytes - Buffer.byteLength(base, 'utf8');
    return base + '//' + 'x'.repeat(Math.max(0, need - 2));
}

describe('Toolkit gate: determinism + gas', function() {

    it('passes a clean deterministic contract', function() {
        const g = runGate('module.exports = function(xchain) { xchain.state.set("a","1"); return xchain.state.get("a"); };');
        assert.strictEqual(g.ok, true);
        assert.strictEqual(g.errors.length, 0);
        assert(g.gas.suggested > 0);
    });

    // Deploy parity: code over MAX_CODE_SIZE is rejected on chain BEFORE the
    // syntax gate (deploy.js Buffer.byteLength check), so the gate must FAIL
    // it too even though `code-size` is deliberately not a CONSENSUS_RULE.
    it('blocks a contract one byte over MAX_CODE_SIZE (deploy parity)', function() {
        const g = runGate(padTo(MAX_CODE_SIZE + 1));
        assert.strictEqual(g.ok, false);
        assert(g.errors.some(e => e.rule === 'code-size'), 'code-size must be a blocking error');
        assert(!g.advisories.some(e => e.rule === 'code-size'), 'code-size must not be demoted to an advisory');
    });

    it('passes a contract at exactly MAX_CODE_SIZE (boundary parity)', function() {
        const g = runGate(padTo(MAX_CODE_SIZE));
        assert.strictEqual(g.ok, true);
        assert(!g.errors.some(e => e.rule === 'code-size'));
    });

    it('blocks a banned transcendental Math.* call (deploy parity)', function() {
        const g = runGate('module.exports = function(xchain) { return Math.pow(2, 3); };');
        assert.strictEqual(g.ok, false);
        assert(g.errors.some(e => e.rule === 'banned-math'), 'should flag banned-math');
    });

    it('blocks a RegExp literal (unmetered ReDoS)', function() {
        const g = runGate('module.exports = function(xchain) { return /a+b+/.test("x"); };');
        assert.strictEqual(g.ok, false);
        assert(g.errors.some(e => e.rule === 'banned-literal'));
    });

    it('blocks async surface (nondeterministic microtask timing)', function() {
        const g = runGate('module.exports = async function(xchain) { return 1; };');
        assert.strictEqual(g.ok, false);
        assert(g.errors.some(e => e.rule === 'banned-async'));
    });

    it('blocks a BigInt literal', function() {
        const g = runGate('module.exports = function(xchain) { return 10n + 1n; };');
        assert.strictEqual(g.ok, false);
        assert(g.errors.some(e => e.rule === 'banned-literal'));
    });

    it('rejects post-ES2020 syntax as unsupported', function() {
        // Numeric separators are ES2021; the acorn metering pass rejects them.
        const g = runGate('module.exports = function(xchain) { return 1_000; };');
        assert.strictEqual(g.ok, false);
        assert(g.errors.some(e => e.rule === 'unsupported-syntax'));
    });

    it('warns on a float literal without blocking', function() {
        const g = runGate('module.exports = function(xchain) { var r = 0.5; return String(r); };');
        assert.strictEqual(g.ok, true, 'float literal is a warning, not a deploy error');
        assert(g.warnings.length > 0, 'should surface a float warning');
    });

    it('surfaces non-string input as a blocking error', function() {
        const g = runGate(12345);
        assert.strictEqual(g.ok, false);
    });

    it('estimateGas scales with loops and emits', function() {
        const simple = estimateGas('module.exports = function(x){ return "1"; };');
        const heavy = estimateGas('module.exports = function(x){ for (var i=0;i<10;i++){ x.emit.send({}); } };');
        assert(heavy.suggested > simple.suggested, 'loop+emit should cost more');
        assert(typeof heavy.rationale === 'string');
    });
});
