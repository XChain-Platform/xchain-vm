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
 * lint-core shared-rule coverage (2668 / 2669 / 2670)
 *
 * lint-core.js declares itself the shared source of truth for every
 * acorn-coverable contract rule, and the SDK vendors it byte-identically. Two
 * rules were missing from it and enforced (or not) elsewhere:
 *
 *   2668  the 64 KiB deploy cap lived only in bin/lint.js, so the SDK
 *         pre-flight returned clean for a contract the indexer rejects with
 *         `invalid: CODE_ENCODING (exceeds max size)`.
 *   2669  the sandbox hard-neuters ten prototype methods (regex-coercing and
 *         locale/ICU); none had a lint rule, so they deployed green and threw
 *         TypeError on first execution.
 *   2670  the reserved-identifier comment named 5 of the 12 banned names and
 *         only one of the two hazard classes.
 *
 * The load-bearing invariant for all three: NEITHER new rule is a
 * CONSENSUS_RULE, so validateSyntax (the on-chain deploy gate) blocks on
 * exactly the same set it did before and the Move-1 deploy-parity promise is
 * unchanged. That is asserted directly below.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const path   = require('path');
const { execFileSync } = require('child_process');
const os     = require('os');
const fs     = require('fs');

const {
    lintSource, CONSENSUS_RULES, codeSizeBytes, MAX_CODE_SIZE,
    findBannedProtoMethods, STRIPPED_PROTO_METHOD_NAMES
} = require('../../src/lint-core.js');
const { RESERVED_IDENTIFIERS } = require('../../src/metering.js');
const PROTO = require('../../src/protocol/constants.js');

// isolated-vm-dependent modules (Node 22 only); preflight.test.js is the loud guard.
let XChainVM = null, stripGlobalsMod = null;
try { XChainVM = require('../../src/index.js'); } catch (e) { /* no isolate */ }
try { stripGlobalsMod = require('../../src/sandbox.js'); } catch (e) { /* no isolate */ }

const VALID = 'function init(){ return 1; }';
const rules = (findings) => findings.map((f) => f.rule);

