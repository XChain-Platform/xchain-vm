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
 * XChain VM: metering instrumentation that hands caught errors to the meter
 *
 * V8 throws a catchable RangeError when the native stack runs out, at a
 * depth that moves with the node's --stack-size, its host stack use at
 * entry and its JIT tier. A contract that catches it, or lets a finally
 * block discard it with return, break or continue, can carry on and commit
 * how deep it got. Under the native stack activation every catch clause
 * and every finally block passes the in-flight value to the meter's
 * existing leading __gas(1) charge as a second argument, and the harness
 * turns a native stack overflow into the same un-swallowable fault the
 * depth counter raises. The charge stays 1 gas, so gasUsed is unchanged.
 *
 *   try { B } catch (p) { H }            try { __gas(1); B } catch (p) { __gas(1, p); H }
 *
 *   try { B } [catch (p) { H }]          { let F;
 *   finally { Z }                    ->    try { try { __gas(1); B } [catch (p) { __gas(1, p); H }] }
 *                                          catch (X) { F = X; throw X; }
 *                                          finally { __gas(1, F); Z } }
 *
 * The synthetic catch records the in-flight value with no call, so it cannot
 * itself run out of stack; the finally checks it before any contract code in
 * Z runs. A catch with no binding or with a destructuring pattern binds X and
 * destructures inside the block after the check, so a pattern default cannot
 * replace the overflow before it is seen. F and X are names the contract
 * source does not use.
 ********************************************************************/
// @ts-nocheck

const walk = require('acorn-walk');
const { gasCallStatement, astIdent } = require('./ast_builders.js');

// __gas(1, <name>) as a statement.
function gasCheckStatement(name) {
    const stmt = gasCallStatement();
    stmt.expression.arguments.push(astIdent(name));
    return stmt;
}

function letDeclaration(id, init) {
    return { type: 'VariableDeclaration', kind: 'let',
        declarations: [{ type: 'VariableDeclarator', id: id, init: init || null }] };
}

// Pick a name no identifier in the contract source uses.
function freshName(used, base) {
    let name = base;
    while (used.has(name)) name += '_';
    return name;
}

/**
 * The local names the armed rewrites bind (caught value, finally flag, depth
 * guard token), chosen against every identifier in the parsed source.
 * @param {object} ast
 * @returns {{caught: string, flag: string, token: string}}
 */
function chooseNames(ast) {
    const used = new Set();
    walk.full(ast, function (node) { if (node.type === 'Identifier') used.add(node.name); });
    return { caught: freshName(used, '__gasx'), flag: freshName(used, '__gasf'), token: freshName(used, '__gasd') };
}

// Make the handler's first statement hand its caught value to the meter.
function armHandler(handler, names) {
    const param = handler.param;
    if (param && param.type === 'Identifier') {
        handler.body.body.unshift(gasCheckStatement(param.name));
        return;
    }
    handler.param = astIdent(names.caught);
    if (param) handler.body.body.unshift(letDeclaration(param, astIdent(names.caught)));
    handler.body.body.unshift(gasCheckStatement(names.caught));
}

/**
 * Armed replacement for the legacy TryStatement charge (one __gas(1) at the top
 * of the block, the handler and the finalizer). Mutates `node` in place; a try
 * with a finalizer becomes a block holding the rewrite shown above.
 * @param {object} node - TryStatement
 * @param {{caught: string, flag: string}} names
 */
function armTryStatement(node, names) {
    node.block.body.unshift(gasCallStatement());
    if (node.handler) armHandler(node.handler, names);
    if (!node.finalizer) return;
    const guarded = node.handler
        ? { type: 'BlockStatement', body: [{ type: 'TryStatement', block: node.block, handler: node.handler, finalizer: null }] }
        : node.block;
    const record = {
        type: 'CatchClause',
        param: astIdent(names.caught),
        body: { type: 'BlockStatement', body: [
            { type: 'ExpressionStatement', expression: { type: 'AssignmentExpression', operator: '=',
                left: astIdent(names.flag), right: astIdent(names.caught) } },
            { type: 'ThrowStatement', argument: astIdent(names.caught) }
        ] }
    };
    const finalizer = node.finalizer;
    finalizer.body.unshift(gasCheckStatement(names.flag));
    const outer = { type: 'TryStatement', block: guarded, handler: record, finalizer: finalizer };
    delete node.block; delete node.handler; delete node.finalizer;
    node.type = 'BlockStatement';
    node.body = [letDeclaration(astIdent(names.flag)), outer];
}

module.exports = { armTryStatement, chooseNames };
