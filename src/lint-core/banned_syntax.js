// Banned-syntax scanners: Math, size, prototype methods, exponentiation, control bindings, literals, rest patterns, floats.
// @ts-nocheck

const acorn = require('acorn');
const walk  = require('acorn-walk');
const { CONTRACT_ECMA_VERSION } = require('../metering.js');
const {
    BANNED_MATH_MEMBERS,
    SAFE_MATH_MEMBERS,
    RESERVED_CONTROL_BINDINGS,
    STRIPPED_PROTO_METHOD_NAMES,
    REGEX_COERCING_METHODS
} = require('./constants.js');
const { isMathObjectRef, staticComputedKey } = require('./scope_analysis.js');

/**
 * Scan contract code for references to banned transcendental Math members
 * (Math.sqrt / Math.pow / Math.log / Math.log2 / Math.log10), in dotted
 * (Math.pow), computed-string (Math['pow'] / Math[`pow`]), and
 * globalThis-qualified (globalThis.Math.pow, globalThis['Math'].pow) forms, plus
 * (under LINT_GLOBAL_ALIAS, `aliased`) the widened global-object spellings
 * this.Math.pow and globalThis.globalThis.Math.pow.
 *
 * Under VM_LINT_HARDENING (`hardened`), the ban derives from the COMPLEMENT of
 * the sandbox's SAFE_MATH_MEMBERS whitelist: every statically-resolvable Math
 * member outside it (Math.random included) is rejected at deploy, matching what
 * the sandbox actually exposes, instead of failing only at runtime.
 *
 * @param {string} code - Contract source code
 * @param {boolean} [hardened=true] - VM_LINT_HARDENING consensus flag
 * @param {boolean} [aliased=true] - LINT_GLOBAL_ALIAS consensus flag: also count
 *        sloppy-mode `this` and the `globalThis.globalThis...` self-reference
 *        chain as the global object qualifying `Math`, exactly as banned-async
 *        and banned-wasm already do. Defaults to true for author-facing callers
 *        (SDK linter, CLI, unit tests), as the sibling scanners do.
 * @param {boolean} [optionalChain=true] - LINT_OPTIONAL_CHAIN consensus flag
 * @returns {Array<{name: string, line: (number|string), transcendental: boolean}>}
 */
function findBannedMathCalls(code, hardened, aliased, optionalChain) {
    if (hardened === undefined) hardened = true;
    if (aliased === undefined) aliased = true;
    if (optionalChain === undefined) optionalChain = true;
    const hits = [];
    let ast;
    try {
        ast = acorn.parse(code, {
            ecmaVersion: CONTRACT_ECMA_VERSION,
            sourceType: 'script',
            locations: true
        });
    } catch (e) {
        // Parse failure; validateSyntax's earlier checks would have caught this.
        return hits;
    }
    walk.simple(ast, {
        MemberExpression(node) {
            if (!isMathObjectRef(node.object, aliased, optionalChain)) return;
            let member = null;
            if (!node.computed && node.property && node.property.type === 'Identifier') {
                member = node.property.name;                 // Math.pow
            } else if (node.computed) {
                member = staticComputedKey(node);             // Math['pow'] / Math[`pow`]
            }
            if (!member) return;
            if (BANNED_MATH_MEMBERS.has(member)) {
                hits.push({ name: member, line: node.loc ? node.loc.start.line : '?', transcendental: true });
            } else if (hardened && !SAFE_MATH_MEMBERS.has(member)) {
                hits.push({ name: member, line: node.loc ? node.loc.start.line : '?', transcendental: false });
            }
        }
    });
    return hits;
}

/**
 * UTF-8 byte length of the contract source, the unit the deploy cap is measured
 * in. TextEncoder (not Buffer) so the vendored SDK copy stays browser-safe;
 * the two agree byte for byte on every input, unpaired surrogates included
 * (both emit the 3-byte U+FFFD replacement), which is what makes this
 * measurement byte-identical to the on-chain
 * `Buffer.byteLength(code, 'utf8')` at xchain-indexer/src/actions/deploy.js.
 *
 * @param {string} code - Contract source code
 * @returns {number} UTF-8 byte length
 */
