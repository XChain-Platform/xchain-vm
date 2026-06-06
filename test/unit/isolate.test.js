// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

const assert = require('assert');

let IsolateManager, ivm;
try {
    IsolateManager = require('../../src/isolate.js');
    ivm = require('isolated-vm');
} catch (e) {
    console.log('Skipping isolate tests — isolated-vm not available:', e);
}

(IsolateManager && ivm ? describe : describe.skip)('IsolateManager', function() {

    const LIMITS = { maxMemory: 8 };

    describe('createIsolate', function() {
        it('should return isolate and context', function() {
            const mgr = new IsolateManager(LIMITS);
            const env = mgr.createIsolate();
            assert(env.isolate instanceof ivm.Isolate);
            assert(env.context !== null && env.context !== undefined);
            mgr.dispose(env.isolate);
        });

        it('should create a functional isolate that can run code', function() {
            const mgr = new IsolateManager(LIMITS);
            const { isolate, context } = mgr.createIsolate();
            const script = isolate.compileScriptSync('1 + 2');
            const result = script.runSync(context);
            assert.strictEqual(result, 3);
            mgr.dispose(isolate);
        });
    });

    describe('createThrowawayIsolate', function() {
        it('should return an isolate', function() {
            const mgr = new IsolateManager(LIMITS);
            try {
                const isolate = mgr.createThrowawayIsolate();
                assert(isolate instanceof ivm.Isolate);
                isolate.dispose();
            } catch (e) {
                // Some ivm versions require memoryLimit >= 8
                if (e.message.includes('memoryLimit')) {
                    this.skip();
                } else {
                    throw e;
                }
            }
        });

        it('should be able to compile scripts', function() {
            const mgr = new IsolateManager(LIMITS);
            try {
                const isolate = mgr.createThrowawayIsolate();
                const script = isolate.compileScriptSync('var x = 1;');
                assert(script !== null);
                isolate.dispose();
            } catch (e) {
                if (e.message.includes('memoryLimit')) {
                    this.skip();
                } else {
                    throw e;
                }
            }
        });
    });

    describe('compileScript', function() {
        it('should compile valid code', function() {
            const mgr = new IsolateManager(LIMITS);
            const { isolate } = mgr.createIsolate();
            const script = mgr.compileScript(isolate, 'var x = 1;');
            assert(script !== null);
            mgr.dispose(isolate);
        });

        it('should throw on invalid code', function() {
            const mgr = new IsolateManager(LIMITS);
            const { isolate } = mgr.createIsolate();
            assert.throws(() => mgr.compileScript(isolate, 'function { invalid }'));
            mgr.dispose(isolate);
        });
    });

    describe('getCachedData', function() {
        it('should return cached data if supported', function() {
            const mgr = new IsolateManager(LIMITS);
            const { isolate } = mgr.createIsolate();
            const script = mgr.compileScript(isolate, 'var x = 1 + 2;');
            try {
                const cached = mgr.getCachedData(script);
                assert(cached !== null && cached !== undefined, 'should return cached data');
            } catch (e) {
                if (e.message.includes('not a function')) {
                    this.skip(); // createCachedData not available in this ivm version
                } else {
                    throw e;
                }
            } finally {
                mgr.dispose(isolate);
            }
        });

        it('should produce reusable cached data if supported', function() {
            const mgr = new IsolateManager(LIMITS);
            const code = 'var x = 1 + 2;';

            const { isolate: iso1, context: ctx1 } = mgr.createIsolate();
            const script1 = mgr.compileScript(iso1, code);
            let cached;
            try {
                cached = mgr.getCachedData(script1);
            } catch (e) {
                mgr.dispose(iso1);
                if (e.message.includes('not a function')) {
                    this.skip();
                } else {
                    throw e;
                }
                return;
            }
            mgr.dispose(iso1);

            // Recompile with cached data — should not throw
            const { isolate: iso2, context: ctx2 } = mgr.createIsolate();
            const script2 = mgr.compileScript(iso2, code, cached);
            const result = script2.runSync(ctx2);
            assert.strictEqual(result, 3);
            mgr.dispose(iso2);
        });
    });

    describe('dispose', function() {
        it('should dispose an isolate without error', function() {
            const mgr = new IsolateManager(LIMITS);
            const { isolate } = mgr.createIsolate();
            mgr.dispose(isolate);
            // Should not throw
        });

        it('should handle double dispose gracefully', function() {
            const mgr = new IsolateManager(LIMITS);
            const { isolate } = mgr.createIsolate();
            mgr.dispose(isolate);
            mgr.dispose(isolate); // Should not throw
        });

        it('should handle null isolate gracefully', function() {
            const mgr = new IsolateManager(LIMITS);
            mgr.dispose(null); // Should not throw
        });

        it('should handle undefined isolate gracefully', function() {
            const mgr = new IsolateManager(LIMITS);
            mgr.dispose(undefined); // Should not throw
        });
    });
});
