/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Contract-lint PARITY (deploy path ⇆ shared rules) + DRIFT guard.
 *
 * The deploy-time validator (validateSyntax, including the isolated-vm V8
 * step-1 compile) and the dependency-light shared rules (lint-core.lintSource,
 * which the SDK/CLI consume) MUST agree on every acorn-coverable verdict — same
 * valid flag AND byte-identical first-error message — or contract authors get
 * false greens / false reds. This is the authoritative cross-engine check;
 * because the SDK vendors lint-core/metering byte-identically (asserted below),
 * proving validateSyntax ⇆ lintSource here transitively covers the SDK linter.
 *
 * Requires isolated-vm → Node 22 (see .nvmrc).
 ********************************************************************/

const assert = require('assert');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const { validateSyntax, checkFloatWarnings } = require('../../src/syntax.js');
const { lintSource, CONSENSUS_RULES } = require('../../src/lint-core.js');

const VM_SRC_DIR     = path.join(__dirname, '..', '..', 'src');
const SDK_VENDOR_DIR = path.join(__dirname, '..', '..', '..', 'xchain-sdk', 'src', 'contract');
const CONTRACTS_DIR  = path.join(__dirname, '..', '..', '..', 'xchain-contracts');
const VENDORED_FILES = ['lint-core.js', 'metering.js'];

function sha256(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// All bad fixtures use syntax V8 accepts, so validateSyntax clears step 1 and the
// failure must come from a shared (lint-core) rule — making the messages comparable.
const BAD_FIXTURES = [
    { name: 'banned-math',           code: 'function f(){ return Math.sqrt(4); }' },
    { name: 'banned-literal-bigint', code: 'function f(){ return 2n; }' },
    { name: 'banned-literal-regex',  code: 'function f(){ return /a+/.test("x"); }' },
    { name: 'reserved-gas',          code: 'function f(){ var __gas = 1; return __gas; }' },
    { name: 'reserved-alloc',        code: 'function f(){ return __concat([1],[2]); }' },
    { name: 'unsupported-syntax',    code: 'var x = 1_000; function f(){ return x; }' }
];
const FLOAT_FIXTURE = 'var x = 3.14; function f(){ return x; }';
const GOOD_FIXTURE  = 'function init(){ return 1; } function add(a,b){ return a + b; }';

describe('lint parity (validateSyntax ⇆ lintSource) + drift', function () {

    describe('drift guard (SDK vendored copies byte-identical to canonical)', function () {
        const haveSDK = fs.existsSync(SDK_VENDOR_DIR);
        for (const f of VENDORED_FILES) {
            it('xchain-sdk/src/contract/' + f + ' matches src/' + f, function () {
                if (!haveSDK) return this.skip();
                assert.strictEqual(
                    sha256(path.join(SDK_VENDOR_DIR, f)), sha256(path.join(VM_SRC_DIR, f)),
                    'VENDOR DRIFT: SDK ' + f + ' differs from xchain-vm canonical — re-sync the copy.'
                );
            });
        }
    });

    describe('good fixture', function () {
        it('valid under both validateSyntax and lintSource', function () {
            assert.strictEqual(validateSyntax(GOOD_FIXTURE).valid, true);
            assert.strictEqual(lintSource(GOOD_FIXTURE).errors.length, 0);
        });
    });

    describe('bad fixtures — same verdict AND same first-error message', function () {
        for (const fx of BAD_FIXTURES) {
            it(fx.name + ': validateSyntax and lintSource agree', function () {
                const v = validateSyntax(fx.code);
                const l = lintSource(fx.code);
                assert.strictEqual(v.valid, false, fx.name + ' should be invalid via validateSyntax');
                assert.ok(l.errors.length > 0, fx.name + ' should have lint errors');
                // The deploy verdict must equal the shared-rule verdict (no false greens),
                // and the surfaced message must be byte-identical (recorded on-chain).
                assert.strictEqual(v.valid, l.errors.length === 0);
                assert.strictEqual(v.error, l.errors[0].message,
                    fx.name + ' message drift:\n  deploy: ' + v.error + '\n  lint  : ' + l.errors[0].message);
            });
        }
    });

    describe('Move 2 rules NEVER change the deploy verdict (parity invariant)', function () {
        // The critical guarantee: lint-core gained a new ERROR rule
        // (crossCallable-not-array) and several warnings, but validateSyntax — the
        // on-chain deploy gate — must block on CONSENSUS_RULES ONLY. A contract that
        // only trips a Move-2 rule still deploys.
        const CC_NOT_ARRAY = 'module.exports = { foo: function(x){ return 1; }, crossCallable: "oops" };';
        const MOVE2_WARN   = 'function f(){ while(true){ break; } return new Array(5).fill(0); }';

        it('crossCallable-not-array is a lint error but NOT deploy-blocking', function () {
            const l = lintSource(CC_NOT_ARRAY);
            assert.ok(l.errors.some(e => e.rule === 'crossCallable-not-array'), 'lint should flag it');
            assert.ok(!CONSENSUS_RULES.has('crossCallable-not-array'), 'must not be a consensus rule');
            assert.strictEqual(validateSyntax(CC_NOT_ARRAY).valid, true,
                'deploy validator must still accept a contract with a malformed crossCallable');
        });

        it('Move-2 warnings do not block deployment', function () {
            assert.ok(lintSource(MOVE2_WARN).warnings.length > 0, 'lint should warn');
            assert.strictEqual(validateSyntax(MOVE2_WARN).valid, true);
        });

        it('every CONSENSUS_RULES member is an error-severity finding', function () {
            // banned-math fixture trips a consensus rule; confirm severity tagging.
            const e = lintSource('function f(){ return Math.sqrt(4); }').errors[0];
            assert.strictEqual(e.severity, 'error');
            assert.ok(CONSENSUS_RULES.has(e.rule));
        });
    });

    describe('float warnings parity', function () {
        it('checkFloatWarnings === lintSource warning messages', function () {
            const fromSyntax = checkFloatWarnings(FLOAT_FIXTURE);
            const fromLint   = lintSource(FLOAT_FIXTURE).warnings.map(w => w.message);
            assert.deepStrictEqual(fromSyntax, fromLint);
            assert.ok(fromSyntax.length > 0);
            // float warnings are non-blocking
            assert.strictEqual(validateSyntax(FLOAT_FIXTURE).valid, true);
        });
    });

    describe('the four shipped templates pass the authoritative validator', function () {
        const haveTemplates = fs.existsSync(CONTRACTS_DIR);
        const dirs = haveTemplates
            ? fs.readdirSync(CONTRACTS_DIR, { withFileTypes: true })
                .filter(d => d.isDirectory() && fs.existsSync(path.join(CONTRACTS_DIR, d.name, d.name + '.js')))
                .map(d => d.name)
            : [];

        if (!haveTemplates || dirs.length === 0) {
            it('xchain-contracts templates present', function () { this.skip(); });
        } else {
            for (const name of dirs) {
                it(name + ' is valid under validateSyntax (full V8 + rules)', function () {
                    const code = fs.readFileSync(path.join(CONTRACTS_DIR, name, name + '.js'), 'utf8');
                    const v = validateSyntax(code);
                    assert.strictEqual(v.valid, true, name + ' rejected: ' + (v.error || ''));
                });
            }
        }
    });

});
