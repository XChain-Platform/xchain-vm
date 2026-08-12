// @ts-nocheck
// 
// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

// These tests require isolated-vm. Skip if not available.
let XChainVM;
try {
    XChainVM = require('../../src/index.js');
} catch (e) {
    console.log('Skipping sandbox tests (isolated-vm not available):', e);
}

const GAS_SCHEDULE = {
    VM_COMPUTATION: 1, VM_STATE_READ: 100, VM_STATE_WRITE: 200,
    VM_STATE_DELETE: 100, VM_ORACLE_READ: 100, VM_CROSSCHAIN_READ: 100, VM_ATTEST_REQUEST: 5000,
    VM_EMISSION: 500, VM_XCALL_REQUEST: 2000, VM_XCALL_CALLBACK: 20000
};

function createVM() {
    return new XChainVM({
        gasSchedule: GAS_SCHEDULE,
        gasCeiling: 1000000,
        limits: {
            maxCpuTimeMs: 5000, maxMemory: 8, maxEmissions: 50,
            maxStateKeys: 10000, maxStateValueSize: 65536, maxCodeSize: 65536
        }
    });
}

function executeCode(vm, code) {
    return vm.execute({
        code: code,
        state: {},
        method: 'default',
        params: [],
        caller: 'test_address',
        contractAddress: 'C:BTC:1',
        blockContext: { height: 100, timestamp: 1700000000, hash: 'abc123' }
    });
}

