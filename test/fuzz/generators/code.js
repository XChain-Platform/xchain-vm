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
 * Fuzz Generators: Contract Code
 *
 * Three tiers: valid templates, AST mutations, adversarial patterns.
 ********************************************************************/
// @ts-nocheck

const fc = require('fast-check');
const acorn = require('acorn');
const { generate } = require('astring');

// --- Tier 1: Valid contract templates ---

const VALID_TEMPLATES = [
    // Counter with state
    `module.exports = function(xchain) {
        var count = xchain.state.get('count') || '0';
        count = xchain.math.add(count, '1');
        xchain.state.set('count', count);
        return count;
    };`,

    // Simple SEND emission
    `module.exports = function(xchain) {
        xchain.emit.send({ destination: 'addr1', tick: 'TOKEN', quantity: '100' });
    };`,

    // Multi-method dispatch
    `module.exports = {
        increment: function(xchain) {
            var v = xchain.state.get('v') || '0';
            xchain.state.set('v', xchain.math.add(v, '1'));
        },
        read: function(xchain) {
            return xchain.state.get('v');
        }
    };`,

    // Math operations
    `module.exports = function(xchain) {
        var a = xchain.math.add('100', '200');
        var b = xchain.math.multiply(a, '3');
        var c = xchain.math.divide(b, '2');
        return c;
    };`,

    // Conditional with require
    `module.exports = function(xchain) {
        var p = xchain.getInputParam(0);
        xchain.require(p !== null, 'missing param');
        xchain.state.set('received', p);
        return p;
    };`,

    // Bounded loop
    `module.exports = function(xchain) {
        var sum = '0';
        for (var i = 0; i < 10; i++) {
            sum = xchain.math.add(sum, String(i));
        }
        return sum;
    };`,

    // State get-modify-set
    `module.exports = function(xchain) {
        var data = xchain.state.get('data');
        if (data === null) data = 'initial';
        xchain.state.set('data', data + '_modified');
        return xchain.state.get('data');
    };`,

    // Revert path (always fails, for atomicity testing)
    `module.exports = function(xchain) {
        xchain.state.set('shouldNotPersist', 'value');
        xchain.emit.send({ destination: 'addr1', tick: 'T', quantity: '1' });
        xchain.revert('intentional revert');
    };`,

    // Context accessors
    `module.exports = function(xchain) {
        return {
            height: xchain.getBlockHeight(),
            timestamp: xchain.getBlockTimestamp(),
            hash: xchain.getBlockHash(),
            caller: xchain.getSourceAddress(),
            contract: xchain.getContractAddress()
        };
    };`,

    // Logging
    `module.exports = function(xchain) {
        xchain.log('hello', 'world');
        xchain.log('count:', xchain.getLogCount());
        return xchain.getLogCount();
    };`,

    // Contract-targeted staking reads (getStake / getTotalStaked / getStakers).
    // Without injected stake data these return '0'/'0'/[]. The point is to fuzz
    // the gas-charging + serialisation around the host call sites.
    `module.exports = function(xchain) {
        var pk = 'a'.repeat(64);
        return {
            stake: xchain.contract.getStake(pk, 'TOKEN'),
            total: xchain.contract.getTotalStaked('TOKEN'),
            stakers: xchain.contract.getStakers('TOKEN').length
        };
    };`,

    // Contract slash emission (routes a SLASH action; charges VM_EMISSION)
    `module.exports = function(xchain) {
        xchain.contract.slash('a'.repeat(64), 'TOKEN', '10.00000000');
        return 'slashed';
    };`,

    // Attestation request emission (charges VM_ATTEST_REQUEST + VM_EMISSION,
    // returns a deterministic request_id)
    `module.exports = function(xchain) {
        return xchain.attestation.request(
            'http_get', 'https://example.com', 'cb', ['p'], { redundancy: 1, deadlineBlocks: 5 }
        );
    };`,

    // Attestation response read (charges VM_STATE_READ; null without injected data)
    `module.exports = function(xchain) {
        var r = xchain.attestation.getResponse('abc123');
        return r === null ? 'none' : 'have';
    };`
];

const validContractArb = fc.constantFrom(...VALID_TEMPLATES);

// --- Tier 2: AST mutation of valid contracts ---

function tryMutateAST(code, mutationType) {
    try {
        const ast = acorn.parse(code, { ecmaVersion: 2020, sourceType: 'script' });
        switch (mutationType) {
            case 0: // Swap a string literal with empty string
                swapStringLiteral(ast);
                break;
            case 1: // Double a numeric literal
                doubleNumericLiteral(ast);
                break;
            case 2: // Remove a statement from a block body
                removeStatement(ast);
                break;
            case 3: // Duplicate a statement in a block body
                duplicateStatement(ast);
                break;
            case 4: // Replace a string literal with a long string
                longStringLiteral(ast);
                break;
        }
        return generate(ast);
    } catch (e) {
        return code; // If mutation fails, return original
    }
}

function walkNodes(ast, type) {
    const results = [];
    function visit(node) {
        if (!node || typeof node !== 'object') return;
        if (node.type === type) results.push(node);
        for (const key of Object.keys(node)) {
            const child = node[key];
            if (Array.isArray(child)) child.forEach(visit);
            else if (child && typeof child === 'object' && child.type) visit(child);
        }
    }
    visit(ast);
    return results;
}

function swapStringLiteral(ast) {
    const literals = walkNodes(ast, 'Literal').filter(n => typeof n.value === 'string');
    if (literals.length > 0) {
        const target = literals[Math.floor(Math.random() * literals.length)];
        target.value = '';
        target.raw = "''";
    }
}

