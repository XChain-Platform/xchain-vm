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
 * test/helpers/suite_registration.js
 *
 * Static check behind test/preflight.test.js: finds suite files and decides
 * from the AST whether a suite registers any test when it loads.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');

// `node --test` and mocha both count a suite file with zero test()/it() calls
// as one passing test, so a suite whose cases are dead (never reached) still
// reads green. Detect registration calls only on paths that execute when the
// suite loads.
const SUITE_ROOT = path.join(__dirname, '..', '..');
const SUITE_FILE_RE = /\.(test|fuzz)\.js$/;
const KNOWN_EMPTY_SUITES = new Set();
const REGISTRATION_NAMES = new Set(['it', 'test']);
const CONTAINER_NAMES = new Set(['describe', 'context', 'suite']);
const SKIP_SUFFIXES = new Set(['only', 'skip', 'todo']);

// Resolves a callee to every (identifier | object.property) form it could
// take: a ternary callee (`cond ? it : it.skip`, this repo's engine-gate
// idiom) resolves to the union of both branches.
function calleeForms(node) {
    if (!node) return [];
    if (node.type === 'Identifier') return [{ kind: 'id', name: node.name }];
    if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier') {
        const objForms = calleeForms(node.object).filter((f) => f.kind === 'id');
        const objectName = objForms.length === 1 ? objForms[0].name : null;
        return [{ kind: 'member', objectName, prop: node.property.name }];
    }
    if (node.type === 'ConditionalExpression') return calleeForms(node.consequent).concat(calleeForms(node.alternate));
    return [];
}

function isRegistrationCallee(callee) {
    return calleeForms(callee).some((f) => (f.kind === 'id' && REGISTRATION_NAMES.has(f.name))
        || (f.kind === 'member' && REGISTRATION_NAMES.has(f.objectName) && SKIP_SUFFIXES.has(f.prop)));
}

// `.forEach` covers this repo's `rows.forEach((row) => it(...))` case-table idiom.
function isContainerCallee(callee) {
    return calleeForms(callee).some((f) => (f.kind === 'id' && CONTAINER_NAMES.has(f.name))
        || (f.kind === 'member' && CONTAINER_NAMES.has(f.objectName) && SKIP_SUFFIXES.has(f.prop))
        || (f.kind === 'member' && f.prop === 'forEach'));
}

function isFunctionNode(node) {
    return !!node && (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression');
}

// Literal-only: an unresolvable condition returns undefined so both branches
// stay reachable; this only prunes provably dead code.
function staticBooleanValue(node) {
    if (!node) return undefined;
    if (node.type === 'Literal') {
        if (typeof node.value === 'boolean') return node.value;
        if (typeof node.value === 'number') return node.value !== 0;
        if (typeof node.value === 'string') return node.value !== '';
        return undefined;
    }
    if (node.type === 'UnaryExpression' && node.operator === '!') {
        const inner = staticBooleanValue(node.argument);
        return inner === undefined ? undefined : !inner;
    }
    return undefined;
}

// Named functions are reachable only via a call site found elsewhere, so
// their bodies are collected up front and enqueued on demand.
function collectNamedFunctions(root) {
    const defs = new Map();
    const pending = [root];
    while (pending.length > 0) {
        const node = pending.pop();
        if (!node || typeof node.type !== 'string') continue;
        if (node.type === 'FunctionDeclaration' && node.id) defs.set(node.id.name, node);
        else if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && isFunctionNode(node.init)) defs.set(node.id.name, node.init);
        else if (node.type === 'AssignmentExpression' && node.left.type === 'Identifier' && isFunctionNode(node.right)) defs.set(node.left.name, node.right);
        for (const value of Object.values(node)) {
            if (Array.isArray(value)) { for (const c of value) if (c && typeof c.type === 'string') pending.push(c); }
            else if (value && typeof value.type === 'string') pending.push(value);
        }
    }
    return defs;
}

