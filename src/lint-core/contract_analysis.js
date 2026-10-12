// Advisory contract analysis: crossCallable, loops, allocations, state reads and input validation.
// @ts-nocheck

const acorn = require('acorn');
const walk  = require('acorn-walk');
const { CONTRACT_ECMA_VERSION } = require('../metering.js');
const { TYPED_ARRAY_CTORS, BULK_ALLOC_METHODS } = require('./constants.js');

function lineOf(node) { return node && node.loc ? node.loc.start.line : null; }

// True if `node` is a call to xchain.state.get(...) / state.get(...). Spots a
// state read whose (possibly null) result is dereferenced without a guard.
function isStateGetCall(node) {
    if (!node || node.type !== 'CallExpression') return false;
    const c = node.callee;
    if (!c || c.type !== 'MemberExpression' || c.computed) return false;
    if (!c.property || c.property.name !== 'get') return false;
    const o = c.object;
    if (!o) return false;
    if (o.type === 'Identifier' && o.name === 'state') return true;       // state.get(...)
    return o.type === 'MemberExpression' && !o.computed && o.property && o.property.name === 'state'; // xchain.state.get(...)
}

// The simple callee name of a call: the identifier (foo(...)) or the dotted member
// property (x.foo(...)). null for computed/complex callees.
function calleeName(node) {
    if (!node || node.type !== 'CallExpression' || !node.callee) return null;
    const c = node.callee;
    if (c.type === 'Identifier') return c.name;
    if (c.type === 'MemberExpression' && !c.computed && c.property) return c.property.name;
    return null;
}

// Locate the `module.exports = { ... }` object literal, returning { obj, methodNames }.
// methodNames = property keys whose value is a function (the contract's callable surface).
function findExportsObject(ast) {
    let obj = null;
    walk.simple(ast, {
        AssignmentExpression(node) {
            if (obj) return;
            const l = node.left;
            const isModuleExports = l && l.type === 'MemberExpression' && !l.computed
                && l.object && l.object.type === 'Identifier' && l.object.name === 'module'
                && l.property && l.property.name === 'exports';
            if (isModuleExports && node.right && node.right.type === 'ObjectExpression')
                obj = node.right;
        }
    });
    const methodNames = new Set();
    if (obj) {
        for (const p of obj.properties) {
            if (p.type !== 'Property' || p.computed) continue;
            const key = p.key && (p.key.name || p.key.value);
            const v = p.value;
            if (key && v && (v.type === 'FunctionExpression' || v.type === 'ArrowFunctionExpression'))
                methodNames.add(String(key));
        }
    }
    return { obj, methodNames };
}

// ── crossCallable integrity ──────────────────────────────────────────
// A non-array crossCallable makes EVERY cross-chain call to this contract
// fail at runtime (XCALL_NOT_CALLABLE, thrown before any code runs); an
// entry naming a non-exported method is a silent typo (that method stays
// uncallable cross-chain).
function checkCrossCallable(obj, methodNames, errors, warnings) {
    if (!obj) return;
    for (const p of obj.properties) {
        if (p.type !== 'Property' || p.computed) continue;
        const key = p.key && (p.key.name || p.key.value);
        if (key !== 'crossCallable') continue;
        const v = p.value;
        if (v && v.type === 'ArrayExpression') {
            for (const el of v.elements) {
                if (el && el.type === 'Literal' && typeof el.value === 'string'
                    && !methodNames.has(el.value)) {
                    warnings.push({
                        rule: 'crossCallable-unknown-method',
                        message: 'crossCallable lists "' + el.value + '" at line ' + lineOf(el) +
                                 ', which is not an exported method (it will be uncallable cross-chain; typo?)',
                        line: lineOf(el),
                        severity: 'warning'
                    });
                }
            }
        } else if (v && v.type !== 'Identifier' && v.type !== 'CallExpression'
                   && v.type !== 'ConditionalExpression' && v.type !== 'LogicalExpression') {
            // Statically a non-array value (Literal/Object/Function/…). Dynamic
            // forms (Identifier/call/etc.) are left alone to avoid false positives.
            errors.push({
                rule: 'crossCallable-not-array',
                message: 'crossCallable must be an array of method names at line ' + lineOf(v) +
                         '; a non-array value makes every cross-chain call to this contract fail (XCALL_NOT_CALLABLE)',
                line: lineOf(v),
                severity: 'error'
            });
        }
    }
}

// ── unbounded-loop ───────────────────────────────────────────────────
// Structurally unbounded loops (while(true) / for(;;) / do…while(true)).
// The gas ceiling still bounds them at runtime; this is an advisory that
// termination rests entirely on an internal break.
function checkUnboundedLoops(ast, warnings) {
    const isTrue = (t) => t && t.type === 'Literal' && t.value === true;
    function pushUnbounded(n) {
        warnings.push({
            rule: 'unbounded-loop',
            message: 'unbounded loop at line ' + lineOf(n) +
                     '; termination depends entirely on an internal break (the gas ceiling will halt it otherwise)',
            line: lineOf(n),
            severity: 'warning'
        });
    }
    walk.simple(ast, {
        WhileStatement(n)   { if (isTrue(n.test)) pushUnbounded(n); },
        DoWhileStatement(n) { if (isTrue(n.test)) pushUnbounded(n); },
        ForStatement(n)     { if (n.test === null || n.test === undefined) pushUnbounded(n); }
    });
}

