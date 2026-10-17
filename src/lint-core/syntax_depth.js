// Non-recursive syntactic-depth scanner for the deploy lint pre-parse guard.
// @ts-nocheck

const acorn = require('acorn');
const { CONTRACT_ECMA_VERSION } = require('../metering.js');
const { MAX_SYNTAX_DEPTH } = require('./constants.js');

// Why this exists: the delimiter scan (nesting_depth.js) sees only ( [ { ${, but the
// parser, the metering walk, the code generator and V8 also recurse once per level of
// a unary chain, a binary chain, chained assignment, a ternary chain, an else-if chain
// and similar delimiter-free shapes. Past some depth those recursions overflow the host
// stack, and where that happens depends on JIT warm-up and stack size, so it must never
// decide a verdict. This scan computes, without recursion, an upper bound on the
// syntactic depth every one of those consumers reaches, so a source under the bound
// cannot drive any of them into a host overflow.
//
// Model. The token stream is cut into delimiter frames (an explicit stack). Each frame
// is cut into segments at ',' and at statement ends. A segment's value is
//     prefix + ops + deepest child frame opened inside it
// where `ops` counts every token that can add one tree level along a path (operators,
// '.', '?.', '?', '=>', '...', template quotes, openers that chain a call or index,
// expression keywords), and `prefix` counts statement heads (if, else, while, for, do,
// with, switch, try, catch, finally, labels) that nest the statement that follows and
// therefore survive a ',' inside it. Every tree level on a path through a segment owns
// a distinct counted token in that segment, or is a list or statement wrapper covered
// by the frame's constant, or lies inside exactly one child frame, so the segment value
// bounds the depth of the segment. A frame's weight is its constant plus its largest
// segment; the source's depth is the weight of the top frame. Values combine
// post-order, so a left-deep chain that continues after a child frame closes (as in
// `f(x) + a + a + ...`, where x sits under every later `+`) is charged to that child.
//
// A segment resets at ';' and at the '}' that ends a block, except where the next
// token continues the same statement ('else', 'catch', 'finally', or the 'while' of an
// open 'do'); after a '}' it resets only when the next token cannot continue an
// expression, so a '}' that closes an object or function expression never resets a
// running chain.

const FRAME_CONSTANT = { top: 4, '{': 4, '(': 2, '[': 2, '${': 2 };

// Tokens that add a tree level wherever they appear in a segment.
const OP_LABELS = new Set([
    '=', '_=', '++/--', '!/~', '||', '&&', '??', '|', '^', '&', '==/!=/===/!==',
    '</>/<=/>=', '<</>>/>>>', '+/-', '%', '*', '/', '**',
    '?', '?.', '.', '=>', '...', '`',
    'new', 'typeof', 'void', 'delete', 'in', 'instanceof', 'function', 'class',
    'extends', 'return', 'throw', 'var', 'const', 'case', 'default', 'import'
]);
// Tokens whose level costs the recursive passes more stack than a unary or binary
// operator does, weighted so one unit is about the same stack for every token. An arrow
// opens a function scope per level and a call parses an argument list per level; both
// were measured at roughly 2.7x and 1.9x the stack of a '!' level (cold, 400 KB).
const OP_WEIGHT = { '=>': 3, '(': 2 };
// Name tokens that are prefix operators where they parse as such.
const OP_NAMES = new Set(['yield', 'await']);
// Statement heads: the statement after them nests one level below.
const PREFIX_LABELS = new Set([
    'if', 'else', 'while', 'for', 'do', 'with', 'switch', 'try', 'catch', 'finally'
]);
// Tokens that carry a statement on across a ';' or a block '}'.
const CONTINUE_LABELS = new Set(['else', 'catch', 'finally']);
// Tokens that can only begin a new statement after a '}': they never continue an
// expression that a closing brace ended (without a newline they are a syntax error).
const NEW_STATEMENT_LABELS = new Set([
    'name', 'num', 'string', 'regexp', 'bigint', 'privateId',
    'this', 'null', 'true', 'false', 'super', 'import', 'export',
    'new', 'typeof', 'void', 'delete', '!/~',
    'if', 'for', 'while', 'do', 'with', 'switch', 'try', 'var', 'const', 'return',
    'throw', 'break', 'continue', 'debugger', 'function', 'class', 'case', 'default'
]);
// Previous tokens after which `name :` is a label rather than a property or a ternary arm.
const LABEL_LEADERS = new Set([null, ';', '}', ')', ':', '{', 'else', 'do']);
const OPENERS = new Set(['(', '[', '{', '${']);
const CLOSERS = new Set([')', ']', '}']);

const PENDING_SEMI = 1;
const PENDING_BRACE = 2;

function newFrame(kind) {
    return { kind: kind, prefix: 0, ops: 0, child: 0, best: 0, openDo: 0, pending: 0 };
}

function closeSegment(frame) {
    const value = frame.prefix + frame.ops + frame.child;
    if (value > frame.best) frame.best = value;
}

// Only after closeSegment: the running segment must be recorded before it is dropped.
function resetSegment(frame) {
    frame.prefix = 0;
    frame.ops = 0;
    frame.child = 0;
}