function codeSizeBytes(code) {
    return new TextEncoder().encode(code).length;
}

/**
 * Scan contract code for calls to a prototype method the sandbox hard-neuters
 * (String.match/matchAll/search, String.normalize/localeCompare, the
 * toLocale* family). Statically-resolvable call sites only: `x.match(...)` and
 * `x['match'](...)`; dynamic dispatch is out of reach, the same limitation
 * staticComputedKey already accepts elsewhere.
 *
 * Advisory by construction: a name-only match cannot distinguish a String
 * receiver from a contract's own object, so every hit is emitted as a WARNING
 * and 'banned-proto-method' is deliberately absent from CONSENSUS_RULES.
 *
 * @param {string} code - Contract source code
 * @returns {Array<{name: string, line: (number|string), regex: boolean}>}
 */
function findBannedProtoMethods(code) {
    const hits = [];
    let ast;
    try {
        ast = acorn.parse(code, { ecmaVersion: CONTRACT_ECMA_VERSION, sourceType: 'script', locations: true });
    } catch (e) {
        // Parse failure; lintSource's metering pass reports it as blocking.
        return hits;
    }
    walk.simple(ast, {
        CallExpression(node) {
            const c = node.callee;
            if (!c || c.type !== 'MemberExpression') return;
            let name = null;
            if (!c.computed && c.property && c.property.type === 'Identifier') name = c.property.name;
            else if (c.computed) name = staticComputedKey(c);
            if (!name || STRIPPED_PROTO_METHOD_NAMES.indexOf(name) === -1) return;
            hits.push({
                name,
                line: node.loc ? node.loc.start.line : '?',
                regex: REGEX_COERCING_METHODS.has(name)
            });
        }
    });
    return hits;
}

/**
 * Scan contract code for the `**` / `**=` exponentiation operator (hardened
 * rule). Number::exponentiate is the same IEEE 754 transcendental path the
 * Math.pow ban targets, so `p ** q` was an unguarded consensus-fork hole.
 * Emitted under rule 'banned-math'; contracts use xchain.math.pow() instead.
 *
 * @param {string} code - Contract source code
 * @returns {Array<{op: string, line: (number|string)}>}
 */
function findBannedExponentiation(code) {
    const hits = [];
    let ast;
    try {
        ast = acorn.parse(code, { ecmaVersion: CONTRACT_ECMA_VERSION, sourceType: 'script', locations: true });
    } catch (e) {
        return hits;
    }
    walk.simple(ast, {
        BinaryExpression(node) {
            if (node.operator === '**')
                hits.push({ op: '**', line: node.loc ? node.loc.start.line : '?' });
        },
        AssignmentExpression(node) {
            if (node.operator === '**=')
                hits.push({ op: '**=', line: node.loc ? node.loc.start.line : '?' });
        }
    });
    return hits;
}

/**
 * Scan contract code for references to the CONTRACT_WRAPPER's injected control
 * bindings (hardened rule; see RESERVED_CONTROL_BINDINGS above). Returns the
 * first offending name or null, mirroring metering.js findReservedIdentifier.
 *
 * @param {string} code - Contract source code
 * @returns {string|null}
 */
function findReservedControlBinding(code) {
    let found = null;
    try {
        const ast = acorn.parse(code, { ecmaVersion: CONTRACT_ECMA_VERSION, sourceType: 'script' });
        walk.full(ast, (node) => {
            if (!found && node.type === 'Identifier' && RESERVED_CONTROL_BINDINGS.indexOf(node.name) !== -1)
                found = node.name;
        });
    } catch (e) {
        // Parse failure; lintSource's metering pass reports it as blocking.
    }
    return found;
}

