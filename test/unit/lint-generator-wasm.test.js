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
 * Pkg 3 deploy-lint rules: banned-generator (29912bd8) + banned-wasm
 * (75190596, deploy half). Two-way, mirroring lint-hardening.test.js:
 *
 *   - the acorn-only detectors + lintSource always emit the error-severity
 *     finding (author-facing SDK/CLI parity), and both rules are CONSENSUS_RULES;
 *   - validateSyntax gates each rule on its own toggle (enforceBannedGenerator /
 *     enforceBannedWasm, mirroring enforceBannedAsync): toggle OFF reproduces the
 *     pre-flag-day verdict (accepted, byte-identical replay), toggle ON rejects.
 *
 * The lintSource half is pure acorn (runs in every lane); the validateSyntax
 * half needs isolated-vm (Node 22) and is guarded so it skips where the isolate
 * cannot load, exactly like lint-shared-rules.test.js.
 ********************************************************************/
'use strict';

const assert = require('assert');
const {
    lintSource,
    findBannedGenerator,
    findBannedWasm,
    CONSENSUS_RULES
} = require('../../src/lint-core.js');

// isolated-vm-dependent deploy validator (Node 22 only); guarded like the sibling
// suites so acorn-only assertions still run where the isolate can't dlopen.
let validateSyntax = null;
try { ({ validateSyntax } = require('../../src/syntax.js')); } catch (e) { /* no isolate */ }

// The blocking finding lintSource would surface for `code`, restricted to the
// consensus error set (the deploy validator's filter), first match only.
function firstConsensusError(code, opts) {
    const errs = lintSource(code, opts).errors.filter((e) => CONSENSUS_RULES.has(e.rule));
    return errs.length ? errs[0] : null;
}