// A statement that is guaranteed to exit its block makes later siblings dead;
// an if/else counts only when every branch it can still take does.
function alwaysTerminates(stmt) {
    switch (stmt.type) {
        case 'ReturnStatement': case 'ThrowStatement': case 'BreakStatement': case 'ContinueStatement':
            return true;
        case 'BlockStatement':
            return stmt.body.some(alwaysTerminates);
        case 'IfStatement': {
            const cond = staticBooleanValue(stmt.test);
            if (cond === true) return alwaysTerminates(stmt.consequent);
            if (cond === false) return !!stmt.alternate && alwaysTerminates(stmt.alternate);
            return !!stmt.alternate && alwaysTerminates(stmt.consequent) && alwaysTerminates(stmt.alternate);
        }
        default:
            return false;
    }
}

// A try block "cannot throw" when its body holds no call, property access,
// throw, await or yield; a catch behind one is dead code, since its try
// never raises. Conservative by construction: anything not provably safe
// counts as throwing, so a live catch is never marked dead by mistake.
const THROW_PRONE = new Set(['CallExpression', 'NewExpression', 'MemberExpression', 'ThrowStatement', 'AwaitExpression', 'YieldExpression']);
function blockCanThrow(node) {
    const pending = [node];
    while (pending.length > 0) {
        const cur = pending.pop();
        if (!cur || typeof cur.type !== 'string') continue;
        if (THROW_PRONE.has(cur.type)) return true;
        for (const value of Object.values(cur)) {
            if (Array.isArray(value)) { for (const c of value) if (c && typeof c.type === 'string') pending.push(c); }
            else if (value && typeof value.type === 'string') pending.push(value);
        }
    }
    return false;
}

// A live Logical/Conditional pushes only the operands that provably still
// run; an unresolvable condition pushes both.
function pushShortCircuited(current, pending) {
    if (current.type === 'LogicalExpression') {
        const leftValue = staticBooleanValue(current.left);
        const rightDead = (current.operator === '&&' && leftValue === false) || (current.operator === '||' && leftValue === true);
        pending.push(current.left);
        if (!rightDead) pending.push(current.right);
        return true;
    }
    if (current.type === 'ConditionalExpression') {
        const testValue = staticBooleanValue(current.test);
        pending.push(current.test);
        if (testValue !== false) pending.push(current.consequent);
        if (testValue !== true) pending.push(current.alternate);
        return true;
    }
    return false;
}

function pushCallTargets(current, ctx) {
    if (isRegistrationCallee(current.callee)) return true;
    if (isFunctionNode(current.callee)) ctx.enqueue(current.callee);
    if (current.callee.type === 'Identifier' && ctx.namedFunctions.has(current.callee.name)) ctx.enqueue(ctx.namedFunctions.get(current.callee.name));
    if (isContainerCallee(current.callee)) {
        for (const arg of current.arguments) {
            if (isFunctionNode(arg)) ctx.enqueue(arg);
            else if (arg.type === 'Identifier' && ctx.namedFunctions.has(arg.name)) ctx.enqueue(ctx.namedFunctions.get(arg.name));
        }
    }
    return false;
}

// Walks one expression subtree for a live registration call. A function node
// found here is never descended into directly; it becomes live only via
// pushCallTargets's enqueue, keeping an uninvoked callback body out of the search.
function walkExpression(node, ctx) {
    const pending = [node];
    while (pending.length > 0) {
        const current = pending.pop();
        if (!current || typeof current.type !== 'string') continue;
        if (current.type === 'CallExpression' && pushCallTargets(current, ctx)) return true;
        if (isFunctionNode(current)) continue;
        if (pushShortCircuited(current, pending)) continue;
        for (const value of Object.values(current)) {
            if (Array.isArray(value)) { for (const c of value) if (c && typeof c.type === 'string') pending.push(c); }
            else if (value && typeof value.type === 'string') pending.push(value);
        }
    }
    return false;
}

function walkStatements(statements, ctx) {
    for (const stmt of statements) {
        if (walkStatement(stmt, ctx)) return true;
        if (alwaysTerminates(stmt)) break;
    }
    return false;
}

function walkIf(stmt, ctx) {
    const cond = staticBooleanValue(stmt.test);
    if (cond === true) return walkStatement(stmt.consequent, ctx);
    if (cond === false) return stmt.alternate ? walkStatement(stmt.alternate, ctx) : false;
    if (walkStatement(stmt.consequent, ctx)) return true;
    return stmt.alternate ? walkStatement(stmt.alternate, ctx) : false;
}