/**
 * Scan contract code for BigInt literals (10n) and RegExp literals (/.../), both of
 * which expose unmetered native computation. acorn marks BigInt literals with a
 * `bigint` property and RegExp literals with a `regex` property on the Literal node.
 *
 * @param {string} code - Contract source code
 * @returns {Array<{kind: string, line: (number|string)}>}
 */
function findBannedLiterals(code) {
    const hits = [];
    let ast;
    try {
        ast = acorn.parse(code, { ecmaVersion: CONTRACT_ECMA_VERSION, sourceType: 'script', locations: true });
    } catch (e) {
        return hits;
    }
    walk.simple(ast, {
        Literal(node) {
            if (node.bigint !== undefined && node.bigint !== null)
                hits.push({ kind: 'bigint', line: node.loc ? node.loc.start.line : '?' });
            else if (node.regex !== undefined && node.regex !== null)
                hits.push({ kind: 'regex', line: node.loc ? node.loc.start.line : '?' });
        }
    });
    return hits;
}

// Pattern-internal node types. Walking UP through these from a RestElement reaches the
// construct that OWNS the destructure, which is what decides whether a source
// expression exists to meter.
const PATTERN_NODE_TYPES = new Set([
    'ArrayPattern', 'ObjectPattern', 'Property', 'AssignmentPattern', 'RestElement'
]);

/**
 * Scan contract code for destructuring REST positions the allocator meter cannot reach.
 *
 * transformAllocators meters a rest destructure by wrapping its SOURCE EXPRESSION in the
 * size-charged helper that matches the copy (`__arrspread` for an array rest,
 * `__objspreadmeter` for an object rest). That only works when a source expression
 * exists and sits directly under the pattern carrying the rest:
 *
 *     var [x, ...c] = a;      // metered: `a` is the declarator init
 *     ({k, ...c} = o);        // metered: `o` is the assignment rhs
 *
 * Four positions have no such expression, so the O(n) copy would stay free:
 *
 *   - REST PARAMETER (`function f(...args)`, `(...args) => ...`). The copy is performed
 *     by the CALLER's argument list, which has no single source node. This is a live
 *     vector, not a theoretical one: `f.apply(null, bigArr)` in a loop pays no
 *     argument-spread charge (apply is an ordinary call, not a SpreadElement), and the
 *     callee's rest parameter then copies O(n) elements for a flat __gas(1).
 *   - NESTED REST (`var {a: {...c}} = o`, `var [[...c]] = a`). The rest copies an
 *     INTERMEDIATE value produced by the outer destructure; there is no expression node
 *     to wrap, and wrapping the outer source charges the wrong quantity.
 *   - CATCH-CLAUSE REST (`catch ({...e})`). The source is the thrown value, bound by the
 *     runtime rather than by an expression in the source text.
 *   - FOR-OF / FOR-IN HEAD (`for (const [...c] of xs)`). The source is a per-iteration
 *     value produced by the iterator, not an expression the transform can wrap without
 *     changing iteration semantics.
 *
 * Rejecting them at deploy is what makes the metering rewrite CLOSE the class instead of
 * relocating it. CONSENSUS-GATED on the same REST_PATTERN_METER flag-day the metering
 * rides (threaded as enforceBannedRest through validateSyntax), so below the gate a
 * contract using these forms deploys and replays exactly as it historically did.
 *
 * @param {string} code - Contract source code
 * @returns {Array<{kind: string, line: (number|string)}>}
 */