// ── large-allocation ─────────────────────────────────────────────────
// Bulk allocations the VM gas-meters at runtime; flagged so authors keep
// the size bounded (an input-sized allocation can hit the gas ceiling).
function checkLargeAllocations(ast, warnings) {
    function pushAlloc(n, what) {
        warnings.push({
            rule: 'large-allocation',
            message: 'bulk allocation (' + what + ') at line ' + lineOf(n) +
                     '; gas-metered at runtime, keep the size bounded so it cannot hit the gas ceiling',
            line: lineOf(n),
            severity: 'warning'
        });
    }
    walk.simple(ast, {
        NewExpression(n) {
            if (n.callee && n.callee.type === 'Identifier' && TYPED_ARRAY_CTORS.has(n.callee.name))
                pushAlloc(n, n.callee.name);
        },
        CallExpression(n) {
            if (n.callee && n.callee.type === 'Identifier' && n.callee.name === 'Array')
                pushAlloc(n, 'Array');
            else if (n.callee && n.callee.type === 'MemberExpression' && !n.callee.computed
                     && n.callee.property && BULK_ALLOC_METHODS.has(n.callee.property.name))
                pushAlloc(n, '.' + n.callee.property.name + '()');
        }
    });
}

// ── unchecked-state-get ──────────────────────────────────────────────
// A state.get(...) result dereferenced directly. state.get returns null for
// an absent key, so `state.get('k').foo` throws on a missing key. Guard with
// a default (`|| '0'`) or a require() first.
function checkUncheckedStateGet(ast, warnings) {
    function pushUnchecked(n) {
        warnings.push({
            rule: 'unchecked-state-get',
            message: 'state.get(...) result dereferenced at line ' + lineOf(n) +
                     ' without a null guard; an absent key returns null and will throw. Default it (e.g. `|| \'0\'`) or require() it first',
            line: lineOf(n),
            severity: 'warning'
        });
    }
    walk.simple(ast, {
        MemberExpression(n) { if (isStateGetCall(n.object)) pushUnchecked(n); }
    });
}

// ── missing-input-validation ─────────────────────────────────────────
// An exported method that reads call inputs (getInputParam) but contains no
// require() check, likely accepting unvalidated input.
function checkMissingInputValidation(obj, warnings) {
    if (!obj) return;
    for (const p of obj.properties) {
        if (p.type !== 'Property' || p.computed) continue;
        const v = p.value;
        if (!v || (v.type !== 'FunctionExpression' && v.type !== 'ArrowFunctionExpression')) continue;
        let readsInput = false, hasRequire = false;
        walk.simple(v, {
            CallExpression(c) {
                const n = calleeName(c);
                if (n === 'getInputParam') readsInput = true;
                // Any require()/require*-named call counts as validation. This
                // covers xchain.require AND helper guards (requirePositive,
                // requireAddress, requireStatus, …) so delegating validation to
                // a helper is not flagged as missing.
                if (n && (n === 'require' || n.indexOf('require') === 0)) hasRequire = true;
            }
        });
        if (readsInput && !hasRequire) {
            const key = p.key && (p.key.name || p.key.value);
            warnings.push({
                rule: 'missing-input-validation',
                message: 'method "' + key + '" at line ' + lineOf(v) +
                         ' reads input params but has no require() validation; validate inputs before use',
                line: lineOf(v),
                severity: 'warning'
            });
        }
    }
}

// Move 2 analysis. Returns { errors, warnings } of {rule,message,line,severity}.
// Fully defensive: any parse/walk failure yields no findings rather than throwing
// into lintSource (and therefore the deploy path).
function analyzeContract(code) {
    const errors = [];
    const warnings = [];
    let ast;
    try {
        ast = acorn.parse(code, { ecmaVersion: CONTRACT_ECMA_VERSION, sourceType: 'script', locations: true });
    } catch (e) {
        return { errors, warnings };
    }

    try {
        const { obj, methodNames } = findExportsObject(ast);
        checkCrossCallable(obj, methodNames, errors, warnings);
        checkUnboundedLoops(ast, warnings);
        checkLargeAllocations(ast, warnings);
        checkUncheckedStateGet(ast, warnings);
        checkMissingInputValidation(obj, warnings);
    } catch (e) {
        // Any detector failure -> drop Move-2 findings; never break lintSource.
        return { errors, warnings };
    }

    return { errors, warnings };
}

module.exports = { analyzeContract };