(XChainVM ? describe : describe.skip)('Sandbox', function() {

    let vm;
    before(function() { vm = createVM(); });

    it('should block process access', async function() {
        const result = await executeCode(vm,
            'module.exports = function(xchain) { return typeof process; };');
        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.parse(result.returnValue), 'undefined');
    });

    it('should block require access', async function() {
        const result = await executeCode(vm,
            'module.exports = function(xchain) { return typeof require; };');
        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.parse(result.returnValue), 'undefined');
    });

    it('should block Date access', async function() {
        const result = await executeCode(vm,
            'module.exports = function(xchain) { return typeof Date; };');
        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.parse(result.returnValue), 'undefined');
    });

    it('should block Math.random', async function() {
        const result = await executeCode(vm,
            'module.exports = function(xchain) { return typeof Math.random; };');
        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.parse(result.returnValue), 'undefined');
    });

    // The transcendentals (pow/log/log2/log10/sqrt) are stripped from the
    // sandbox Math because IEEE 754 does not mandate correctly-rounded results
    // for them (sqrt is correctly-rounded by the spec but is removed alongside
    // the others for a single, consistent surface). The host libm can differ by
    // 1 ULP across CPU architectures, which would diverge state hashes across a
    // heterogeneous validator fleet. Contracts must use the deterministic
    // bignumber equivalents at xchain.math.{pow,log,log2,log10,sqrt}. These
    // tests assert the strip at the live-isolate layer, independent of the
    // deploy-time syntax validator.
    ['pow', 'log', 'log2', 'log10', 'sqrt'].forEach(function(name) {
        it('should strip non-deterministic Math.' + name, async function() {
            const result = await executeCode(vm,
                'module.exports = function(xchain) { return typeof Math.' + name + '; };');
            assert.strictEqual(result.success, true);
            assert.strictEqual(JSON.parse(result.returnValue), 'undefined');
        });
    });

    it('should make Math.pow(2.1, 1.5) uncallable inside the sandbox', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                try {
                    return 'called:' + Math.pow(2.1, 1.5);
                } catch(e) {
                    return 'threw';
                }
            };
        `);
        assert.strictEqual(result.success, true);
        // Math.pow is undefined, so calling it throws a TypeError inside the contract.
        assert.strictEqual(JSON.parse(result.returnValue), 'threw');
    });

    it('should keep deterministic Math functions', async function() {
        const result = await executeCode(vm,
            'module.exports = function(xchain) { return Math.floor(3.7); };');
        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.parse(result.returnValue), 3);
    });

    it('should block setTimeout', async function() {
        const result = await executeCode(vm,
            'module.exports = function(xchain) { return typeof setTimeout; };');
        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.parse(result.returnValue), 'undefined');
    });

    it('should block eval', async function() {
        const result = await executeCode(vm,
            'module.exports = function(xchain) { return typeof eval; };');
        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.parse(result.returnValue), 'undefined');
    });

    it('should block constructor.constructor escape', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                try {
                    var fn = this.constructor.constructor('return typeof process')();
                    return fn;
                } catch(e) {
                    return 'blocked: ' + e.message;
                }
            };
        `);
        assert.strictEqual(result.success, true);
        const val = JSON.parse(result.returnValue);
        assert(val === 'undefined' || val.startsWith('blocked'), 'should be blocked: ' + val);
    });

    it('should run sandbox_escape.js contract', async function() {
        const code = fs.readFileSync(path.join(__dirname, '../contracts/sandbox_escape.js'), 'utf8');
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, true);
        for (const log of result.logs) {
            assert(log.includes('undefined') || log.includes('blocked'),
                'escape attempt should be blocked: ' + log);
        }
    });

    it('should not affect host process', async function() {
        // Attempt host-affecting operations and PROVE they were neutralized:
        // if either call resolved to a working host binding, the contract
        // returns that op's marker (or the runner dies), so a real fs/exit
        // escape can no longer pass this test silently.
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                try { process.exit(1); return 'exit-worked'; } catch(e) {}
                try { require('fs').unlinkSync('/tmp/test'); return 'unlink-worked'; } catch(e) {}
                return 'blocked';
            };
        `);
        assert.strictEqual(result.success, true,
            'sandboxed run must complete normally: ' + result.error);
        assert.strictEqual(JSON.parse(result.returnValue), 'blocked',
            'both host-affecting attempts must throw inside the sandbox');
    });

    it('should block WeakRef', async function() {
        const result = await executeCode(vm,
            'module.exports = function(xchain) { return typeof WeakRef; };');
        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.parse(result.returnValue), 'undefined');
    });

    it('should block FinalizationRegistry', async function() {
        const result = await executeCode(vm,
            'module.exports = function(xchain) { return typeof FinalizationRegistry; };');
        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.parse(result.returnValue), 'undefined');
    });

    it('should block Proxy', async function() {
        const result = await executeCode(vm,
            'module.exports = function(xchain) { return typeof Proxy; };');
        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.parse(result.returnValue), 'undefined');
    });

    it('should block SharedArrayBuffer', async function() {
        const result = await executeCode(vm,
            'module.exports = function(xchain) { return typeof SharedArrayBuffer; };');
        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.parse(result.returnValue), 'undefined');
    });

    it('should block Atomics', async function() {
        const result = await executeCode(vm,
            'module.exports = function(xchain) { return typeof Atomics; };');
        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.parse(result.returnValue), 'undefined');
    });

    it('should block queueMicrotask', async function() {
        const result = await executeCode(vm,
            'module.exports = function(xchain) { return typeof queueMicrotask; };');
        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.parse(result.returnValue), 'undefined');
    });

    it('should block setInterval', async function() {
        const result = await executeCode(vm,
            'module.exports = function(xchain) { return typeof setInterval; };');
        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.parse(result.returnValue), 'undefined');
    });

    it('should block setImmediate', async function() {
        const result = await executeCode(vm,
            'module.exports = function(xchain) { return typeof setImmediate; };');
        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.parse(result.returnValue), 'undefined');
    });

    // Intl (ECMAScript 402) output depends on the ICU data compiled into the host
    // Node.js binary (full-icu vs small-icu, and per-release ICU version), so two
    // validators on different builds would format the same value differently and
    // diverge state hashes. Temporal and structuredClone are stripped pre-emptively
    // for the same non-determinism class. performance (the Web Performance API) is
    // stripped because performance.now() returns wall-clock microseconds, a pure
    // non-determinism source like Date. A future V8 host build could expose
    // in the isolate. These assert the strip at the live-isolate layer.
    ['Intl', 'Temporal', 'structuredClone', 'performance'].forEach(function(name) {
        it('should block ' + name, async function() {
            const result = await executeCode(vm,
                'module.exports = function(xchain) { return typeof ' + name + '; };');
            assert.strictEqual(result.success, true);
            assert.strictEqual(JSON.parse(result.returnValue), 'undefined');
        });
    });

    it('should make Intl.NumberFormat uncallable inside the sandbox', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                try {
                    return 'called:' + new Intl.NumberFormat('de').format(1234.5);
                } catch(e) {
                    return 'threw';
                }
            };
        `);
        assert.strictEqual(result.success, true);
        // Intl is undefined, so referencing Intl.NumberFormat throws inside the contract.
        assert.strictEqual(JSON.parse(result.returnValue), 'threw');
    });

    it('should make performance.now() inaccessible inside the sandbox', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                try { return typeof performance + ':' + String(performance.now()); }
                catch(e) { return 'blocked:' + e.message; }
            };
        `);
        assert.strictEqual(result.success, true);
        const val = JSON.parse(result.returnValue);
        // performance is undefined, so performance.now() throws inside the contract.
        assert(val.startsWith('blocked:') || val.startsWith('undefined:'),
            'performance.now() should be inaccessible: ' + val);
    });

    it('should block console', async function() {
        const result = await executeCode(vm,
            'module.exports = function(xchain) { return typeof console; };');
        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.parse(result.returnValue), 'undefined');
    });

    it('should keep Math.ceil', async function() {
        const result = await executeCode(vm,
            'module.exports = function(xchain) { return Math.ceil(3.2); };');
        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.parse(result.returnValue), 4);
    });

    it('should keep Math.abs', async function() {
        const result = await executeCode(vm,
            'module.exports = function(xchain) { return Math.abs(-7); };');
        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.parse(result.returnValue), 7);
    });

    it('should keep Math.PI', async function() {
        const result = await executeCode(vm,
            'module.exports = function(xchain) { return typeof Math.PI; };');
        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.parse(result.returnValue), 'number');
    });

    it('should freeze Math object (no mutation)', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                try {
                    Math.custom = function() {};
                } catch(e) {
                    return 'frozen';
                }
                return typeof Math.custom;
            };
        `);
        assert.strictEqual(result.success, true);
        const val = JSON.parse(result.returnValue);
        assert(val === 'frozen' || val === 'undefined', 'Math should be frozen: ' + val);
    });

    it('should block indirect eval', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                try {
                    var indirectEval = (0, eval);
                    return typeof indirectEval;
                } catch(e) {
                    return 'blocked: ' + e.message;
                }
            };
        `);
        assert.strictEqual(result.success, true);
        const val = JSON.parse(result.returnValue);
        assert(val === 'undefined' || val.startsWith('blocked'), 'indirect eval should be blocked: ' + val);
    });

    it('should block Function constructor', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                try {
                    var fn = Function('return 1');
                    return fn();
                } catch(e) {
                    return 'blocked';
                }
            };
        `);
        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.parse(result.returnValue), 'blocked');
    });

    it('should freeze the xchain object', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                try {
                    xchain.custom = 'injected';
                } catch(e) {
                    return 'frozen';
                }
                return typeof xchain.custom;
            };
        `);
        assert.strictEqual(result.success, true);
        const val = JSON.parse(result.returnValue);
        assert(val === 'frozen' || val === 'undefined', 'xchain should be frozen: ' + val);
    });

    // Gas/result determinism for the STRIP-PATH programs. The corpus
    // determinism suites (cache-determinism, golden.determinism) prove
    // cold/warm/fresh-VM equality only for compute/stateful programs; the
    // neutered surface (stripped globals, neutered constructors, frozen
    // SafeMath) was never in those corpora. These cases assert that the
    // strip path itself costs identical gas and returns identical bytes
    // warm, repeated, and on a fresh isolate. A failure here is a REAL
    // strip-path determinism bug, not a test problem; do not weaken it.
    describe('strip-path gas/result determinism', function() {
        const STRIP_PROGRAMS = {
            'process-access-blocked':
                'module.exports = function(xchain) { return typeof process; };',
            'Proxy-neutered':
                'module.exports = function(xchain) { return typeof Proxy; };',
            'Math.random-throws': `module.exports = function(xchain) {
                try { Math.random(); return 'ran'; } catch(e) { return 'blocked'; }
            };`,
            'constructor-escape-blocked': `module.exports = function(xchain) {
                try {
                    return this.constructor.constructor('return typeof process')();
                } catch(e) { return 'blocked'; }
            };`
        };

        for (const [name, code] of Object.entries(STRIP_PROGRAMS)) {
            it(name + ': gasUsed + returnValue identical warm, repeated, and on a fresh VM', async function() {
                const warm1 = await executeCode(vm, code);
                const warm2 = await executeCode(vm, code);
                const fresh = await executeCode(createVM(), code);
                for (const r of [warm1, warm2, fresh]) {
                    assert.strictEqual(r.success, true, name + ' must execute: ' + r.error);
                    assert.strictEqual(typeof r.gasUsed, 'number', name + ' must report numeric gasUsed');
                }
                assert.strictEqual(warm2.gasUsed, warm1.gasUsed,
                    name + ': repeated warm run must charge identical gas');
                assert.strictEqual(fresh.gasUsed, warm1.gasUsed,
                    name + ': fresh-VM run must charge identical gas');
                assert.strictEqual(warm2.returnValue, warm1.returnValue,
                    name + ': repeated warm run must return identical bytes');
                assert.strictEqual(fresh.returnValue, warm1.returnValue,
                    name + ': fresh-VM run must return identical bytes');
            });
        }
    });
});