// Statement-level reachability. A function/class declaration does not run
// its body by being declared; a statically-false if/while/for prunes that
// branch; a try's catch is walked only when its try block can throw.
function walkStatement(stmt, ctx) {
    switch (stmt.type) {
        case 'BlockStatement':
            return walkStatements(stmt.body, ctx);
        case 'IfStatement':
            return walkIf(stmt, ctx);
        case 'ForStatement': case 'WhileStatement':
            return staticBooleanValue(stmt.test) === false ? false : walkStatement(stmt.body, ctx);
        case 'DoWhileStatement': case 'ForInStatement': case 'ForOfStatement':
            return walkStatement(stmt.body, ctx);
        case 'TryStatement': {
            const handlerLive = !!stmt.handler && blockCanThrow(stmt.block) && walkStatements(stmt.handler.body.body, ctx);
            return walkStatements(stmt.block.body, ctx) || handlerLive || (!!stmt.finalizer && walkStatements(stmt.finalizer.body, ctx));
        }
        case 'SwitchStatement':
            return stmt.cases.some((c) => walkStatements(c.consequent, ctx));
        case 'LabeledStatement':
            return walkStatement(stmt.body, ctx);
        case 'ExpressionStatement':
            return walkExpression(stmt.expression, ctx);
        case 'VariableDeclaration':
            return stmt.declarations.some((decl) => decl.init && walkExpression(decl.init, ctx));
        default:
            return false;
    }
}

function walkContainer(container, ctx) {
    if (container.type === 'Program') return walkStatements(container.body, ctx);
    const body = container.body;
    return body.type === 'BlockStatement' ? walkStatements(body.body, ctx) : walkExpression(body, ctx);
}

// True only when no describe/it/test call is reachable at require time: dead
// code (past a guaranteed terminator, behind a statically-false branch, or a
// never-invoked function body) is excluded, matching what actually runs.
function registersNoTests(src) {
    const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true });
    const queue = [ast];
    const ctx = {
        namedFunctions: collectNamedFunctions(ast),
        queued: new Set(queue),
        enqueue(container) {
            if (ctx.queued.has(container)) return;
            ctx.queued.add(container);
            queue.push(container);
        },
    };
    while (queue.length > 0) {
        if (walkContainer(queue.shift(), ctx)) return false;
    }
    return true;
}

function assertSuiteRegistersTest(src, label) {
    assert.ok(!registersNoTests(src), label + ' registers zero tests');
}

function suiteFiles(suiteRoot = SUITE_ROOT) {
    const files = [];
    const pending = [path.join(suiteRoot, 'test')];
    while (pending.length > 0) {
        const dir = pending.pop();
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const absolute = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                pending.push(absolute);
            } else if ((entry.isFile() || entry.isSymbolicLink()) && SUITE_FILE_RE.test(entry.name)) {
                files.push(path.relative(suiteRoot, absolute).split(path.sep).join('/'));
            }
        }
    }
    return files.sort();
}

// Builds a throwaway tree holding an untracked nested suite plus a non-suite
// helper, and asserts the walk returns only the suite.
function assertWalkFindsUntrackedNestedSuite() {
    const scratchRoot = path.join(SUITE_ROOT, 'tmp');
    fs.mkdirSync(scratchRoot, { recursive: true });
    const fixtureRoot = fs.mkdtempSync(path.join(scratchRoot, 'preflight-suite-walk-'));
    try {
        const nestedTestDir = path.join(fixtureRoot, 'test', 'nested');
        fs.mkdirSync(nestedTestDir, { recursive: true });
        fs.writeFileSync(path.join(nestedTestDir, 'untracked.test.js'), 'it("runs", function() {});\n');
        fs.writeFileSync(path.join(nestedTestDir, 'helper.js'), 'module.exports = {};\n');

        assert.deepStrictEqual(suiteFiles(fixtureRoot), ['test/nested/untracked.test.js']);
    } finally {
        fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
}

module.exports = {
    SUITE_ROOT,
    KNOWN_EMPTY_SUITES,
    registersNoTests,
    assertSuiteRegistersTest,
    suiteFiles,
    assertWalkFindsUntrackedNestedSuite,
};
