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
 * XChain VM: metering frame weight
 *
 * A function's native stack frame grows with its register file: one slot
 * per parameter and local, plus the temporaries an expression holds while
 * a nested part is evaluated (every argument of a call sits in its own
 * slot until the call is made). The depth counter charged one unit per
 * call whatever the frame size, so a function with hundreds of locals ran
 * out of native stack in a few dozen frames, at a depth that moves with
 * the node's stack size, long before the counter could trip.
 *
 * frameWeight() turns a function's AST into a whole number of depth units
 * from an over-estimate of its slot count, so the counter, not the native
 * stack, is what a deep chain of large frames reaches first. The estimate
 * is a pure function of the AST, so every node computes the same weight.
 * The constants are consensus values: changing one moves the depth at
 * which an execution settles out_of_stack.
 ********************************************************************/
// @ts-nocheck

// Slots one depth unit covers. Measured native frames cost about 150 bytes
// plus 9 bytes per slot, so a 1-unit frame stays under 450 bytes and a
// w-unit frame under 450*w bytes; at the 256-unit budget that is under 120
// KB of contract frames against the 400 KB the smallest supported
// --stack-size gives, leaving room for host entry, harness wrappers and the
// native sinks the structural-depth guard bounds.
const SLOTS_PER_UNIT = 32;
// Registers every frame holds beyond its locals: closure, context, receiver,
// new.target, the accumulator spill, and the depth guard's own try/catch/finally
// (context, token, result), which is added after the weight is taken.
const FIXED_SLOTS = 8;
// Extra registers a statement holds across its body (V8 keeps the iterator,
// the enumeration cache or the try context live while the body runs).
const STATEMENT_HOLD = {
    TryStatement: 3,
    ForInStatement: 6,
    ForOfStatement: 6,
    SwitchStatement: 2,
    ForStatement: 1,
    WhileStatement: 1,
    DoWhileStatement: 1,
    LabeledStatement: 0
};
// Nodes whose children run one after another with nothing held between them.
const SEQUENTIAL = new Set(['Program', 'BlockStatement', 'StaticBlock', 'VariableDeclaration',
    'IfStatement', 'ExpressionStatement', 'ReturnStatement', 'ThrowStatement', 'SwitchCase',
    'CatchClause', 'EmptyStatement', 'BreakStatement', 'ContinueStatement', 'DebuggerStatement']);

function isFunctionNode(node) {
    return node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' ||
        node.type === 'ArrowFunctionExpression';
}

// The child nodes of `node` in source (evaluation) order.
function childrenOf(node) {
    const out = [];
    const keys = Object.keys(node);
    for (let k = 0; k < keys.length; k++) {
        const key = keys[k];
        if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue;
        const child = node[key];
        if (Array.isArray(child)) {
            for (let i = 0; i < child.length; i++) {
                if (child[i] && typeof child[i].type === 'string') out.push(child[i]);
            }
        } else if (child && typeof child.type === 'string') {
            out.push(child);
        }
    }
    return out;
}

// Upper bound on the temporaries live at once while `node` evaluates. A nested
// function is one closure slot here: its own frame is weighed on its own.
function demand(node) {
    if (isFunctionNode(node)) return 1;
    const kids = childrenOf(node);
    let most = 0;
    if (SEQUENTIAL.has(node.type) || Object.prototype.hasOwnProperty.call(STATEMENT_HOLD, node.type)) {
        for (let i = 0; i < kids.length; i++) most = Math.max(most, demand(kids[i]));
        return most + (STATEMENT_HOLD[node.type] || 0);
    }
    // An expression holds each earlier operand while a later one is evaluated.
    for (let i = 0; i < kids.length; i++) most = Math.max(most, i + demand(kids[i]));
    if (node.type === 'CallExpression' || node.type === 'NewExpression') {
        // Receiver, callee and every argument sit in consecutive registers.
        most = Math.max(most, (node.arguments ? node.arguments.length : 0) + 2);
    }
    return most + 1;
}

// Count the names a pattern binds.
function patternNames(pat) {
    if (!pat) return 0;
    switch (pat.type) {
        case 'Identifier': return 1;
        case 'AssignmentPattern': return patternNames(pat.left);
        case 'RestElement': return patternNames(pat.argument);
        case 'ArrayPattern': return pat.elements.reduce(function (n, e) { return n + patternNames(e); }, 0);
        case 'ObjectPattern': return pat.properties.reduce(function (n, p) {
            return n + patternNames(p.type === 'RestElement' ? p : p.value);
        }, 0);
        default: return 0;
    }
}

// Count the locals a function body declares, without entering nested functions
// (a nested function DECLARATION's name is still a local of this frame).
function localCount(node) {
    let n = 0;
    (function visit(x) {
        if (x.type === 'VariableDeclarator') n += patternNames(x.id);
        else if (x.type === 'CatchClause') n += patternNames(x.param);
        else if ((x.type === 'FunctionDeclaration' || x.type === 'ClassDeclaration') && x.id) n += 1;
        if (isFunctionNode(x)) return;
        const kids = childrenOf(x);
        for (let i = 0; i < kids.length; i++) visit(kids[i]);
    })({ type: 'BlockStatement', body: Array.isArray(node.body) ? node.body : [node.body] });
    return n;
}

/**
 * Depth units a call to this function charges: 1 for an ordinary frame, one
 * more for every SLOTS_PER_UNIT slots of parameters, locals and temporaries.
 * `fn` is a function node, or a Program for the top-level script.
 * @param {object} fn
 * @returns {number}
 */
function frameWeight(fn) {
    const params = fn.params ? fn.params.reduce(function (n, p) { return n + patternNames(p) + 1; }, 0) : 0;
    const bodyNode = fn.type === 'Program' ? fn : fn.body;
    const slots = FIXED_SLOTS + params + localCount(bodyNode) + demand(bodyNode);
    return 1 + Math.floor(slots / SLOTS_PER_UNIT);
}

module.exports = { frameWeight, SLOTS_PER_UNIT, FIXED_SLOTS };
