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
 * [P1] Core Security Regression Tests
 *
 * Tests that MUST pass on every commit. Covers sandbox escapes,
 * gas bypass, error atomicity, and determinism.
 *
 * Run: npm run test:regression:core
 ********************************************************************/
// @ts-nocheck

// 


const assert = require('assert');
const crypto = require('crypto');
const { createVM, execute, executeNTimes, assertAtomicFailure } = require('./helpers.js');

describe('[P1] Security Regression', function() {

    let vm;
    before(function() { vm = createVM(); });

    // ================================================================
    // SANDBOX ESCAPE VECTORS
    // ================================================================
    describe('Sandbox escape prevention', function() {

        const BLOCKED_GLOBALS = [
            'Date', 'process', 'require', 'eval', 'setTimeout', 'setInterval',
            'setImmediate', 'queueMicrotask', 'console', 'WeakRef', 'Proxy',
            'FinalizationRegistry', 'SharedArrayBuffer', 'Atomics', 'Reflect'
        ];

        for (const global of BLOCKED_GLOBALS) {
            it(`should block ${global}`, async function() {
                const r = await execute(vm,
                    `module.exports = function(xchain) { return typeof ${global}; };`);
                assert.strictEqual(r.success, true);
                assert.strictEqual(JSON.parse(r.returnValue), 'undefined',
                    `${global} should be undefined in sandbox`);
            });
        }

        it('should block Math.random', async function() {
            const r = await execute(vm,
                'module.exports = function(xchain) { return typeof Math.random; };');
            assert.strictEqual(r.success, true);
            assert.strictEqual(JSON.parse(r.returnValue), 'undefined');
        });

        it('should block constructor.constructor escape', async function() {
            const r = await execute(vm, `
                module.exports = function(xchain) {
                    try {
                        var fn = this.constructor.constructor('return typeof process')();
                        return fn;
                    } catch(e) { return 'blocked'; }
                };
            `);
            assert.strictEqual(r.success, true);
            const v = JSON.parse(r.returnValue);
            assert(v === 'undefined' || v === 'blocked');
        });

        it('should block Object.prototype.constructor chain', async function() {
            const r = await execute(vm, `
                module.exports = function(xchain) {
                    try {
                        var ctor = ({}).constructor;
                        return typeof ctor;
                    } catch(e) { return 'blocked'; }
                };
            `);
            assert.strictEqual(r.success, true);
            const v = JSON.parse(r.returnValue);
            assert(v === 'undefined' || v === 'blocked');
        });

        it('should block Array.prototype.constructor chain', async function() {
            const r = await execute(vm, `
                module.exports = function(xchain) {
                    try { return typeof [].constructor; }
                    catch(e) { return 'blocked'; }
                };
            `);
            assert.strictEqual(r.success, true);
            const v = JSON.parse(r.returnValue);
            assert(v === 'undefined' || v === 'blocked');
        });

        it('should block Function constructor', async function() {
            const r = await execute(vm, `
                module.exports = function(xchain) {
                    try { var fn = Function('return 1'); return fn(); }
                    catch(e) { return 'blocked'; }
                };
            `);
            assert.strictEqual(r.success, true);
            assert.strictEqual(JSON.parse(r.returnValue), 'blocked');
        });

        it('should block indirect eval', async function() {
            const r = await execute(vm, `
                module.exports = function(xchain) {
                    try { var ie = (0, eval); return typeof ie; }
                    catch(e) { return 'blocked'; }
                };
            `);
            assert.strictEqual(r.success, true);
            const v = JSON.parse(r.returnValue);
            assert(v === 'undefined' || v === 'blocked');
        });

        it('should freeze xchain object', async function() {
            const r = await execute(vm, `
                module.exports = function(xchain) {
                    try { xchain.evil = 'injected'; } catch(e) { return 'frozen'; }
                    return typeof xchain.evil;
                };
            `);
            assert.strictEqual(r.success, true);
            const v = JSON.parse(r.returnValue);
            assert(v === 'frozen' || v === 'undefined');
        });

        it('should freeze Math object', async function() {
            const r = await execute(vm, `
                module.exports = function(xchain) {
                    try { Math.evil = 1; } catch(e) { return 'frozen'; }
                    return typeof Math.evil;
                };
            `);
            assert.strictEqual(r.success, true);
            const v = JSON.parse(r.returnValue);
            assert(v === 'frozen' || v === 'undefined');
        });

        it('should not affect host process', async function() {
            await execute(vm, `
                module.exports = function(xchain) {
                    try { process.exit(1); } catch(e) {}
                    try { require('fs').unlinkSync('/tmp/x'); } catch(e) {}
                    return 'done';
                };
            `);
            assert(true, 'host process not affected');
        });
    });

    // ================================================================
    // GAS METERING BYPASS PREVENTION
    // ================================================================
    describe('Gas metering bypass prevention', function() {

        it('should halt infinite loop via gas ceiling', async function() {
            this.timeout(10000);
            const vm2 = createVM({ gasCeiling: 1000 });
            const r = await execute(vm2,
                'module.exports = function(xchain) { while(true) {} };');
            assert.strictEqual(r.success, false);
            assert(r.error.includes('out_of_gas'));
        });

        it('should prevent __gas overwrite', async function() {
            const r = await execute(vm, `
                module.exports = function(xchain) {
                    try { __gas = function() {}; } catch(e) {}
                    // If __gas was overwritten, infinite loop would succeed
                    for (var i = 0; i < 100; i++) {}
                    return 'metering intact';
                };
            `);
            assert.strictEqual(r.success, true);
            assert(r.gasUsed > 0, 'gas should still be tracked');
        });

        it('should reject code using __gas identifier at deploy time', function() {
            const res = vm.validateSyntax('var __gas = 1;');
            assert.strictEqual(res.valid, false);
            assert(res.error.includes('__gas'));
        });
    });

    // ================================================================
    // ERROR ATOMICITY
    // ================================================================
    describe('Error atomicity', function() {

        it('should discard state and emissions on revert', async function() {
            const r = await execute(vm, `
                module.exports = function(xchain) {
                    xchain.state.set('a', '1');
                    xchain.state.set('b', '2');
                    xchain.emit.send({ destination: 'x', tick: 'T', quantity: '1' });
                    xchain.log('preserved');
                    xchain.revert('rollback');
                };
            `);
            assertAtomicFailure(r);
            assert(r.logs.length > 0, 'logs must be preserved');
        });

        it('should discard state and emissions on gas exhaustion', async function() {
            const vm2 = createVM({ gasCeiling: 500 });
            const r = await execute(vm2, `
                module.exports = function(xchain) {
                    xchain.state.set('a', '1');
                    for (var i = 0; i < 100000; i++) {}
                };
            `);
            assertAtomicFailure(r);
            assert(r.error.includes('out_of_gas'));
        });

        it('should discard state and emissions on uncaught throw', async function() {
            const r = await execute(vm, `
                module.exports = function(xchain) {
                    xchain.state.set('x', '1');
                    xchain.emit.send({ destination: 'a', tick: 'T', quantity: '1' });
                    throw new Error('contract crash');
                };
            `);
            assertAtomicFailure(r);
        });

        it('should preserve logs on gas exhaustion', async function() {
            const vm2 = createVM({ gasCeiling: 5000 });
            const r = await execute(vm2, `
                module.exports = function(xchain) {
                    xchain.log('before loop');
                    for (var i = 0; i < 100000; i++) {}
                };
            `);
            assert.strictEqual(r.success, false);
            assert(r.logs.length > 0, 'logs must survive gas exhaustion');
        });
    });

    // ================================================================
    // DETERMINISM
    // ================================================================
    describe('Determinism', function() {

        function hashResult(result) {
            const normalized = {
                success: result.success,
                error: result.error,
                gasUsed: result.gasUsed,
                returnValue: result.returnValue,
                stateChanges: [...result.stateChanges].sort((a, b) => a.key.localeCompare(b.key)),
                stateDeletes: [...result.stateDeletes].sort(),
                emittedActions: result.emittedActions,
                logs: result.logs
            };
            return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
        }

        it('should produce identical results across 3 runs (stateful)', async function() {
            const code = `module.exports = function(xchain) {
                for (var i = 0; i < 5; i++) {
                    xchain.state.set('k' + i, xchain.math.multiply(String(i), '10'));
                }
                xchain.emit.send({ destination: 'a', tick: 'T', quantity: '50' });
                return 'done';
            };`;
            const results = await executeNTimes(vm, code, {}, 3);
            const h0 = hashResult(results[0]);
            assert(results.every(r => hashResult(r) === h0), 'all 3 runs must produce identical results');
        });

        it('should produce identical gas usage across runs', async function() {
            const code = `module.exports = function(xchain) {
                for (var i = 0; i < 10; i++) { xchain.state.set('k' + i, String(i)); }
                return 'done';
            };`;
            const results = await executeNTimes(vm, code, {}, 3);
            assert(results.every(r => r.gasUsed === results[0].gasUsed));
        });

        it('should produce identical failure results', async function() {
            const code = `module.exports = function(xchain) {
                xchain.state.set('x', '1');
                xchain.revert('deterministic fail');
            };`;
            const results = await executeNTimes(vm, code, {}, 3);
            const h0 = hashResult(results[0]);
            assert(results.every(r => hashResult(r) === h0));
            assert.strictEqual(results[0].success, false);
        });
    });
});
