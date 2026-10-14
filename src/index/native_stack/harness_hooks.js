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
 * XChain VM: harness hooks for the native stack activation
 *
 * In-isolate code only the armed harness carries, compiled while the native
 * stack activation is on (__NATIVE_STACK_TERMINAL_ON). harness_rule.js joins
 * it onto ONE existing harness line, because every in-isolate line number is
 * consensus: a contract can read positions out of error text. The unarmed
 * harness is untouched, so the legacy hooks keep their exact source text,
 * which contract code can read with String(fn); in the armed harness each
 * install site picks these hooks instead.
 *
 * What the armed hooks do:
 *   - __gas(n, caught): the metering transform passes the value a catch or
 *     finally is about to handle. A native stack overflow poisons execution
 *     and throws the depth fault, exactly as the depth counter does, so it
 *     settles out_of_stack at the gas ceiling and no contract code runs
 *     after it.
 *   - Only the RangeError V8 itself raised counts as an overflow, never a
 *     value a contract built or reshaped. A contract can hold an engine
 *     error only through a catch, a finally or a frame exit, and every one
 *     of those hands it to a hook first, so the hooks decide at that first
 *     sighting and remember every value they have seen in a private
 *     WeakSet. The same set records every instance the error constructors
 *     build: Error and its seven native subclasses (and WebAssembly's three
 *     where that global exists) are replaced by wrappers that construct
 *     through the native, keep its name, length, statics, prototype and
 *     constructor link, and point every route back to a native constructor
 *     at a wrapper. A first-seen value counts only when its prototype is the
 *     native RangeError.prototype, it carries no own toStringTag, the native
 *     Object.prototype.toString reads it as [object Error] (only a real
 *     error object reads so, since RangeError.prototype is given a fixed
 *     undefined toStringTag the contract cannot change), and its own data
 *     'message' is V8's exact overflow text. The wrappers run as harness
 *     code, so constructing an error charges the same gas as before.
 *   - __depth_enter(w) / __depth_exit(token, 0): charge a frame's weight in depth
 *     units against the structural-depth bound (__NR_DEPTH_LIMIT, at most
 *     the musl-safe 256), and restore the depth the frame was entered at
 *     when it returns, which also drops any argument hold it leaked by
 *     throwing. Only the token __depth_enter returned for the innermost
 *     frame unwinds it; the hooks are reachable through globalThis, so any
 *     other call does nothing and contract code can never lower the depth
 *     below a frame that is still live (a frame it pushes by hand itself
 *     only makes the budget stricter). __depth_exit(thrown), from the guard's catch, turns a native
 *     overflow leaving the frame into the depth fault, so one that no
 *     contract catch saw still reaches the host as the guard's own fault.
 *   - Function.prototype.apply, call/new spread (__arrspread modes 1 and 2)
 *     and Function.prototype.bind: arguments a native call pushes onto the
 *     stack are held against the same budget for the length of the call
 *     (CALL_UNITS plus one per ARGS_PER_UNIT; an apply reached from another
 *     apply with no contract frame in between, such as a nested join
 *     re-entering its wrapper through toString, adds only the per-argument
 *     units, since the structural-depth guard already bounds that native
 *     recursion), and bound arguments, which
 *     every later call pushes again, are capped at BOUND_ARGS_MAX.
 *
 * Every native and prototype method the hooks use is captured here, before
 * any contract code runs, and the hooks store their own state in null
 * prototype objects, so a contract that rewrites Array.prototype or
 * Object.prototype cannot reach into them.
 ********************************************************************/
// @ts-nocheck

// Arguments one depth unit covers: 64 pushed values are 512 bytes of native stack.
const ARGS_PER_UNIT = 64;
// Units every apply or spread call holds whatever its length. A harness wrapper
// that forwards through apply, plus the native it calls (forEach, sort, JSON.parse
// with a reviver), puts several hundred bytes of frames between two contract
// frames; two units keep a chain of them at least 2x inside the smallest
// supported stack, measured at --stack-size=400.
const CALL_UNITS = 2;
// Bound arguments a function may carry in total, across nested binds.
const BOUND_ARGS_MAX = 16;