describe('Pkg 3 deploy-lint: banned-generator + banned-wasm', function () {

    describe('CONSENSUS_RULES membership (deploy-blocking, error severity)', function () {
        it('both rules are consensus rules', function () {
            assert.ok(CONSENSUS_RULES.has('banned-generator'), 'banned-generator must be a consensus rule');
            assert.ok(CONSENSUS_RULES.has('banned-wasm'), 'banned-wasm must be a consensus rule');
        });
    });

    describe('banned-generator (29912bd8): detector + lintSource', function () {
        const cases = {
            'function declaration':      'function* g(){ yield 1; }',
            'function expression':       'var g = function*(){ yield 1; };',
            'object method shorthand':   'module.exports = { *step(x){ yield 1; } };',
            'class method':              'class C { *iter(){ yield 2; } }',
            'nested inside a function':  'function outer(){ function* inner(){ yield 3; } return inner; }',
            'async generator':           'async function* ag(){ yield 4; }'
        };
        for (const [label, code] of Object.entries(cases)) {
            it('flags a ' + label, function () {
                const hits = findBannedGenerator(code);
                assert.ok(hits.some((h) => h.kind === 'generator'),
                    label + ' should be flagged as a generator: ' + JSON.stringify(hits));
                const e = firstConsensusError(code);
                assert.ok(e, label + ' should produce a blocking error');
                // async generator trips banned-async first (async is emitted before
                // generator); every other case surfaces banned-generator directly.
                assert.ok(e.rule === 'banned-generator' || e.rule === 'banned-async',
                    label + ' unexpected rule: ' + e.rule);
                assert.strictEqual(
                    lintSource(code).errors.find((x) => x.rule === 'banned-generator').severity, 'error');
            });
        }

        it('flags a bare yield at depth (YieldExpression, not the identifier `yield`)', function () {
            const hits = findBannedGenerator('function* g(){ if (true) { while (true) { yield 9; } } }');
            assert.ok(hits.some((h) => h.kind === 'yield'), 'nested yield must be flagged: ' + JSON.stringify(hits));
        });

        it('does NOT flag a plain (non-generator) function or a sloppy-mode `yield` identifier', function () {
            assert.deepStrictEqual(findBannedGenerator('function f(){ return 1; }'), []);
            // In sloppy-mode script, `yield` is a legal identifier and never a YieldExpression.
            assert.deepStrictEqual(findBannedGenerator('var yield = 1; function f(){ return yield; }'), []);
        });

        it('reports kind + line', function () {
            assert.deepStrictEqual(findBannedGenerator('var x = 1;\nfunction* g(){ return 2; }'),
                [{ kind: 'generator', line: 2 }]);
        });

        it('carries the depth-leak rationale in the message', function () {
            const e = lintSource('function* g(){ return 1; }').errors.find((x) => x.rule === 'banned-generator');
            assert.ok(e.message.includes('banned generator surface: generator'), e.message);
            assert.ok(e.message.includes('__stackDepth') && e.message.includes('out_of_stack'), e.message);
        });
    });

    describe('banned-wasm (75190596 deploy half): detector + lintSource', function () {
        const flagged = {
            'bare global reference':     'module.exports = function(x){ return typeof WebAssembly; };',
            'member call on the global': 'module.exports = function(x){ return WebAssembly.instantiate(x); };',
            'globalThis.WebAssembly':    'module.exports = function(x){ return globalThis.WebAssembly; };',
            "globalThis['WebAssembly']": "module.exports = function(x){ return globalThis['WebAssembly']; };",
            'object shorthand value':    'module.exports = function(x){ return { WebAssembly }; };'
        };
        for (const [label, code] of Object.entries(flagged)) {
            it('flags ' + label, function () {
                const hits = findBannedWasm(code);
                assert.strictEqual(hits.length, 1, label + ' should yield exactly one hit: ' + JSON.stringify(hits));
                const e = firstConsensusError(code);
                assert.ok(e && e.rule === 'banned-wasm', label + ' should surface banned-wasm, got ' + (e && e.rule));
                assert.strictEqual(e.severity, 'error');
                assert.ok(e.message.includes('banned global: WebAssembly'), e.message);
                assert.ok(e.message.includes('unmetered native execution'), e.message);
            });
        }

        const clean = {
            'member property (obj.WebAssembly)': 'module.exports = function(x){ var o = { WebAssembly: 1 }; return o.WebAssembly; };',
            'non-computed object key':           'module.exports = function(x){ return { WebAssembly: 1 }; };',
            'shadowing parameter':               'module.exports = function(WebAssembly){ return WebAssembly; };',
            'shadowing local var':               'module.exports = function(x){ var WebAssembly = 5; return WebAssembly; };',
            'unrelated member on another object':'module.exports = function(x){ return x.WebAssembly; };'
        };
        for (const [label, code] of Object.entries(clean)) {
            it('does NOT flag ' + label + ' (false-positive guard)', function () {
                assert.deepStrictEqual(findBannedWasm(code), [], label + ' must not be flagged');
                assert.strictEqual(firstConsensusError(code), null, label + ' must not block deploy');
            });
        }

        it('reports the line', function () {
            assert.deepStrictEqual(findBannedWasm('var a = 1;\nvar b = WebAssembly;'), [{ line: 2 }]);
        });
    });

    describe('validateSyntax toggles (both sides; mirror enforceBannedAsync)', function () {
        const GEN  = 'module.exports = function(x){ return 1; }; function* g(){ yield 1; }';
        const WASM = 'module.exports = function(x){ return typeof WebAssembly; };';

        before(function () {
            if (!validateSyntax) this.skip(); // no isolated-vm (Mac / non-Node-22 lane)
        });

        it('generator: toggle OFF accepts (pre-flag-day byte-identical replay)', function () {
            assert.strictEqual(validateSyntax(GEN, { enforceBannedGenerator: false }).valid, true);
        });
        it('generator: toggle ON rejects with the banned-generator message', function () {
            const v = validateSyntax(GEN, { enforceBannedGenerator: true });
            assert.strictEqual(v.valid, false);
            assert.ok(v.error.includes('banned generator surface'), v.error);
        });
        it('generator: default (no opts) enforces, mirroring enforceBannedAsync', function () {
            assert.strictEqual(validateSyntax(GEN).valid, false);
        });

        it('wasm: toggle OFF accepts (pre-flag-day byte-identical replay)', function () {
            assert.strictEqual(validateSyntax(WASM, { enforceBannedWasm: false }).valid, true);
        });
        it('wasm: toggle ON rejects with the banned-wasm message', function () {
            const v = validateSyntax(WASM, { enforceBannedWasm: true });
            assert.strictEqual(v.valid, false);
            assert.ok(v.error.includes('banned global: WebAssembly'), v.error);
        });
        it('wasm: default (no opts) enforces, mirroring enforceBannedAsync', function () {
            assert.strictEqual(validateSyntax(WASM).valid, false);
        });

        it('the two toggles are INDEPENDENT: one off does not lift the other', function () {
            // A contract tripping BOTH rules, with only the generator toggle off, still
            // rejects on wasm (and vice-versa) - each gate is threaded separately.
            const BOTH = 'module.exports = function(x){ return typeof WebAssembly; }; function* g(){ yield 1; }';
            assert.strictEqual(validateSyntax(BOTH, { enforceBannedGenerator: false, enforceBannedWasm: true }).valid, false);
            assert.strictEqual(validateSyntax(BOTH, { enforceBannedGenerator: true, enforceBannedWasm: false }).valid, false);
            // Both off: accepted (both pre-flag-day).
            assert.strictEqual(validateSyntax(BOTH, { enforceBannedGenerator: false, enforceBannedWasm: false }).valid, true);
        });

        it('below-gate parity: a clean contract is accepted regardless of the toggles', function () {
            const OK = 'function init(){ return 1; } function add(a,b){ return a + b; }';
            for (const opts of [undefined, { enforceBannedGenerator: false, enforceBannedWasm: false },
                                 { enforceBannedGenerator: true, enforceBannedWasm: true }]) {
                assert.strictEqual(validateSyntax(OK, opts).valid, true);
            }
        });
    });
});
