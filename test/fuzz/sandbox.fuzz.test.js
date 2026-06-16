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
 * Fuzz Tests — Sandbox Escape
 *
 * Tests that adversarial contracts cannot escape the V8 isolate
 * sandbox, access host objects, or pollute prototypes.
 ********************************************************************/
// @ts-nocheck

// 


const fc = require('fast-check');
const assert = require('assert');
const { XChainVM, createVM, execute, FC_OPTIONS } = require('./harness');
const { checkResultShape, checkAtomicity, checkNoPrototypePollution } = require('./invariants');
const { adversarialCodeArb } = require('./generators/code');

const ESCAPE_VECTORS = [
    {
        name: 'constructor chain (5 levels)',
        code: `module.exports = function(xchain) {
            try {
                var c = {}.constructor.constructor.constructor.constructor.constructor;
                return typeof c('return process')();
            } catch(e) { return 'blocked: ' + e.message; }
        };`
    },
    {
        name: 'Object.getPrototypeOf(globalThis)',
        code: `module.exports = function(xchain) {
            try {
                var proto = Object.getPrototypeOf(globalThis);
                return proto ? Object.keys(proto).join(',') : 'null';
            } catch(e) { return 'blocked'; }
        };`
    },
    {
        name: 'Reflect.ownKeys(globalThis)',
        code: `module.exports = function(xchain) {
            try {
                var keys = typeof Reflect !== 'undefined' ? Reflect.ownKeys(globalThis) : [];
                return keys.join(',');
            } catch(e) { return 'blocked'; }
        };`
    },
    {
        name: 'Symbol.iterator manipulation',
        code: `module.exports = function(xchain) {
            try {
                Array.prototype[Symbol.iterator] = function*() { yield 'hacked'; };
                var arr = [1,2,3];
                var result = [...arr];
                return result.join(',');
            } catch(e) { return 'blocked'; }
        };`
    },
    {
        name: 'arguments.callee.caller',
        code: `module.exports = function(xchain) {
            try {
                var caller = arguments.callee.caller;
                // callee is accessible in non-strict mode (returns the function itself)
                // but caller should be null/undefined (no parent frame to leak)
                if (caller && typeof caller === 'function') {
                    // Try to use it to get host info — this is the real test
                    try { return 'caller_result:' + caller(); } catch(e2) {}
                }
                return 'safe';
            } catch(e) { return 'blocked'; }
        };`
    },
    {
        name: 'Function.prototype.call.call on require',
        code: `module.exports = function(xchain) {
            try {
                var F = Function;
                return typeof F.prototype.call.call(F, null, 'return process')();
            } catch(e) { return 'blocked'; }
        };`
    },
    {
        name: 'xchain.__defineGetter__',
        code: `module.exports = function(xchain) {
            try {
                xchain.__defineGetter__('evil', function(){ return 'hacked'; });
                return xchain.evil;
            } catch(e) { return 'blocked'; }
        };`
    },
    {
        name: 'xchain.state.__proto__ mutation',
        code: `module.exports = function(xchain) {
            try {
                xchain.state.__proto__.evil = 'hacked';
                return ({}).evil;
            } catch(e) { return 'blocked'; }
        };`
    },
    {
        name: 'Object.defineProperty on frozen xchain',
        code: `module.exports = function(xchain) {
            try {
                Object.defineProperty(xchain, 'evil', { value: 'hacked' });
                return xchain.evil;
            } catch(e) { return 'blocked'; }
        };`
    },
    {
        name: 'Proxy constructor (should be stripped)',
        code: `module.exports = function(xchain) {
            try {
                var p = new Proxy({}, { get: function(t,k) { return 'trapped'; } });
                return p.anything;
            } catch(e) { return 'blocked'; }
        };`
    },
    {
        name: 'WeakRef (should be stripped)',
        code: `module.exports = function(xchain) {
            try {
                var w = new WeakRef({});
                return typeof w.deref();
            } catch(e) { return 'blocked'; }
        };`
    },
    {
        name: 'eval (should be stripped)',
        code: `module.exports = function(xchain) {
            try { return eval('1+1'); }
            catch(e) { return 'blocked'; }
        };`
    },
    {
        name: 'indirect eval (0, eval)',
        code: `module.exports = function(xchain) {
            try { return (0, eval)('1+1'); }
            catch(e) { return 'blocked'; }
        };`
    },
    {
        name: 'Error.stack leak check',
        code: `module.exports = function(xchain) {
            try { throw new Error('probe'); }
            catch(e) {
                var stack = e.stack || '';
                // Should not contain host file paths
                if (stack.includes('/home/') || stack.includes('/usr/') || stack.includes('node_modules'))
                    return 'LEAK: ' + stack;
                return 'safe';
            }
        };`
    },
    {
        name: 'override JSON.stringify to intercept serialization',
        code: `module.exports = function(xchain) {
            try {
                var orig = JSON.stringify;
                JSON.stringify = function() { return '{"hacked":true}'; };
                xchain.state.set('k', 'v');
                JSON.stringify = orig;
            } catch(e) {}
            return 'done';
        };`
    },
    {
        name: 'override JSON.parse to intercept deserialization',
        code: `module.exports = function(xchain) {
            try {
                JSON.parse = function() { return {evil:true}; };
            } catch(e) {}
            return 'done';
        };`
    },
    {
        name: 'toString/valueOf trap on state value',
        code: `module.exports = function(xchain) {
            var trap = {
                toString: function() { throw new Error('trap'); },
                valueOf: function() { throw new Error('trap'); }
            };
            try { xchain.state.set('k', trap); } catch(e) {}
            return 'done';
        };`
    },
    {
        name: 'Symbol.toPrimitive override',
        code: `module.exports = function(xchain) {
            try {
                var o = {};
                o[Symbol.toPrimitive] = function() { return 42; };
                xchain.state.set('k', o);
            } catch(e) {}
            return 'done';
        };`
    },
    {
        name: 'getter trap on object passed to state.set',
        code: `module.exports = function(xchain) {
            var obj = {};
            var count = 0;
            Object.defineProperty(obj, 'x', {
                get: function() { count++; return count > 1000 ? 'stopped' : obj; },
                enumerable: true
            });
            try { xchain.state.set('k', obj); } catch(e) {}
            return 'done';
        };`
    },
    {
        name: 'globalThis enumeration after stripping',
        code: `module.exports = function(xchain) {
            var names = Object.getOwnPropertyNames(globalThis);
            // Sandbox strips globals by setting to undefined, so property names
            // may still exist. The real test is that their VALUES are not callable.
            var dangerous = names.filter(function(n) {
                var val = globalThis[n];
                return val !== undefined && val !== null &&
                    ['process','require','Buffer'].indexOf(n) >= 0;
            });
            if (dangerous.length > 0) return 'LEAK: ' + dangerous.join(',');
            return 'safe: ' + names.length + ' globals';
        };`
    }
];

