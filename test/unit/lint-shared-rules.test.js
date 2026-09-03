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
    findBannedProtoMethods, STRIPPED_PROTO_METHOD_NAMES,
    findBannedStrippedGlobals, STRIPPED_GLOBAL_NAMES_MIRROR, ADVISORY_STRIPPED_GLOBALS
} = require('../../src/lint-core.js');
const { RESERVED_IDENTIFIERS } = require('../../src/metering.js');
const SHARED = require('../../src/stripped-globals.js');
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

    // The sandbox deletes 24 globals so every validator computes the same result,
    // and the shipped templates document that strip as their reason to exist
    // ("a contract CANNOT fetch a URL directly ..."). Until this rule, exactly two
    // of the 24 had any lint at all (WebAssembly, Promise), so a contract reading
    // Date.now() / fetch(url) / structuredClone(v) lint-ed clean, deployed, and
    // then threw ReferenceError on its first execution. Author-facing warning
    // only: the sandbox strip is the enforcement, and moving the deploy verdict
    // would need its own activation epoch.
    describe('sandbox-stripped globals are linted (banned-stripped-global)', function () {
        it('flags a bare stripped global as a warning, never an error', function () {
            const r = lintSource('function f(){ return Date.now(); }');
            assert.ok(!rules(r.errors).includes('banned-stripped-global'),
                'must never be an error: the deploy verdict may not move');
            const w = r.warnings.filter((x) => x.rule === 'banned-stripped-global');
            assert.strictEqual(w.length, 1);
            assert.strictEqual(w[0].severity, 'warning');
            assert.match(w[0].message, /stripped global: Date at line 1/);
            assert.match(w[0].message, /ReferenceError/);
            assert.match(w[0].message, /xchain\./, 'must point the author at the gateway');
        });

        it('covers every advisory stripped-global name', function () {
            for (const name of ADVISORY_STRIPPED_GLOBALS) {
                const hits = findBannedStrippedGlobals(`function f(){ return ${name}; }`);
                assert.strictEqual(hits.length, 1, name + ' not detected');
                assert.strictEqual(hits[0].name, name);
            }
        });

        it('resolves the global-object-qualified spellings', function () {
            for (const src of ['function f(){ return globalThis.fetch(u); }',
                'function f(){ return globalThis["setTimeout"](g); }',
                'function f(){ return this.performance.now(); }']) {
                const w = lintSource(src).warnings.filter((x) => x.rule === 'banned-stripped-global');
                assert.strictEqual(w.length, 1, 'missed: ' + src);
            }
        });

        it('is identifier-precise: a contract\'s own binding is never flagged', function () {
            for (const src of ['function f(obj){ return obj.Date; }',
                'function f(){ return { Date: 1 }; }',
                'function f(){ var Date = 1; return Date; }',
                'function f(Date){ return Date; }',
                'function f(){ function performance(){ return 1; } return performance(); }']) {
                const w = lintSource(src).warnings.filter((x) => x.rule === 'banned-stripped-global');
                assert.strictEqual(w.length, 0, 'false positive on: ' + src +
                    ' -> ' + JSON.stringify(w.map((x) => x.message)));
            }
            // ...but the shorthand { Date } READS the global, so it is flagged.
            const sh = lintSource('function f(){ return { Date }; }')
                .warnings.filter((x) => x.rule === 'banned-stripped-global');
            assert.strictEqual(sh.length, 1, 'shorthand { Date } reads the global and must be flagged');
        });

        it('does not double-report the two names that already carry an error rule', function () {
            // Promise and WebAssembly are the ONLY consensus-GATED entries in the
            // strip set (kept in place below their flag days for replay), so the
            // "the sandbox deletes it" wording is not unconditionally true for
            // them, and banned-async / banned-wasm already fire.
            for (const [src, errRule] of [
                ['function f(){ return Promise.resolve(1); }', 'banned-async'],
                ['function f(){ return WebAssembly.compile(x); }', 'banned-wasm']
            ]) {
                const r = lintSource(src);
                assert.ok(rules(r.errors).includes(errRule), src + ' lost its ' + errRule);
                assert.ok(!rules(r.warnings).includes('banned-stripped-global'),
                    src + ' must not also warn');
            }
        });

        it('banned-stripped-global is NOT a consensus rule and never blocks deploy', function () {
            assert.ok(!CONSENSUS_RULES.has('banned-stripped-global'));
            if (!XChainVM) return this.skip();
            const { validateSyntax } = require('../../src/syntax.js');
            assert.strictEqual(validateSyntax('function f(){ return Date.now(); }').valid, true,
                'the on-chain deploy verdict must be exactly what it was before this rule');
        });

        it('a clean contract produces no banned-stripped-global noise', function () {
            assert.ok(!rules(lintSource(VALID).warnings).includes('banned-stripped-global'));
        });

        // ONE definition of the strip set lives in src/stripped-globals.js. A
        // hand-copied literal in sandbox.js, lint-core.js or toolkit/authoring.js
        // could only be held equal by parity tests that SKIP wherever isolated-vm
        // will not load, i.e. exactly where the copies are consumed (the SDK, a
        // browser, a non-Linux dev box). These guards run WITHOUT the isolate, so
        // they cannot green-by-skip.
        it('the linter reads the one shared definition, not a copy of it', function () {
            assert.strictEqual(STRIPPED_GLOBAL_NAMES_MIRROR, SHARED.STRIPPED_GLOBAL_NAMES,
                'lint-core must expose the very array stripped-globals.js froze; a distinct ' +
                'array means a second literal crept back in and can drift again');
            assert.strictEqual(ADVISORY_STRIPPED_GLOBALS, SHARED.ADVISORY_STRIPPED_GLOBAL_NAMES);
            assert.ok(Object.isFrozen(STRIPPED_GLOBAL_NAMES_MIRROR), 'the shared set must be frozen');
        });

        it('no consumer re-declares the strip set as its own literal', function () {
            // A require can always be reverted to a paste. Every consumer source is
            // read here and must mention no name-bearing array literal of its own:
            // 'structuredClone' is the tell, since it appears in the strip set and
            // nowhere else in these files.
            const CONSUMERS = [
                path.join(__dirname, '..', '..', 'src', 'sandbox.js'),
                path.join(__dirname, '..', '..', 'src', 'lint-core.js'),
                path.join(__dirname, '..', '..', 'src', 'toolkit', 'authoring.js')
            ];
            for (const file of CONSUMERS) {
                const code = fs.readFileSync(file, 'utf8');
                // Strip comments so the prose that EXPLAINS the set does not count.
                const bare = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
                assert.ok(!/['"]structuredClone['"]/.test(bare),
                    path.basename(file) + ' names a stripped global in its own code; the set has ' +
                    'ONE home (src/stripped-globals.js) and must be required, never re-listed');
                assert.ok(/require\((['"])\.{1,2}\/stripped-globals\.js\1\)/.test(bare),
                    path.basename(file) + ' must require the shared strip-set module');
            }
        });

        it('the shared set still equals what the sandbox actually deletes', function () {
            // Defence in depth for the require above: sandbox.js interpolates the
            // names into the real strip script, so this proves the one definition is
            // the set the isolate acts on. Skips without the binding, which is why
            // it is not the only guard.
            if (!stripGlobalsMod || !stripGlobalsMod.STRIPPED_GLOBAL_NAMES) return this.skip();
            assert.deepStrictEqual(
                STRIPPED_GLOBAL_NAMES_MIRROR.slice().sort(),
                [...stripGlobalsMod.STRIPPED_GLOBAL_NAMES].sort(),
                'the linter and the sandbox disagree on the strip set; a name missing here ' +
                'is a global that lints clean, deploys, and throws on first execution');
        });

        it('the advisory set is the full set minus exactly the two flag-day-gated names', function () {
            assert.deepStrictEqual(
                STRIPPED_GLOBAL_NAMES_MIRROR.filter((n) => ADVISORY_STRIPPED_GLOBALS.indexOf(n) === -1),
                ['Promise', 'WebAssembly'],
                'only the consensus-gated entries may be held out of the advisory set');
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
