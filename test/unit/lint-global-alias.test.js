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
 * LINT_GLOBAL_ALIAS epoch: the banned-async / banned-wasm global-object
 * spellings the identifier-precise rules used to walk past.
 *
 * Two spellings read the same global binding as a bare `Promise` /
 * `WebAssembly`:
 *   - sloppy-mode `this` (contract code is evaluated by the saved Function
 *     constructor in global scope, where top-level `this` IS globalThis);
 *   - the global object's own `globalThis` self-reference at any depth
 *     (globalThis.globalThis.Promise, this.globalThis.WebAssembly, ...).
 *
 * Three-way, mirroring lint-generator-wasm.test.js:
 *   - ON  (globalAlias true, the author-facing default): both spellings are
 *     error-severity CONSENSUS_RULES findings;
 *   - OFF (globalAlias false, below the activation height): the pre-epoch
 *     verdict is reproduced byte for byte, which is what makes a from-genesis
 *     replay of already-accepted contracts safe;
 *   - the epoch itself is a real, per-coin, currently-UNARMED height gate.
 *
 * The lintSource half is pure acorn (runs in every lane); the validateSyntax
 * half needs isolated-vm (Node 22) and is guarded so it skips where the isolate
 * cannot load, exactly like the sibling lint suites.
 ********************************************************************/
'use strict';

const assert = require('assert');
const {
    lintSource,
    findBannedAsync,
    findBannedWasm,
    CONSENSUS_RULES
} = require('../../src/lint-core.js');

// isolated-vm-dependent deploy validator (Node 22 only); guarded like the sibling
// suites so the acorn-only assertions still run where the isolate can't dlopen.
let validateSyntax = null;
try { ({ validateSyntax } = require('../../src/syntax.js')); } catch (e) { /* no isolate */ }

// The activation map + resolver also live behind isolated-vm (src/index.js pulls it
// in), so read them through the same guard.
let vm = null;
try { vm = require('../../src/index.js'); } catch (e) { /* no isolate */ }

// First deploy-blocking finding lintSource would surface for `code`, restricted to
// the consensus error set (the deploy validator's own filter).
function firstConsensusError(code, opts) {
    const errs = lintSource(code, opts).errors.filter((e) => CONSENSUS_RULES.has(e.rule));
    return errs.length ? errs[0] : null;
}

// Each case is source that reads the global binding through an alias the
// pre-epoch rules did not match.
const PROMISE_ALIASES = {
    'sloppy-mode this at top level':      'module.exports = function(){ return this.Promise; };',
    'sloppy-mode this, computed key':     'module.exports = function(){ return this["Promise"]; };',
    'globalThis self-reference':          'module.exports = function(){ return globalThis.globalThis.Promise; };',
    'globalThis self-reference, string':  'module.exports = function(){ return globalThis["globalThis"].Promise; };',
    'globalThis chain, three deep':       'module.exports = function(){ return globalThis.globalThis.globalThis.Promise; };',
    'this-rooted globalThis chain':       'module.exports = function(){ return this.globalThis.Promise; };'
};

const WASM_ALIASES = {
    'sloppy-mode this at top level':      'module.exports = function(){ return this.WebAssembly; };',
    'sloppy-mode this, computed key':     'module.exports = function(){ return this["WebAssembly"]; };',
    'globalThis self-reference':          'module.exports = function(){ return globalThis.globalThis.WebAssembly; };',
    'globalThis self-reference, string':  'module.exports = function(){ return globalThis["globalThis"].WebAssembly; };',
    'globalThis chain, three deep':       'module.exports = function(){ return globalThis.globalThis.globalThis.WebAssembly; };',
    'this-rooted globalThis chain':       'module.exports = function(){ return this.globalThis.WebAssembly; };'
};