// A lower bound on the final depth: each enclosing frame's constant and open segment,
// plus the innermost frame's best segment so far.
function depthNow(stack) {
    let total = 0;
    const last = stack.length - 1;
    for (let i = 0; i < last; i++)
        total += FRAME_CONSTANT[stack[i].kind] + stack[i].prefix + stack[i].ops;
    const f = stack[last];
    return total + FRAME_CONSTANT[f.kind] + Math.max(f.best, f.prefix + f.ops + f.child);
}

function popFrame(stack) {
    const frame = stack.pop();
    closeSegment(frame);
    const parent = stack[stack.length - 1];
    const weight = FRAME_CONSTANT[frame.kind] + frame.best;
    if (weight > parent.child) parent.child = weight;
    return frame;
}

// Settle a statement end left open by the previous ';' or block '}'.
function settlePending(frame, label) {
    const fromBrace = frame.pending === PENDING_BRACE;
    frame.pending = 0;
    let carry = CONTINUE_LABELS.has(label);
    if (label === 'while' && frame.openDo > 0) {
        frame.openDo--;
        carry = true;
    }
    if (!carry && (!fromBrace || NEW_STATEMENT_LABELS.has(label))) {
        closeSegment(frame);
        resetSegment(frame);
    }
}

// Apply one token to the frame stack. Returns true when a segment or frame just closed,
// the only points where the bound can first be exceeded.
function applyToken(stack, token, prev, prevPrev) {
    const label = token.type.label;
    const frame = stack[stack.length - 1];
    if (OPENERS.has(label)) {
        if (label === '(' || label === '[') frame.ops += OP_WEIGHT[label] || 1;
        stack.push(newFrame(label));
    } else if (CLOSERS.has(label)) {
        if (stack.length === 1) return false;
        const closed = popFrame(stack);
        if (closed.kind === '{') stack[stack.length - 1].pending = PENDING_BRACE;
        return true;
    } else if (label === ',') {
        closeSegment(frame);
        frame.ops = 0;
        frame.child = 0;
        return true;
    } else if (label === ';') {
        closeSegment(frame);
        frame.pending = PENDING_SEMI;
        return true;
    } else if (PREFIX_LABELS.has(label)) {
        frame.prefix++;
        if (label === 'do') frame.openDo++;
    } else if (label === ':') {
        if (prev === 'name' && LABEL_LEADERS.has(prevPrev)) frame.prefix++;
    } else if (OP_LABELS.has(label) || (label === 'name' && OP_NAMES.has(token.value))) {
        frame.ops += OP_WEIGHT[label] || 1;
    }
    return false;
}

function finalDepth(stack) {
    while (stack.length > 1) popFrame(stack);
    closeSegment(stack[0]);
    return FRAME_CONSTANT.top + stack[0].best;
}

// Scan `code`, stopping at the first closing point whose running bound passes `limit`.
// Returns { line, depth }: the full bound, or the running bound where the scan stopped.
// A tokenizer error ends the scan and the open frames are measured as if closed there,
// which still bounds what any parser reaches before that error.
function scanSyntaxDepth(code, limit) {
    const stack = [newFrame('top')];
    let line = 1;
    let prev = null;
    let prevPrev = null;
    try {
        const tokenizer = acorn.tokenizer(code, {
            ecmaVersion: CONTRACT_ECMA_VERSION,
            sourceType: 'script',
            locations: true
        });
        for (;;) {
            const token = tokenizer.getToken();
            const label = token.type.label;
            line = token.loc.start.line;
            const frame = stack[stack.length - 1];
            if (frame.pending) settlePending(frame, label);
            if (label === 'eof') break;
            if (applyToken(stack, token, prev, prevPrev) && depthNow(stack) > limit)
                return { line: line, depth: depthNow(stack) };
            prevPrev = prev;
            prev = label;
        }
    } catch (e) {
        // Measure what was scanned, as if every open frame closed here.
    }
    return { line: line, depth: finalDepth(stack) };
}

/**
 * Upper-bound the syntactic depth of `code` and report where it first exceeds `limit`.
 * @param {string} code
 * @param {number} [limit=MAX_SYNTAX_DEPTH]
 * @returns {Array<{line: number, depth: number}>}
 */
function findSyntaxDepth(code, limit) {
    if (typeof code !== 'string') return [];
    const maxDepth = limit === undefined ? MAX_SYNTAX_DEPTH : limit;
    const hit = scanSyntaxDepth(code, maxDepth);
    return hit.depth > maxDepth ? [hit] : [];
}

/**
 * The full depth bound of `code` without an early stop, for diagnostics and calibration.
 * @param {string} code
 * @returns {number}
 */
function measureSyntaxDepth(code) {
    if (typeof code !== 'string') return 0;
    return scanSyntaxDepth(code, Infinity).depth;
}

function syntaxDepthFinding(code) {
    const hit = findSyntaxDepth(code)[0];
    if (!hit) return null;
    return {
        rule: 'nesting-depth',
        message: 'syntax depth exceeds limit (' + MAX_SYNTAX_DEPTH + ') at line ' + hit.line,
        line: hit.line,
        severity: 'error'
    };
}

module.exports = { findSyntaxDepth, measureSyntaxDepth, syntaxDepthFinding };
