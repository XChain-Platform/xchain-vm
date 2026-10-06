// Static scope and global-object resolution shared by the banned-syntax scanners.
// @ts-nocheck

// True if `node` is a static reference to the global Math object: the bare
// identifier `Math`, or a global-object-qualified form (`globalThis.Math` /
// `globalThis['Math']` / `globalThis[\`Math\`]`, the last via a template
// literal with no substitutions).
//
// The qualifying object leg is resolved by isGlobalObjectRef, so under the
// LINT_GLOBAL_ALIAS epoch (`aliased`) the widened spellings that rule already
// recognizes for banned-async and banned-wasm count here too: `this.Math.pow`
// and `globalThis.globalThis.Math.log` read the same global Math the rule
// targets. With `aliased` false only the bare `globalThis` identifier qualifies,
// which is byte-for-byte the pre-epoch behaviour, so a from-genesis replay below
// the activation reproduces the historical verdict.
function isMathObjectRef(node, aliased, optionalChain) {
    if (!node) return false;
    if (optionalChain && node.type === 'ChainExpression') node = node.expression;
    if (node.type === 'Identifier' && node.name === 'Math') return true;
    if (node.type === 'MemberExpression' && isGlobalObjectRef(node.object, aliased, optionalChain))
        return staticMemberKey(node) === 'Math';
    return false;
}

// If `node` is a computed MemberExpression whose property statically resolves
// to a string (a string Literal, or a TemplateLiteral with no substitution
// expressions), return that string; otherwise null. Handles `obj['key']` and
// `obj[\`key\`]` alike; variable-computed access (`obj[x]`) is intentionally
// left unresolved (out of scope, needs data-flow analysis).
function staticComputedKey(node) {
    if (!node.computed || !node.property) return null;
    const p = node.property;
    if (p.type === 'Literal' && typeof p.value === 'string') return p.value;
    if (p.type === 'TemplateLiteral' && p.expressions.length === 0 && p.quasis.length === 1)
        return p.quasis[0].value.cooked;
    return null;
}

// The property name a MemberExpression reads, when it resolves statically: the
// non-computed identifier (`o.k`), or a computed string / no-substitution template
// (`o['k']`, o[`k`]). null when resolving it would need data-flow analysis (`o[x]`).
function staticMemberKey(node) {
    if (!node || node.type !== 'MemberExpression' || !node.property) return null;
    if (node.computed) return staticComputedKey(node);
    return node.property.type === 'Identifier' ? node.property.name : null;
}

// True if `node` statically denotes the GLOBAL OBJECT.
//
// Legacy spelling (always recognized): the bare identifier `globalThis`.
//
// Under the LINT_GLOBAL_ALIAS activation epoch (`aliased`) two further spellings
// denote the same object and are recognized as well:
//   - `this`. Contract code is evaluated by the saved Function constructor in
//     global scope as SLOPPY-mode script, where top-level `this` IS globalThis,
//     and a plain `f()` call gives a sloppy function body the same receiver. So
//     `this.WebAssembly` / `this.Promise` is a global read that the
//     identifier-precise rules never saw.
//   - a self-referential alias chain of any depth: `globalThis.globalThis`,
//     `globalThis['globalThis']`, `this.globalThis`,
//     `globalThis.globalThis.globalThis`... The global object carries a
//     `globalThis` self-reference, so every link denotes the global object again,
//     and the single-hop `node.object.name === 'globalThis'` check walked past
//     all of them.
//
// The `this` leg deliberately fails CLOSED, the same direction the shadowed-local
// scope scan in findBannedAsync takes: a `this` bound by a METHOD call to a
// contract's own object is NOT the global object, so
// `{ Promise: 1, f() { return this.Promise; } }` is rejected too. Accepting that
// false positive is the safe direction for an error-severity CONSENSUS_RULE
// guarding an unmetered / nondeterministic surface, and it is exactly why this
// tightening MUST ride its own activation epoch: it moves DEPLOY verdicts, so it
// may only apply at or after a height the whole fleet agrees on. Below the
// activation `aliased` is false and every spelling resolves as it historically did.
function isGlobalObjectRef(node, aliased, optionalChain) {
    if (!node) return false;
    if (optionalChain && node.type === 'ChainExpression') node = node.expression;
    if (node.type === 'Identifier' && node.name === 'globalThis') return true;
    if (!aliased) return false;
    if (node.type === 'ThisExpression') return true;
    if (node.type === 'MemberExpression')
        return staticMemberKey(node) === 'globalThis'
            && isGlobalObjectRef(node.object, aliased, optionalChain);
    return false;
}

// True if binding pattern `pat` declares `name` (Identifier / default /
// rest / array / object destructuring, walked without descending into
// computed keys or default-value expressions).
function patternDeclares(pat, name) {
    if (!pat) return false;
    switch (pat.type) {
        case 'Identifier':        return pat.name === name;
        case 'AssignmentPattern': return patternDeclares(pat.left, name);
        case 'RestElement':       return patternDeclares(pat.argument, name);
        case 'ArrayPattern':      return (pat.elements || []).some((el) => patternDeclares(el, name));
        case 'ObjectPattern':     return (pat.properties || []).some((p) =>
            p.type === 'RestElement' ? patternDeclares(p.argument, name) : patternDeclares(p.value, name));
        default: return false;
    }
}

// True if ancestor node `node` IMMEDIATELY declares `name` in its own scope:
// function id/params, catch binding, a var/let/const/function/class statement
// directly in its body, or a for-loop declaration head. Deliberately does not
// descend into nested scopes (each ancestor is checked separately by the
// caller), and does not model hoisting order/TDZ: a TDZ read throws a
// deterministic in-isolate ReferenceError at runtime, which is safe.
function scopeDeclares(node, name) {
    if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression'
        || node.type === 'ArrowFunctionExpression') {
        if (node.id && node.id.name === name) return true;
        return (node.params || []).some((p) => patternDeclares(p, name));
    }
    if (node.type === 'CatchClause') return patternDeclares(node.param, name);
    const stmts = (node.type === 'Program' || node.type === 'BlockStatement' || node.type === 'StaticBlock')
        ? node.body
        : (node.type === 'SwitchCase') ? node.consequent : null;
    if (stmts) {
        for (const s of stmts) {
            if (s.type === 'VariableDeclaration'
                && s.declarations.some((d) => patternDeclares(d.id, name))) return true;
            if ((s.type === 'FunctionDeclaration' || s.type === 'ClassDeclaration')
                && s.id && s.id.name === name) return true;
        }
        return false;
    }
    if (node.type === 'ForStatement' && node.init && node.init.type === 'VariableDeclaration')
        return node.init.declarations.some((d) => patternDeclares(d.id, name));
    if ((node.type === 'ForInStatement' || node.type === 'ForOfStatement')
        && node.left && node.left.type === 'VariableDeclaration')
        return node.left.declarations.some((d) => patternDeclares(d.id, name));
    return false;
}

module.exports = {
    isMathObjectRef,
    staticComputedKey,
    staticMemberKey,
    isGlobalObjectRef,
    patternDeclares,
    scopeDeclares
};