function findBannedRest(code) {
    const hits = [];
    let ast;
    try {
        ast = acorn.parse(code, { ecmaVersion: CONTRACT_ECMA_VERSION, sourceType: 'script', locations: true });
    } catch (e) {
        return hits;
    }
    // NOT walk.ancestor. acorn-walk's ObjectPattern base descends straight into a rest
    // property's ARGUMENT and never visits the RestElement node itself, and CatchClause
    // inherits that gap through its param, so `var {a: {...c}} = o` and
    // `catch ({...e})` are INVISIBLE to a RestElement visitor. (ArrayPattern elements
    // route through the Pattern dispatch and are visited, which is what makes the gap
    // look like it isn't there.) Walk the raw node keys instead - the same generic
    // recursion transformAllocators uses, which cannot miss a node type by construction.
    const stack = [];
    function classify(node) {
        // `stack` holds this node's ancestors, outermost first; node is not on it.
        const parent = stack.length >= 1 ? stack[stack.length - 1] : null;
        const gp     = stack.length >= 2 ? stack[stack.length - 2] : null;
        // METERED: the rest sits at the TOP level of a pattern whose source is an
        // addressable expression. Exactly the two shapes transformAllocators rewrites;
        // keep the two predicates in lockstep or the ban and the meter disagree.
        if (parent && (parent.type === 'ArrayPattern' || parent.type === 'ObjectPattern') && gp) {
            if (gp.type === 'VariableDeclarator' && gp.id === parent && gp.init) return;
            if (gp.type === 'AssignmentExpression' && gp.operator === '=' && gp.left === parent) return;
        }
        // Otherwise classify by the construct that OWNS the destructure.
        let i = stack.length - 1;
        while (i >= 0 && PATTERN_NODE_TYPES.has(stack[i].type)) i--;
        const owner = i >= 0 ? stack[i] : null;
        let kind = 'nested rest';
        if (owner) {
            if (owner.type === 'FunctionDeclaration' || owner.type === 'FunctionExpression'
                || owner.type === 'ArrowFunctionExpression')
                kind = 'rest parameter';
            else if (owner.type === 'CatchClause') kind = 'catch-clause rest';
            else if (owner.type === 'ForOfStatement' || owner.type === 'ForInStatement')
                kind = 'for-loop-head rest';
            // A declarator with NO init is a for-of/for-in head (`for (const [...c] of xs)`);
            // the metered branch above already returned for every declarator that has one.
            else if (owner.type === 'VariableDeclarator' && !owner.init)
                kind = 'for-loop-head rest';
        }
        hits.push({ kind, line: node.loc ? node.loc.start.line : '?' });
    }
    function visit(node) {
        if (!node || typeof node.type !== 'string') return;
        if (node.type === 'RestElement') classify(node);
        stack.push(node);
        const keys = Object.keys(node);
        for (let k = 0; k < keys.length; k++) {
            const key = keys[k];
            if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue;
            const child = node[key];
            if (Array.isArray(child)) {
                for (let j = 0; j < child.length; j++) visit(child[j]);
            } else {
                visit(child);
            }
        }
        stack.pop();
    }
    visit(ast);
    return hits;
}

/**
 * Scan contract code for non-integer (decimal) number literals (a non-blocking
 * warning that native float arithmetic is being used). Returns structured rules;
 * checkFloatWarnings flattens these to their message strings.
 *
 * @param {string} code - Contract source code
 * @returns {Array<{rule: string, message: string, line: (number|null)}>}
 */
function findFloatWarnings(code) {
    const warnings = [];
    try {
        const ast = acorn.parse(code, {
            ecmaVersion: CONTRACT_ECMA_VERSION,
            sourceType: 'script',
            locations: true
        });
        walk.simple(ast, {
            Literal(node) {
                if (typeof node.value === 'number' && !Number.isInteger(node.value)) {
                    const line = node.loc ? node.loc.start.line : '?';
                    warnings.push({
                        rule: 'float-literal',
                        message:
                            'WARNING: decimal number literal (' + node.value +
                            ') detected at line ' + line +
                            '; use xchain.math for deterministic arithmetic',
                        line: node.loc ? node.loc.start.line : null,
                        severity: 'warning'
                    });
                }
            }
        });
    } catch (e) {
        // Parse failure; validateSyntax/lintSource report it as a blocking error.
    }
    return warnings;
}

module.exports = {
    findBannedMathCalls,
    codeSizeBytes,
    findBannedProtoMethods,
    findBannedExponentiation,
    findReservedControlBinding,
    findBannedLiterals,
    findBannedRest,
    findFloatWarnings
};