describe('LINT_GLOBAL_ALIAS: aliased global reads in banned-async / banned-wasm', function () {

    describe('banned-async: alias spellings of the global Promise', function () {
        for (const [label, code] of Object.entries(PROMISE_ALIASES)) {
            it('flags ' + label + ' when the epoch is active', function () {
                const hits = findBannedAsync(code, true, true);
                assert.strictEqual(hits.length, 1, 'expected exactly one hit for: ' + code);
                assert.strictEqual(hits[0].kind, 'promise');
                const err = firstConsensusError(code);
                assert.ok(err, 'lintSource must surface a consensus error for: ' + code);
                assert.strictEqual(err.rule, 'banned-async');
            });

            it('accepts ' + label + ' below the activation (byte-identical replay)', function () {
                assert.deepStrictEqual(findBannedAsync(code, true, false), []);
                assert.strictEqual(firstConsensusError(code, { globalAlias: false }), null);
            });
        }
    });

    describe('banned-wasm: alias spellings of the global WebAssembly', function () {
        for (const [label, code] of Object.entries(WASM_ALIASES)) {
            it('flags ' + label + ' when the epoch is active', function () {
                const hits = findBannedWasm(code, true);
                assert.strictEqual(hits.length, 1, 'expected exactly one hit for: ' + code);
                const err = firstConsensusError(code);
                assert.ok(err, 'lintSource must surface a consensus error for: ' + code);
                assert.strictEqual(err.rule, 'banned-wasm');
            });

            it('accepts ' + label + ' below the activation (byte-identical replay)', function () {
                assert.deepStrictEqual(findBannedWasm(code, false), []);
                assert.strictEqual(firstConsensusError(code, { globalAlias: false }), null);
            });
        }
    });

    describe('pre-epoch spellings are unchanged in BOTH modes', function () {
        // These already blocked before the epoch, so the gate must not accidentally
        // make them conditional: that would UNDO a live consensus rule below the
        // activation height and change settled verdicts in the other direction.
        const alwaysBlocked = {
            'bare Promise identifier':        ['banned-async', 'module.exports = function(){ return Promise; };'],
            'single-hop globalThis.Promise':  ['banned-async', 'module.exports = function(){ return globalThis.Promise; };'],
            'globalThis["Promise"]':          ['banned-async', 'module.exports = function(){ return globalThis["Promise"]; };'],
            'bare WebAssembly identifier':    ['banned-wasm',  'module.exports = function(){ return WebAssembly; };'],
            'single-hop globalThis.WebAssembly': ['banned-wasm', 'module.exports = function(){ return globalThis.WebAssembly; };']
        };
        for (const [label, [rule, code]] of Object.entries(alwaysBlocked)) {
            it('still blocks ' + label + ' with the epoch off', function () {
                const err = firstConsensusError(code, { globalAlias: false });
                assert.ok(err, 'expected a consensus error for: ' + code);
                assert.strictEqual(err.rule, rule);
            });
            it('still blocks ' + label + ' with the epoch on', function () {
                const err = firstConsensusError(code, { globalAlias: true });
                assert.ok(err, 'expected a consensus error for: ' + code);
                assert.strictEqual(err.rule, rule);
            });
        }
    });

    describe('clean contracts stay clean under the epoch', function () {
        const clean = {
            'unrelated this member read':  'module.exports = function(){ return this.total; };',
            'unrelated globalThis chain':  'module.exports = function(){ return globalThis.globalThis.Number; };',
            'variable-computed this key':  'module.exports = function(k){ return this[k]; };',
            'local Promise shadow':        'module.exports = function(Promise){ return Promise; };',
            'member property named Promise': 'module.exports = function(o){ return o.Promise; };'
        };
        for (const [label, code] of Object.entries(clean)) {
            it('accepts ' + label, function () {
                assert.strictEqual(firstConsensusError(code, { globalAlias: true }), null,
                    'unexpected consensus error for: ' + code);
            });
        }
    });

    describe('lintSource default is author-facing ON', function () {
        it('defaults globalAlias to true (SDK linter / CLI see the tighter rule)', function () {
            const err = firstConsensusError('module.exports = function(){ return this.WebAssembly; };');
            assert.ok(err, 'the default must flag the alias spelling');
            assert.strictEqual(err.rule, 'banned-wasm');
        });
    });

    describe('validateSyntax gate (isolated-vm; Node 22)', function () {
        before(function () {
            if (!validateSyntax) this.skip();
        });

        it('rejects the alias spelling with enforceLintGlobalAlias on', function () {
            const r = validateSyntax('module.exports = function(){ return this.WebAssembly; };',
                { enforceLintGlobalAlias: true });
            assert.strictEqual(r.valid, false);
            assert.ok(/WebAssembly/.test(r.error), 'unexpected error: ' + r.error);
        });

        it('accepts the alias spelling with enforceLintGlobalAlias off', function () {
            const r = validateSyntax('module.exports = function(){ return this.WebAssembly; };',
                { enforceLintGlobalAlias: false });
            assert.strictEqual(r.valid, true, 'pre-activation verdict must stay accepted: ' + r.error);
        });

        it('the Promise alias is gated the same way', function () {
            const code = 'module.exports = function(){ return globalThis.globalThis.Promise; };';
            assert.strictEqual(validateSyntax(code, { enforceLintGlobalAlias: false }).valid, true);
            assert.strictEqual(validateSyntax(code, { enforceLintGlobalAlias: true }).valid, false);
        });

        it('turning the epoch off does not disable the pre-epoch spellings', function () {
            const r = validateSyntax('module.exports = function(){ return globalThis.WebAssembly; };',
                { enforceLintGlobalAlias: false });
            assert.strictEqual(r.valid, false, 'the single-hop global read must still block');
        });
    });

    describe('LINT_GLOBAL_ALIAS_ACTIVATION (per-coin height epoch)', function () {
        before(function () {
            if (!vm) this.skip();
        });

        it('exposes a per-coin mainnet map that is still UNARMED', function () {
            const map = vm.LINT_GLOBAL_ALIAS_ACTIVATION;
            assert.ok(map, 'the epoch map must be exported');
            // null is the explicit unarmed sentinel; a number here means the operator
            // ratified heights and the indexer twin MUST carry the same ones.
            assert.strictEqual(map['BTC:mainnet'], null);
            assert.strictEqual(map['LTC:mainnet'], null);
            assert.strictEqual(map['DOGE:mainnet'], null);
        });

        it('is frozen (a mutable consensus map is a fork surface)', function () {
            assert.ok(Object.isFrozen(vm.LINT_GLOBAL_ALIAS_ACTIVATION));
        });

        it('resolves inactive on mainnet at every height while unarmed', function () {
            assert.strictEqual(vm.isLintGlobalAliasActive('mainnet', 'BTC', 0), false);
            assert.strictEqual(vm.isLintGlobalAliasActive('mainnet', 'BTC', 999999999), false);
            assert.strictEqual(vm.isLintGlobalAliasActive('mainnet', 'DOGE', 999999999), false);
        });

        it('is genesis-active on testnet and regtest', function () {
            assert.strictEqual(vm.isLintGlobalAliasActive('testnet', 'BTC', 0), true);
            assert.strictEqual(vm.isLintGlobalAliasActive('regtest', 'LTC', 0), true);
        });

        it('resolves inactive for an unknown network, coin or height', function () {
            assert.strictEqual(vm.isLintGlobalAliasActive('devnet', 'BTC', 100), false);
            assert.strictEqual(vm.isLintGlobalAliasActive('mainnet', null, 100), false);
            assert.strictEqual(vm.isLintGlobalAliasActive('mainnet', 'BTC', NaN), false);
        });

        it('does NOT ride VM_LINT_HARDENING, which is already open', function () {
            // The whole reason the epoch exists: reusing the open block-time gate would
            // apply the tightened rules to contracts the chain already accepted.
            assert.strictEqual(vm.isLintHardeningActive('mainnet', vm.VM_LINT_HARDENING_GATE_BLOCK_TIME), true);
            assert.strictEqual(vm.isLintGlobalAliasActive('mainnet', 'BTC', 961000), false);
        });
    });
});
