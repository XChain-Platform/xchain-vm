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
 * XChain VM: metering AST construction helpers
 ********************************************************************/
// @ts-nocheck

// AST node for: __gas(1)
function gasCallStatement() {
    return {
        type: 'ExpressionStatement',
        expression: gasCallExpr()
    };
}

// AST node for: __gas(1) as an expression (for sequence expressions)
function gasCallExpr() {
    return {
        type: 'CallExpression',
        callee: { type: 'Identifier', name: '__gas' },
        arguments: [{ type: 'Literal', value: 1 }],
        optional: false
    };
}

// Wrap an expression as: (__gas(1), expr)
function wrapWithGas(expr) {
    return {
        type: 'SequenceExpression',
        expressions: [gasCallExpr(), expr]
    };
}

// AST node for a bare call statement:  __name()
function callStatement(name) {
    return {
        type: 'ExpressionStatement',
        expression: { type: 'CallExpression',
            callee: { type: 'Identifier', name: name }, arguments: [], optional: false }
    };
}

// Wrap a function node's (block) body with the deterministic call-depth guard:
//     __depth_enter(); try { <original body> } finally { __depth_exit(); }
// The enter hook throws (and poisons execution) when the fixed depth limit is
// reached; the finally guarantees the counter is decremented on every normal or
// exceptional return so sibling (non-nested) calls do not accumulate depth.
// Any leading directive-prologue statements (e.g. "use strict") are lifted
// before the guard so they keep directive-prologue position in the output,
// matching the same pattern as insertGasAfterDirectives.
function wrapDepthGuard(node) {
    if (!node.body || node.body.type !== 'BlockStatement') return;
    const body = node.body.body;
    const offset = directivePrologueLength(body);
    const directives = body.slice(0, offset);
    const rest = body.slice(offset);
    const tryStmt = {
        type: 'TryStatement',
        block: { type: 'BlockStatement', body: rest },
        handler: null,
        finalizer: { type: 'BlockStatement', body: [callStatement('__depth_exit')] }
    };
    node.body.body = directives.concat([callStatement('__depth_enter'), tryStmt]);
}

// Count the number of directive prologue statements at the start of a body
function directivePrologueLength(body) {
    let count = 0;
    for (const stmt of body) {
        if (stmt.type === 'ExpressionStatement' &&
            stmt.expression.type === 'Literal' &&
            typeof stmt.expression.value === 'string') {
            count++;
        } else {
            break;
        }
    }
    return count;
}

// Insert __gas(1) into a function/block body after any directive prologue
function insertGasAfterDirectives(body) {
    const offset = directivePrologueLength(body);
    body.splice(offset, 0, gasCallStatement());
}

// Ensure a node has a block body (wrap single-statement bodies)
function ensureBlock(node, prop) {
    if (node[prop] && node[prop].type !== 'BlockStatement') {
        node[prop] = {
            type: 'BlockStatement',
            body: [node[prop]]
        };
    }
}

// Get the depth of nested BinaryExpression nodes (left-leaning)
function binaryDepth(node) {
    let depth = 0;
    let current = node;
    while (current.type === 'BinaryExpression') {
        depth++;
        current = current.left;
    }
    return depth;
}

// Small AST builders for the allocator rewrite.
function astIdent(name) { return { type: 'Identifier', name: name }; }
function astLiteral(value)  { return { type: 'Literal', value: value }; }
function astArray(elements) { return { type: 'ArrayExpression', elements: elements }; }
function astCall(name, args) {
    return { type: 'CallExpression', callee: astIdent(name), arguments: args, optional: false };
}
function cloneNode(node) { return JSON.parse(JSON.stringify(node)); }
function astVoid0() { return { type: 'UnaryExpression', operator: 'void', prefix: true, argument: astLiteral(0) }; }
// A zero-arg arrow that returns `expr` unevaluated: () => expr. Used by the
// spec-correct obj[k] += rhs rewrite to DEFER the rhs so the helper can read
// obj[k] first. An arrow (not a function) keeps `this`/`arguments`/`new.target`
// lexical, so deferring never changes what the rhs would compute inline.
function arrowThunk(expr) {
    return { type: 'ArrowFunctionExpression', id: null, params: [],
        body: expr, async: false, generator: false, expression: true };
}
// The property key of a member expression, as an expression evaluated once:
// the raw key for computed `o[k]`, or a string literal for `o.k` / `o['k']`.
function memberKeyExpr(member) {
    return member.computed ? member.property
        : (member.property.type === 'Identifier' ? astLiteral(member.property.name) : astLiteral(member.property.value));
}

module.exports = {
    gasCallStatement, gasCallExpr, wrapWithGas, callStatement, wrapDepthGuard,
    directivePrologueLength, insertGasAfterDirectives, ensureBlock, binaryDepth,
    astIdent, astLiteral, astArray, astCall, cloneNode, astVoid0, arrowThunk, memberKeyExpr
};