function doubleNumericLiteral(ast) {
    const literals = walkNodes(ast, 'Literal').filter(n => typeof n.value === 'number');
    if (literals.length > 0) {
        const target = literals[Math.floor(Math.random() * literals.length)];
        target.value = target.value * 2;
        target.raw = String(target.value);
    }
}

function removeStatement(ast) {
    const blocks = walkNodes(ast, 'BlockStatement');
    for (const block of blocks) {
        if (block.body && block.body.length > 1) {
            block.body.splice(Math.floor(Math.random() * block.body.length), 1);
            return;
        }
    }
}

function duplicateStatement(ast) {
    const blocks = walkNodes(ast, 'BlockStatement');
    for (const block of blocks) {
        if (block.body && block.body.length > 0) {
            const idx = Math.floor(Math.random() * block.body.length);
            const clone = JSON.parse(JSON.stringify(block.body[idx]));
            block.body.splice(idx, 0, clone);
            return;
        }
    }
}

function longStringLiteral(ast) {
    const literals = walkNodes(ast, 'Literal').filter(n => typeof n.value === 'string');
    if (literals.length > 0) {
        const target = literals[Math.floor(Math.random() * literals.length)];
        target.value = 'x'.repeat(500);
        target.raw = "'" + target.value + "'";
    }
}

const mutatedContractArb = fc.tuple(
    fc.constantFrom(...VALID_TEMPLATES),
    fc.integer({ min: 0, max: 4 })
).map(([code, mutation]) => tryMutateAST(code, mutation));

// --- Tier 3: Adversarial patterns ---

function deepTernary(depth) {
    let expr = '1';
    for (let i = 0; i < depth; i++) expr = '(true ? ' + expr + ' : 0)';
    return 'module.exports = function(xchain) { return ' + expr + '; };';
}

function deepBinary(count) {
    const parts = [];
    for (let i = 0; i < count; i++) parts.push('1');
    return 'module.exports = function(xchain) { return ' + parts.join(' + ') + '; };';
}

const ADVERSARIAL_PATTERNS = [
    // Infinite loop: must exhaust gas
    'module.exports = function(xchain) { while(true){} };',

    // Deeply nested ternary
    deepTernary(100),

    // Deep binary expression chain
    deepBinary(200),

    // Prototype pollution attempts
    'module.exports = function(xchain) { ({}).__proto__.polluted = true; return typeof ({}).polluted; };',
    'module.exports = function(xchain) { Object.prototype.evil = 1; return ({}).evil; };',

    // globalThis manipulation
    'module.exports = function(xchain) { try { globalThis.__proto__.evil = true; } catch(e){} return "done"; };',

    // Serialization boundary markers in return value
    'module.exports = function(xchain) { return "\\x01{\\\"evil\\\":true}"; };',
    'module.exports = function(xchain) { return "\\x02{\\\"evil\\\":true}"; };',
    'module.exports = function(xchain) { return "\\x03GAS:999999:1"; };',

    // Gas error spoofing
    'module.exports = function(xchain) { throw new Error("\\x03GAS:999999:1"); };',

    // Revert spoofing
    'module.exports = function(xchain) { throw new Error("\\x03REVERT:spoofed"); };',

    // Wrong export shapes
    'module.exports = 42;',
    'module.exports = null;',
    'module.exports = function() {};',
    'module.exports = "string";',

    // __gas identifier (should be caught by syntax validation but we bypass it)
    'module.exports = function(xchain) { var o = {__gas: function(){}}; return "ok"; };',

    // Constructor escape attempts
    'module.exports = function(xchain) { try { return ({}).__proto__.constructor.constructor("return typeof process")(); } catch(e) { return "blocked"; } };',

    // JSON.stringify override
    'module.exports = function(xchain) { try { JSON.stringify = function(){ return "hacked"; }; } catch(e){} xchain.state.set("k","v"); return "done"; };',

    // JSON.parse override
    'module.exports = function(xchain) { try { JSON.parse = function(){ return {evil:true}; }; } catch(e){} return "done"; };',

    // Symbol manipulation
    'module.exports = function(xchain) { try { var s = Symbol.toPrimitive; ({})[s] = function(){ return 42; }; } catch(e){} return "done"; };',

    // Error.stack information leak
    'module.exports = function(xchain) { try { throw new Error("test"); } catch(e) { return e.stack; } };',

    // Arguments.callee
    'module.exports = function(xchain) { try { return arguments.callee.toString(); } catch(e) { return "blocked"; } };',

    // Getter trap in state value
    'module.exports = function(xchain) { var obj = {}; Object.defineProperty(obj, "x", { get: function(){ return "trapped"; } }); xchain.state.set("k", obj); return "done"; };',

    // Large return value
    'module.exports = function(xchain) { return "x".repeat(100000); };',

    // Recursive toString
    'module.exports = function(xchain) { var o = {}; o.toString = function(){ return o.toString(); }; try { "" + o; } catch(e){} return "done"; };',

    // Deeply nested object as state value
    'module.exports = function(xchain) { var o = {a:1}; for(var i=0;i<50;i++) o = {nested:o}; xchain.state.set("deep", o); return "done"; };',
];

const adversarialCodeArb = fc.constantFrom(...ADVERSARIAL_PATTERNS);

// Combined arbitrary with weighted distribution
const anyCodeArb = fc.oneof(
    { weight: 3, arbitrary: validContractArb },
    { weight: 4, arbitrary: mutatedContractArb },
    { weight: 3, arbitrary: adversarialCodeArb }
);

module.exports = {
    validContractArb,
    mutatedContractArb,
    adversarialCodeArb,
    anyCodeArb,
    VALID_TEMPLATES,
    ADVERSARIAL_PATTERNS
};
