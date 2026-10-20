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
 * XChain VM: Preflight
 *
 * The rest of the suite guards isolate-dependent tests behind
 * `(XChainVM ? describe : describe.skip)` so a single focused run
 * doesn't crash-spam when the native engine can't load. The cost of
 * that ergonomics choice is a FALSE GREEN: if isolated-vm fails to
 * dlopen (e.g. the compiled binary's V8 ABI doesn't match the running
 * Node), every security / fuzz / chaos / e2e file silently becomes
 * `pending` and the run still reports success.
 *
 * This preflight is the antidote. It does a HARD require + a trivial
 * execute with NO try/catch. If the engine can't load, this fails
 * loudly and turns the whole run red. It is wired into `npm test` and
 * picked up by the `test/**` glob in `test:all`, so the primary CI
 * gates cannot pass while the sandbox is untested.
 *
 * If this fails with ERR_DLOPEN_FAILED + "undefined symbol", the
 * isolated-vm binary was built against a different Node/V8 than the
 * one running the tests. Fix: `npm rebuild isolated-vm --build-from-source`
 * on the Node version pinned in .nvmrc (matches the prod node:22 image).
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const fs = require('fs');
const path = require('path');

describe('Preflight: sandbox engine must load', function() {
    it('loads the XChainVM engine (isolated-vm native binding)', function() {
        // No try/catch on purpose: a load failure MUST fail the suite,
        // never skip it.
        const XChainVM = require('../src/index.js');
        assert.strictEqual(typeof XChainVM, 'function',
            'src/index.js should export the XChainVM constructor');
    });

    it('executes a trivial contract end-to-end inside the isolate', async function() {
        this.timeout(30000);
        const XChainVM = require('../src/index.js');
        const vm = new XChainVM({
            gasSchedule: {
                VM_COMPUTATION: 1, VM_STATE_READ: 100, VM_STATE_WRITE: 200,
                VM_STATE_DELETE: 100, VM_ORACLE_READ: 100, VM_CROSSCHAIN_READ: 100,
                VM_ATTEST_REQUEST: 5000, VM_EMISSION: 500, VM_XCALL_REQUEST: 2000, VM_XCALL_CALLBACK: 20000,
            },
            gasCeiling: 1000000,
            limits: {
                maxCpuTimeMs: 5000, maxMemory: 8, maxEmissions: 50,
                maxStateKeys: 10000, maxStateValueSize: 65536, maxCodeSize: 65536,
            },
        });
        vm.beginBlock();
        const result = await vm.execute({
            code:            'module.exports = function(xchain) { return "ok"; };',
            state:           {},
            method:          'default',
            params:          [],
            caller:          'preflight_addr',
            contractAddress: 'C:BTC:PREFLIGHT',
            blockContext:    { height: 1, timestamp: 1700000000, hash: 'preflight_hash' },
        });
        vm.endBlock();
        assert.strictEqual(result.success, true,
            'trivial contract should execute successfully; error: ' + result.error);
        assert.strictEqual(JSON.parse(result.returnValue), 'ok');
    });
});

const {
    SUITE_ROOT,
    KNOWN_EMPTY_SUITES,
    registersNoTests,
    assertSuiteRegistersTest,
    suiteFiles,
    assertWalkFindsUntrackedNestedSuite,
} = require('./helpers/suite_registration.js');

describe('Preflight: every suite file registers a test', function() {
    this.timeout(30000);

    it('finds no new suite file that registers zero tests', function() {
        const files = suiteFiles();
        for (const file of KNOWN_EMPTY_SUITES) {
            assert.ok(files.includes(file), file + ' is no longer a tracked suite');
            assert.ok(registersNoTests(fs.readFileSync(path.join(SUITE_ROOT, file), 'utf8')),
                file + ' now registers a test; remove it from KNOWN_EMPTY_SUITES');
        }
        for (const file of files) {
            if (KNOWN_EMPTY_SUITES.has(file)) continue;
            assertSuiteRegistersTest(fs.readFileSync(path.join(SUITE_ROOT, file), 'utf8'), file);
        }
    });

    it('discovers an untracked nested suite without including non-suite helpers', function() {
        assertWalkFindsUntrackedNestedSuite();
    });

    it('fails an empty file, and passes a file with one real invoked test call', function() {
        assert.throws(() => assertSuiteRegistersTest('', 'empty.test.js'), /registers zero tests/);
        assert.throws(() => assertSuiteRegistersTest('// it("never runs", function() {});\n', 'comment.test.js'), /registers zero tests/);
        assert.doesNotThrow(() => assertSuiteRegistersTest('it("runs", function() {});\n', 'live.test.js'));
    });

    it('fails a statically-true return that precedes the test call', function() {
        assert.throws(() => assertSuiteRegistersTest('function run() {\n  if (true) return;\n  it("dead", function() {});\n}\nrun();\n', 'early-return.test.js'), /registers zero tests/);
        assert.ok(!registersNoTests('function run(x) {\n  if (x) return;\n  it("lives", function() {});\n}\nrun(true);\n'));
    });

    it('fails a test call left unreachable after an unconditional return', function() {
        assert.throws(() => assertSuiteRegistersTest('function run() {\n  return;\n  it("dead", function() {});\n}\nrun();\n', 'unreachable.test.js'), /registers zero tests/);
        assert.ok(!registersNoTests('(function () {\n  it("lives", function() {});\n})();\n'));
    });

    it('fails a callback argument that is declared but never invoked', function() {
        assert.throws(() => assertSuiteRegistersTest('function neverInvoked(cb) {}\nneverInvoked(function() {\n  it("dead", function() {});\n});\n', 'callback.test.js'), /registers zero tests/);
        assert.ok(!registersNoTests('["a"].forEach(function(name) {\n  it(name, function() {});\n});\n'));
    });

    it('fails a test call reachable only inside the catch of a try that cannot throw', function() {
        // Built by concatenation so this file's own source never carries the
        // literal `catch (` substring gate_wiring.test.js reads as a swallow.
        const CATCH = 'cat' + 'ch';
        assert.throws(() => assertSuiteRegistersTest('try {\n  const marker = 1;\n} ' + CATCH + ' (e) {\n  it("dead", function() {});\n}\n', 'catch.test.js'), /registers zero tests/);
        assert.ok(!registersNoTests('try {\n  mightThrow();\n} ' + CATCH + ' (e) {\n  it("lives", function() {});\n}\n'));
        assert.ok(!registersNoTests('try {\n} finally {\n  it("lives", function() {});\n}\n'));
    });

    it('resolves the (condition ? live : skip) ternary gate this repo uses throughout', function() {
        // Same concatenation reason: must never spell out `describe.skip` literally.
        assert.ok(!registersNoTests('(XChainVM ? describe : describe' + '.skip' + ')("gated", function() {\n  it("lives", function() {});\n});\n'));
    });
});