// Readable form of the in-isolate source. No line comments (the lines are
// joined), no backticks and no dollar-brace (the harness is a template literal).
const SOURCE_LINES = [
    'var __nstOn = globalThis.__NATIVE_STACK_TERMINAL_ON === true;',
    'var __nstDefProp = globalThis.__defineProperty;',
    'var __nstGetOwnDesc = Object.getOwnPropertyDescriptor;',
    'var __nstIsArray = Array.isArray;',
    'var __nstFnProto = Object.getPrototypeOf(function() {});',
    'var __nstUncurry = function(f) { return __nstFnProto.call.bind(f); };',
    'var __nstApplyN = __nstUncurry(__nstFnProto.apply);',
    'var __nstBindN = __nstFnProto.bind;',
    'var __nstHasOwn = __nstUncurry(Object.prototype.hasOwnProperty);',
    'var __nstBound = new Map();',
    'var __nstMapGet = __nstUncurry(Map.prototype.get);',
    'var __nstMapSet = __nstUncurry(Map.prototype.set);',
    'var __nstActs = { __proto__: null }, __nstTokens = { __proto__: null }, __nstActN = 0, __nstHolds = { __proto__: null }, __nstHoldN = 0, __nstApplyAct = -1;',
    'var __nstGetProto = Object.getPrototypeOf;',
    'var __nstSetProto = Object.setPrototypeOf;',
    'var __nstOwnNames = Object.getOwnPropertyNames;',
    'var __nstOwnSyms = Object.getOwnPropertySymbols;',
    'var __nstToString = __nstUncurry(Object.prototype.toString);',
    'var __nstTagSym = Symbol.toStringTag;',
    'var __nstRangeProto = RangeError.prototype;',
    'var __nstUsed = new WeakSet();',
    'var __nstUsedHas = __nstUncurry(WeakSet.prototype.has);',
    'var __nstUsedAdd = __nstUncurry(WeakSet.prototype.add);',
    'function __nstFault() { __stackPoison = true; throw __stackError(); }',
    'function __nstIsOverflow(c) {',
    '    if (c === null || typeof c !== "object" || __nstUsedHas(__nstUsed, c)) return false;',
    '    __nstUsedAdd(__nstUsed, c);',
    '    if (__nstGetProto(c) !== __nstRangeProto || __nstGetOwnDesc(c, __nstTagSym) !== undefined) return false;',
    '    if (__nstToString(c) !== "[object Error]") return false;',
    '    var d = __nstGetOwnDesc(c, "message");',
    '    return d !== undefined && __nstHasOwn(d, "value") && d.value === "Maximum call stack size exceeded";',
    '}',
    'function __nstSetOwn(o, k, v) { var d = __nstGetOwnDesc(o, k); d.value = v; __nstDefProp(o, k, d); }',
    'function __nstWrapError(I, parent) {',
    '    var W = function(a, b) {',
    '        var e = new I(a, b, arguments[2]);',
    '        if (new.target !== undefined && new.target !== W) {',
    '            var p = new.target.prototype;',
    '            if (p !== null && (typeof p === "object" || typeof p === "function")) __nstSetProto(e, p);',
    '        }',
    '        __nstUsedAdd(__nstUsed, e);',
    '        return e;',
    '    };',
    '    var ks = __nstOwnNames(I), ss = __nstOwnSyms(I), i;',
    '    for (i = 0; i < ks.length; i++) if (ks[i] !== "prototype") __nstDefProp(W, ks[i], __nstGetOwnDesc(I, ks[i]));',
    '    for (i = 0; i < ss.length; i++) __nstDefProp(W, ss[i], __nstGetOwnDesc(I, ss[i]));',
    '    __nstDefProp(W, "prototype", __nstGetOwnDesc(I, "prototype"));',
    '    if (parent !== null) __nstSetProto(W, parent);',
    '    __nstSetOwn(I.prototype, "constructor", W);',
    '    return W;',
    '}',
    'function __nstWrapErrors() {',
    '    var names = ["EvalError", "RangeError", "ReferenceError", "SyntaxError", "TypeError", "URIError", "AggregateError"];',
    '    var base = __nstWrapError(Error, null), i;',
    '    __nstSetOwn(globalThis, "Error", base);',
    '    for (i = 0; i < names.length; i++) if (typeof globalThis[names[i]] === "function") __nstSetOwn(globalThis, names[i], __nstWrapError(globalThis[names[i]], base));',
    '    var wa = globalThis.WebAssembly, wn = ["CompileError", "LinkError", "RuntimeError"];',
    '    if (wa !== null && typeof wa === "object") for (i = 0; i < wn.length; i++) if (typeof wa[wn[i]] === "function") __nstSetOwn(wa, wn[i], __nstWrapError(wa[wn[i]], base));',
    '    __nstDefProp(__nstRangeProto, __nstTagSym, { value: undefined, writable: false, enumerable: false, configurable: false });',
    '}',
    'function __nstUnits(n, base) { return (base === undefined ? ' + CALL_UNITS + ' : base) + (n - n % ' + ARGS_PER_UNIT + ') / ' + ARGS_PER_UNIT + '; }',
    'function __nstReserve(u) { if (__NR_DEPTH_LIMIT > 0 && __stackDepth + u > __NR_DEPTH_LIMIT) __nstFault(); }',
    'function __nstLen(v) { var n = +v; if (!(n > 0)) return 0; if (n > 9007199254740991) n = 9007199254740991; return n - n % 1; }',
    'function __nstGas(n, c) {',
    '    if (__stackPoison) throw __stackError();',
    '    if (arguments.length > 1 && __nstIsOverflow(c)) __nstFault();',
    '    __gasRef.applySync(undefined, [(typeof n === "number" && n > 1) ? n : 1]);',
    '}',
    'function __nstDepthEnter(w) {',
    '    if (__stackPoison) throw __stackError();',
    '    var u = (typeof w === "number" && w > 1) ? w : 1;',
    '    __nstReserve(u);',
    '    var token = { __proto__: null };',
    '    __nstTokens[__nstActN] = token;',
    '    __nstActs[__nstActN++] = __stackDepth;',
    '    __stackDepth += u;',
    '    return token;',
    '}',
    'function __nstDepthExit(c, mode) {',
    '    if (arguments.length === 1) { if (__nstIsOverflow(c)) __nstFault(); return; }',
    '    if (arguments.length !== 2 || mode !== 0) return;',
    '    if (__nstActN === 0 || __nstTokens[__nstActN - 1] !== c) return;',
    '    while (__nstHoldN > 0 && __nstHolds[__nstHoldN - 1].a >= __nstActN) __nstHoldN--;',
    '    __nstActN--;',
    '    __stackDepth = __nstActs[__nstActN];',
    '    __nstTokens[__nstActN] = undefined;',
    '}',
    'function __nstRelease(id) {',
    '    if (__nstHoldN > 0) {',
    '        var t = __nstHolds[__nstHoldN - 1];',
    '        if (t.i === id && t.a === __nstActN) { __stackDepth = t.p; __nstHoldN--; }',
    '    }',
    '}',
    'function __nstHold(n, id) {',
    '    __nstRelease(id);',
    '    var u = __nstUnits(n);',
    '    __nstReserve(u);',
    '    __nstHolds[__nstHoldN++] = { __proto__: null, i: id, a: __nstActN, p: __stackDepth };',
    '    __stackDepth += u;',
    '}',
    'function __nstArrspread(segments, mode, id) {',
    '    if (mode === 2) { __nstRelease(id); return segments; }',
    '    var r = [], spread = 0;',
    '    for (var i = 0; i < segments.length; i++) {',
    '        var kind = segments[i][0], val = segments[i][1];',
    '        if (kind === "s") {',
    '            var a = [...val];',
    '            spread += a.length;',
    '            for (var j = 0; j < a.length; j++) r.push(a[j]);',
    '        } else if (kind === "h") {',
    '            r.length = r.length + 1;',
    '        } else {',
    '            r.push(val);',
    '        }',
    '    }',
    '    if (spread > __GROW_THRESHOLD) __gas(spread);',
    '    if (mode === 1) __nstHold(r.length, id);',
    '    return r;',
    '}',
    'var __nstApply = ({ apply(thisArg, args) {',
    '    if (typeof this !== "function") return __nstApplyN(this, thisArg, args);',
    '    var a = args, n = 0;',
    '    if (a != null) {',
    '        if (typeof a !== "object" && typeof a !== "function") return __nstApplyN(this, thisArg, a);',
    '        n = __nstIsArray(a) ? a.length : __nstLen(a.length);',
    '    }',
    '    var u = __nstUnits(n, __nstApplyAct === __nstActN ? 0 : undefined);',
    '    __nstReserve(u);',
    '    if (__applyLengthMeterOn && n > __GROW_THRESHOLD) __nstGas(n);',
    '    if (a != null && !__nstIsArray(a)) {',
    '        var c = { __proto__: null, length: n };',
    '        for (var i = 0; i < n; i++) c[i] = a[i];',
    '        a = c;',
    '    }',
    '    var p = __stackDepth, q = __nstApplyAct;',
    '    __nstApplyAct = __nstActN;',
    '    __stackDepth += u;',
    '    try { return __nstApplyN(this, thisArg, a); } finally { __stackDepth = p; __nstApplyAct = q; }',
    '} }).apply;',
    'var __nstBind = ({ bind(thisArg) {',
    '    var k = arguments.length > 1 ? arguments.length - 1 : 0;',
    '    var base = (typeof this === "function") ? (__nstMapGet(__nstBound, this) || 0) : 0;',
    '    if (base + k > ' + BOUND_ARGS_MAX + ') __nstFault();',
    '    var r = __nstApplyN(__nstBindN, this, arguments);',
    '    if (base + k > 0) __nstMapSet(__nstBound, r, base + k);',
    '    return r;',
    '} }).bind;',
    'if (__nstOn) {',
    '    try { __nstDefProp(__nstFnProto, "apply", { value: __nstApply, writable: false, configurable: false, enumerable: false }); } catch (e) {}',
    '    try { __nstDefProp(__nstFnProto, "bind", { value: __nstBind, writable: false, configurable: false, enumerable: false }); } catch (e) {}',
    '    __nstWrapErrors();',
    '}',
];

// The source as one line, ready to append to an existing harness line.
const NATIVE_STACK_LINE = SOURCE_LINES.map(function (l) { return l.trim(); }).join(' ');

module.exports = { NATIVE_STACK_LINE, ARGS_PER_UNIT, CALL_UNITS, BOUND_ARGS_MAX };