describe('lint-core shared rules (2668 / 2669 / 2670)', function () {

    describe('2668: code-size is enforced by lintSource, not only by the CLI', function () {
        // A body of ASCII filler that parses; padded with a comment so the size
        // is the only thing wrong with it.
        const sized = (bytes) => VALID + '\n//' + 'x'.repeat(Math.max(0, bytes - VALID.length - 3));

        it('a contract at exactly MAX_CODE_SIZE lints clean', function () {
            const code = sized(MAX_CODE_SIZE);
            assert.strictEqual(codeSizeBytes(code), MAX_CODE_SIZE);
            assert.ok(!rules(lintSource(code).errors).includes('code-size'));
        });

        it('a contract one byte over MAX_CODE_SIZE is a code-size error', function () {
            const code = sized(MAX_CODE_SIZE + 1);
            assert.strictEqual(codeSizeBytes(code), MAX_CODE_SIZE + 1);
            const errs = lintSource(code).errors;
            assert.strictEqual(errs[0].rule, 'code-size', 'size must be reported FIRST (the chain checks it before syntax)');
            assert.strictEqual(errs[0].severity, 'error');
            assert.strictEqual(errs[0].message, 'code size exceeds limit (' + MAX_CODE_SIZE + ' bytes)',
                'message must stay byte-identical to the historical CLI text');
        });

        it('code-size is NOT a consensus rule: the deploy verdict is unchanged', function () {
            assert.ok(!CONSENSUS_RULES.has('code-size'));
            if (!XChainVM) return this.skip();
            const { validateSyntax } = require('../../src/syntax.js');
            // validateSyntax filters to CONSENSUS_RULES, so an oversized but
            // otherwise-clean contract must still pass the deploy gate exactly
            // as it did before the rule existed. The chain rejects it earlier,
            // in the indexer, on CODE_ENCODING.
            assert.strictEqual(validateSyntax(sized(MAX_CODE_SIZE + 1)).valid, true);
        });

        it('codeSizeBytes matches Buffer.byteLength utf8 (the on-chain measurement)', function () {
            const cases = ['', 'abc', 'é', '😀', '\ud800', 'a\udc00b', '日本語', VALID];
            for (const s of cases)
                assert.strictEqual(codeSizeBytes(s), Buffer.byteLength(s, 'utf8'), JSON.stringify(s));
        });

        it('MAX_CODE_SIZE stays equal to the vendored protocol constant', function () {
            assert.strictEqual(MAX_CODE_SIZE, PROTO.MAX_CODE_SIZE);
            if (XChainVM) assert.strictEqual(MAX_CODE_SIZE, XChainVM.MAX_CODE_SIZE);
        });

        it('the CLI still reports code-size (single-sourced, not dropped)', function () {
            if (!XChainVM) return this.skip();
            const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xclint-')), 'big.js');
            fs.writeFileSync(tmp, sized(MAX_CODE_SIZE + 1));
            let out;
            try {
                execFileSync(process.execPath, [path.join(__dirname, '..', '..', 'bin', 'lint.js'), '--json', tmp],
                    { encoding: 'utf8' });
                assert.fail('CLI must exit non-zero on an oversized contract');
            } catch (e) {
                out = e.stdout || '';
                assert.strictEqual(e.status, 1, 'exit 1 expected, got ' + e.status);
            }
            const report = JSON.parse(out);
            const errs = report.files ? report.files[0].errors : report[0].errors;
            assert.strictEqual(errs[0].rule, 'code-size', out);
        });
    });

    describe('2669: sandbox-neutered prototype methods are linted', function () {
        it('flags the regex-coercing methods as warnings, not errors', function () {
            const r = lintSource(`function f(s){ return s.match("(a+)+$"); }`);
            assert.ok(!rules(r.errors).includes('banned-proto-method'), 'must never be an error (name-only match)');
            const w = r.warnings.filter((x) => x.rule === 'banned-proto-method');
            assert.strictEqual(w.length, 1);
            assert.match(w[0].message, /neutered method: \.match\(\)/);
            assert.match(w[0].message, /%RegExp%/);
            assert.strictEqual(w[0].severity, 'warning');
        });

        it('flags the locale/ICU methods with the ICU rationale', function () {
            const w = lintSource(`function f(a,b){ return a.localeCompare(b); }`)
                .warnings.filter((x) => x.rule === 'banned-proto-method');
            assert.strictEqual(w.length, 1);
            assert.match(w[0].message, /ICU/);
        });

        it('resolves the computed-string form too', function () {
            const w = lintSource(`function f(s){ return s['search']("x"); }`)
                .warnings.filter((x) => x.rule === 'banned-proto-method');
            assert.strictEqual(w.length, 1);
        });

        it('covers every neutered method name', function () {
            for (const name of STRIPPED_PROTO_METHOD_NAMES) {
                const hits = findBannedProtoMethods(`function f(a,b){ return a.${name}(b); }`);
                assert.strictEqual(hits.length, 1, name + ' not detected');
                assert.strictEqual(hits[0].name, name);
            }
        });

        it('banned-proto-method is NOT a consensus rule and never blocks deploy', function () {
            assert.ok(!CONSENSUS_RULES.has('banned-proto-method'));
            if (!XChainVM) return this.skip();
            const { validateSyntax } = require('../../src/syntax.js');
            assert.strictEqual(validateSyntax(`function f(s){ return s.match("x"); }`).valid, true);
        });

        it('a clean contract produces no banned-proto-method noise', function () {
            const r = lintSource(VALID);
            assert.ok(!rules(r.warnings).includes('banned-proto-method'));
        });

        it('the mirrored name list stays equal to sandbox.js STRIPPED_PROTO_METHODS', function () {
            if (!stripGlobalsMod || !stripGlobalsMod.STRIPPED_PROTO_METHODS) return this.skip();
            const fromSandbox = Array.from(new Set(
                stripGlobalsMod.STRIPPED_PROTO_METHODS.map((e) => e.method)
            )).sort();
            assert.deepStrictEqual(STRIPPED_PROTO_METHOD_NAMES.slice().sort(), fromSandbox,
                'lint-core mirror drifted from the sandbox neuter list');
        });
    });

    describe('2670: the reserved-identifier rule covers all of RESERVED_IDENTIFIERS', function () {
        it('has twelve names spanning both hazard classes', function () {
            assert.ok(RESERVED_IDENTIFIERS.length >= 12, 'list shrank: ' + RESERVED_IDENTIFIERS.join(','));
            for (const n of ['__gas', '__concat', '__setconcat', '__setconcatL', '__tmpl', '__tmpltag',
                '__tmpltagm', '__arrspread', '__objspread', '__objspreadmeter',
                '__depth_enter', '__depth_exit'])
                assert.ok(RESERVED_IDENTIFIERS.includes(n), 'missing ' + n);
        });

        it('every reserved name is rejected by lintSource', function () {
            for (const n of RESERVED_IDENTIFIERS) {
                const errs = lintSource(`function f(){ var ${n} = 1; return ${n}; }`).errors;
                assert.ok(rules(errs).includes('reserved-identifier'), n + ' not rejected');
            }
        });
    });
});