(XChainVM ? describe : describe.skip)('Fuzz: Sandbox', function() {
    this.timeout(120000);
    let vm;

    before(function() { vm = createVM(); });

    // Static escape vector tests
    for (const vector of ESCAPE_VECTORS) {
        it('blocks escape: ' + vector.name, async function() {
            const result = await execute(vm, vector.code);
            checkResultShape(result);
            checkNoPrototypePollution();

            // If the escape returned a value, it should not indicate success
            if (result.success && result.returnValue) {
                const val = JSON.parse(result.returnValue);
                if (typeof val === 'string') {
                    assert(!val.startsWith('LEAK:'),
                        'Sandbox leak detected in ' + vector.name + ': ' + val);
                    // process, require, etc. should be undefined/blocked
                    assert(val !== 'object' && val !== 'function',
                        'Dangerous global accessible in ' + vector.name + ': ' + val);
                }
            }
        });
    }

    // Property-based: adversarial code never pollutes prototypes
    it('adversarial code never pollutes host prototypes', async function() {
        await fc.assert(fc.asyncProperty(adversarialCodeArb, async (code) => {
            const result = await execute(vm, code);
            checkResultShape(result);
            checkAtomicity(result);
            checkNoPrototypePollution();
        }), FC_OPTIONS);
    });

    // Verify no cumulative pollution after all tests
    after(function() {
        checkNoPrototypePollution();
    });
});
