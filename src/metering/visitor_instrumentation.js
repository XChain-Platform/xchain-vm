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
 * XChain VM: metering visitor instrumentation (gas injection phases 1-4)
 ********************************************************************/
// @ts-nocheck

const walk = require('acorn-walk');
const {
    gasCallStatement, gasCallExpr, wrapWithGas, wrapDepthGuard,
    insertGasAfterDirectives, ensureBlock, binaryDepth
} = require('./ast_builders.js');
const { HELPER_SET } = require('./reserved_identifiers.js');

const functionEntryVisitors = {
    // Function declarations and expressions: inject at entry
    FunctionDeclaration(node) {
        if (node.body && node.body.type === 'BlockStatement')
            insertGasAfterDirectives(node.body.body);
    },
    FunctionExpression(node) {
        if (node.body && node.body.type === 'BlockStatement')
            insertGasAfterDirectives(node.body.body);
    },
    ArrowFunctionExpression(node) {
        if (node.body.type === 'BlockStatement') {
            insertGasAfterDirectives(node.body.body);
        } else {
            // Expression body: () => expr  ->  () => (__gas(1), expr)
            node.body = wrapWithGas(node.body);
        }
    }
};

function chargeLoopBody(node) {
    ensureBlock(node, 'body');
    node.body.body.unshift(gasCallStatement());
}

// Loops: inject per iteration
const loopVisitors = {
    ForStatement(node) {
        chargeLoopBody(node);
        // Inject into update expression
        if (node.update) {
            node.update = {
                type: 'SequenceExpression',
                expressions: [gasCallExpr(), node.update]
            };
        } else {
            node.update = gasCallExpr();
        }
    },
    WhileStatement: chargeLoopBody,
    DoWhileStatement: chargeLoopBody,
    ForInStatement: chargeLoopBody,
    ForOfStatement: chargeLoopBody
};

function branchVisitors(processed) {
    return {
        // Conditionals
        IfStatement(node) {
            ensureBlock(node, 'consequent');
            node.consequent.body.unshift(gasCallStatement());
            if (node.alternate) {
                if (node.alternate.type === 'IfStatement') {
                    // else-if chain: will be handled when that IfStatement is visited
                } else {
                    ensureBlock(node, 'alternate');
                    node.alternate.body.unshift(gasCallStatement());
                }
            }
        },

        // Switch cases
        SwitchCase(node) {
            if (node.consequent.length > 0)
                node.consequent.unshift(gasCallStatement());
        },

        // Try/catch/finally
        TryStatement(node) {
            if (node.block && node.block.body)
                node.block.body.unshift(gasCallStatement());
            if (node.handler && node.handler.body && node.handler.body.body)
                node.handler.body.body.unshift(gasCallStatement());
            if (node.finalizer && node.finalizer.body)
                node.finalizer.body.unshift(gasCallStatement());
        },

        // Ternary operators: wrap test with gas
        ConditionalExpression(node) {
            if (!processed.has(node)) {
                processed.add(node);
                node.test = wrapWithGas(node.test);
            }
        }
    };
}

// Phase 1: function, loop, branch, try/switch and ternary entry charges.
function injectBlockGas(ast, processed) {
    walk.simple(ast, Object.assign({}, functionEntryVisitors, loopVisitors, branchVisitors(processed)));
}

// Phase 2: charge deeply nested BinaryExpression chains.
function injectBinaryDepthGas(ast, processed) {
    walk.simple(ast, {
        BinaryExpression(node) {
            if (!processed.has(node) && binaryDepth(node) > 10) {
                processed.add(node);
                // Walk up the left chain to depth 10, then inject
                let current = node;
                let depth = 0;
                while (current.left && current.left.type === 'BinaryExpression' && depth < 10) {
                    current = current.left;
                    depth++;
                }
                // Wrap the left operand at depth 10 with gas
                if (current.left) {
                    current.left = wrapWithGas(current.left);
                }
            }
        }
    });
}

// Phase 3: charge before each call expression.
function injectCallGas(ast, processed) {
    walk.ancestor(ast, {
        CallExpression(node, ancestors) {
            if (processed.has(node)) return;
            // Don't inject into our own __gas call or the allocator metering
            // helpers (HELPER_SET, i.e. the ALLOC_HELPERS list above), which
            // already charge by size. Read that list rather than re-enumerating
            // it here; an inline copy has drifted before.
            if (node.callee.type === 'Identifier' &&
                (node.callee.name === '__gas' || HELPER_SET.has(node.callee.name))) return;
            // Don't inject into member calls on __gas (shouldn't exist, but defensive)
            if (node.callee.type === 'MemberExpression' &&
                node.callee.object.type === 'Identifier' &&
                node.callee.object.name === '__gas') return;

            processed.add(node);

            // Find the parent and replace this node with (__gas(1), call)
            const parent = ancestors[ancestors.length - 2];
            if (!parent) return;

            const wrapped = wrapWithGas(node);

            // Replace in parent: check all possible parent node shapes
            for (const key of Object.keys(parent)) {
                if (parent[key] === node) {
                    parent[key] = wrapped;
                    return;
                }
                if (Array.isArray(parent[key])) {
                    const idx = parent[key].indexOf(node);
                    if (idx !== -1) {
                        parent[key][idx] = wrapped;
                        return;
                    }
                }
            }
        }
    });
}

// Phase 4: Deterministic call-depth bounding.
// Wrap every contract function body as:
//     __depth_enter(); try { <body> } finally { __depth_exit(); }
// A native stack overflow (RangeError) fires at an architecture- and
// host-stack-dependent depth; a contract that CATCHES the RangeError can read
// that raw native depth and commit it into hashed state, so two validators on
// different CPUs (or at different host call depths) diverge (fork). The harness
// (src/index.js) enforces a fixed, platform-independent depth limit on these
// enter/exit hooks, throwing a deterministic out_of_stack fault that cannot be
// swallowed, so the maximum depth a contract can ever observe is identical on
// every node. Runs LAST, after all __gas() injection, so the synthetic
// try/finally is not itself gas-metered (depth bounding is gas-free, leaving the
// gas cost of existing contracts unchanged) and the depth hooks are exempt from
// the call-site wrapping above.
function injectDepthGuards(ast) {
    walk.simple(ast, {
        FunctionDeclaration(node) { wrapDepthGuard(node); },
        FunctionExpression(node)  { wrapDepthGuard(node); },
        ArrowFunctionExpression(node) {
            // Convert an expression-bodied arrow to a block returning the
            // expression, so it can carry the enter/try/finally guard.
            if (node.body.type !== 'BlockStatement') {
                node.body = { type: 'BlockStatement',
                    body: [{ type: 'ReturnStatement', argument: node.body }] };
            }
            wrapDepthGuard(node);
        }
    });
}

module.exports = { injectBlockGas, injectBinaryDepthGas, injectCallGas, injectDepthGuards };
