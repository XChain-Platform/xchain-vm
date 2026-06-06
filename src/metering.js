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
 * XChain VM — AST-Based Gas Metering
 *
 * Transforms contract source code by injecting __gas(1) calls at
 * control flow points. This enables deterministic gas metering
 * without modifying V8 internals.
 *
 * Uses acorn to parse, modifies the AST in place, then regenerates
 * source via astring. This avoids fragile string offset splicing.
 ********************************************************************/
// @ts-nocheck

// 


const acorn = require('acorn');
const walk  = require('acorn-walk');
const { generate } = require('astring');

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

/**
 * Transform contract source code by injecting gas metering calls.
 * @param {string} source - Original contract source code
 * @returns {string} Transformed source with __gas(1) calls injected
 */
function meterCode(source) {
    const ast = acorn.parse(source, {
        ecmaVersion: 2020,
        sourceType: 'script',
        locations: true
    });

    // Track nodes we've already processed to avoid double-injection
    const processed = new WeakSet();

    // Charge gas at the top-level script entry point. The metered source runs
    // as a function body (new __Fn(..., meteredCode)), so top-level statements —
    // variable declarations, object-literal initializers, plain assignments —
    // would otherwise execute uncharged unless they happen to contain a call.
    // Inject after any directive prologue, exactly as function bodies are handled.
    insertGasAfterDirectives(ast.body);

    // Phase 1: Inject into function bodies, loop bodies, try/switch/if blocks
    walk.simple(ast, {
        // Function declarations and expressions — inject at entry
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
                // Expression body: () => expr  →  () => (__gas(1), expr)
                node.body = wrapWithGas(node.body);
            }
        },

        // Loops — inject per iteration
        ForStatement(node) {
            ensureBlock(node, 'body');
            node.body.body.unshift(gasCallStatement());
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
        WhileStatement(node) {
            ensureBlock(node, 'body');
            node.body.body.unshift(gasCallStatement());
        },
        DoWhileStatement(node) {
            ensureBlock(node, 'body');
            node.body.body.unshift(gasCallStatement());
        },
        ForInStatement(node) {
            ensureBlock(node, 'body');
            node.body.body.unshift(gasCallStatement());
        },
        ForOfStatement(node) {
            ensureBlock(node, 'body');
            node.body.body.unshift(gasCallStatement());
        },

        // Conditionals
        IfStatement(node) {
            ensureBlock(node, 'consequent');
            node.consequent.body.unshift(gasCallStatement());
            if (node.alternate) {
                if (node.alternate.type === 'IfStatement') {
                    // else-if chain — will be handled when that IfStatement is visited
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

        // Ternary operators — wrap test with gas
        ConditionalExpression(node) {
            if (!processed.has(node)) {
                processed.add(node);
                node.test = wrapWithGas(node.test);
            }
        }
    });

    // Phase 2: Inject into deeply nested BinaryExpressions
    // Walk the full AST and wrap the left operand at depth > 10
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

    // Phase 3: Inject before call expressions
    // We walk the full AST and wrap CallExpression nodes in their parent context
    walk.ancestor(ast, {
        CallExpression(node, ancestors) {
            if (processed.has(node)) return;
            // Don't inject into our own __gas calls
            if (node.callee.type === 'Identifier' && node.callee.name === '__gas') return;
            // Don't inject into member calls on __gas (shouldn't exist, but defensive)
            if (node.callee.type === 'MemberExpression' &&
                node.callee.object.type === 'Identifier' &&
                node.callee.object.name === '__gas') return;

            processed.add(node);

            // Find the parent and replace this node with (__gas(1), call)
            const parent = ancestors[ancestors.length - 2];
            if (!parent) return;

            const wrapped = wrapWithGas(node);

            // Replace in parent — check all possible parent node shapes
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

    return generate(ast);
}

/**
 * Check if source code contains the reserved __gas identifier.
 * @param {string} source - Contract source code
 * @returns {boolean} true if __gas identifier is found
 */
function hasGasIdentifier(source) {
    try {
        const ast = acorn.parse(source, {
            ecmaVersion: 2020,
            sourceType: 'script'
        });
        let found = false;
        // walk.full visits every node in the AST including nested Identifiers
        walk.full(ast, (node) => {
            if (node.type === 'Identifier' && node.name === '__gas') found = true;
        });
        return found;
    } catch (e) {
        // If parsing fails, let validateSyntax handle it
        return false;
    }
}

module.exports = { meterCode, hasGasIdentifier };
