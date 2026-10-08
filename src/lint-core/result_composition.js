// Composes the ordered consensus errors and advisory warnings into one lint result.
// @ts-nocheck

const acorn = require('acorn');
const walk  = require('acorn-walk');
const { meterCode, findReservedIdentifier, CONTRACT_ECMA_VERSION } = require('../metering.js');
const { MAX_CODE_SIZE, STRIPPED_PROTO_METHOD_NAMES, CONSENSUS_RULES } = require('./constants.js');
const {
    findBannedMathCalls, codeSizeBytes, findBannedProtoMethods, findBannedExponentiation,
    findReservedControlBinding, findBannedLiterals, findBannedRest, findFloatWarnings
} = require('./banned_syntax.js');
const { findBannedAsync, findBannedGenerator, findBannedWasm, findBannedStrippedGlobals } = require('./banned_globals.js');
const { findBannedWith } = require('./banned_with.js');
const { analyzeContract } = require('./contract_analysis.js');

function lineOrNull(hit) {
    return typeof hit.line === 'number' ? hit.line : null;
}

// 1b. Deploy code-size cap. Lives HERE, not only in bin/lint.js, because
//     this file is the shared source of truth every linting surface goes
//     through (the SDK's pre-flight and any third-party direct caller), and
//     a CLI-only copy left those surfaces reporting clean on a contract the
//     indexer rejects with `invalid: CODE_ENCODING (exceeds max size)`.
//     Emitted FIRST because the chain checks size BEFORE the syntax gate.
//     Deliberately NOT a CONSENSUS_RULE: the on-chain verdict for size is
//     enforced by the indexer/VM ahead of validateSyntax, so adding it to
//     the blocking set would change nothing on chain and everything about
//     what error validateSyntax surfaces. Keeping it advisory-to-the-deploy
//     -path preserves the Move-1 parity invariant byte for byte.
function pushSizeError(code, errors) {
    if (codeSizeBytes(code) > MAX_CODE_SIZE) {
        errors.push({
            rule: 'code-size',
            message: 'code size exceeds limit (' + MAX_CODE_SIZE + ' bytes)',
            line: null,
            severity: 'error'
        });
    }
}

// 2. Acorn metering pass. If acorn can't parse it (or it uses post-ES2020
//    syntax), reject. This also doubles as the blocking parse check.
// Returns false when the parse failed, so the caller stops scanning.
function pushParseError(code, errors) {
    try {
        meterCode(code);
        return true;
    } catch (e) {
        errors.push({
            rule: 'unsupported-syntax',
            message: 'unsupported syntax (ES' + CONTRACT_ECMA_VERSION + ' maximum): ' + e.message,
            line: null,
            severity: 'error'
        });
        return false;
    }
}

// 3. Reserved identifier check. The authoritative ban list is
//    metering.RESERVED_IDENTIFIERS (frozen against narrowing by
//    test/determinism/consensus-params.test.js); do not re-enumerate it
//    here, it has grown and any inline copy drifts. It covers TWO hazard
//    classes: the allocator metering helpers (ALLOC_HELPERS), where a
//    reference could bypass or forge SIZE metering, and the call-depth
//    helpers (DEPTH_HELPERS), where a reference could bypass the
//    platform-independent recursion bound. Plus __gas itself.
function pushReservedErrors(code, hardened, errors) {
    const reserved = findReservedIdentifier(code);
    if (reserved)
        errors.push({ rule: 'reserved-identifier', message: 'reserved identifier: ' + reserved, line: null, severity: 'error' });

    // 3b. (hardened) CONTRACT_WRAPPER control bindings are reserved too.
    if (hardened) {
        const control = findReservedControlBinding(code);
        if (control)
            errors.push({ rule: 'reserved-identifier', message: 'reserved identifier: ' + control, line: null, severity: 'error' });
    }
}

// 4. Banned Math.* check (transcendentals always; hardened: the full
//    complement of the sandbox SAFE_MATH_MEMBERS whitelist).
function pushMathErrors(code, hardened, globalAlias, optionalChain, errors) {
    const banned = findBannedMathCalls(code, hardened, globalAlias, optionalChain);
    for (const hit of banned) {
        errors.push({
            rule: 'banned-math',
            message: hit.transcendental
                ? 'banned API: Math.' + hit.name + ' at line ' + hit.line +
                  '; IEEE 754 floating-point transcendentals are non-deterministic ' +
                  'across CPU architectures. Use xchain.math.' + hit.name + '() instead'
                : 'banned API: Math.' + hit.name + ' at line ' + hit.line +
                  '; not part of the deterministic sandbox Math subset ' +
                  '(floor/ceil/round/abs/min/max/sign/trunc/PI/E). Use those members or xchain.math instead',
            line: lineOrNull(hit),
            severity: 'error'
        });
    }

    // 4b. (hardened) Banned exponentiation operator. `**` / `**=` invoke the
    //     same Number::exponentiate transcendental the Math.pow ban targets.
    if (hardened) {
        for (const hit of findBannedExponentiation(code)) {
            errors.push({
                rule: 'banned-math',
                message: 'banned operator: ' + hit.op + ' at line ' + hit.line +
                         '; exponentiation is IEEE 754 floating-point (non-deterministic ' +
                         'across CPU architectures). Use xchain.math.pow() instead',
                line: lineOrNull(hit),
                severity: 'error'
            });
        }
    }
}

// 5. Banned native-DoS literals (BigInt + RegExp). The AST gas meter charges
//    per __gas() point, not for the cost INSIDE a single native operation, so
//    BigInt arithmetic and catastrophic regex backtracking burn heavy CPU for
//    ~0 gas. Literals can only be blocked at the syntax layer.
function pushLiteralErrors(code, errors) {
    for (const hit of findBannedLiterals(code)) {
        const advice = hit.kind === 'bigint'
            ? 'BigInt is unmetered native arithmetic; use the xchain.math bignumber API instead'
            : 'regular-expression literals can backtrack catastrophically and are unmetered';
        errors.push({
            rule: 'banned-literal',
            message: 'banned literal: ' + hit.kind + ' literal at line ' + hit.line + '; ' + advice,
            line: lineOrNull(hit),
            severity: 'error'
        });
    }
}

// 6. Banned async surface (async functions, await, Promise). The
//    CONTRACT_WRAPPER invokes exports synchronously, so a pending Promise
//    returned by an async export resolves (or not) per isolated-vm's
//    version-dependent microtask-drain timing, which is outside the
//    consensus_runtime pin: two validators can diverge (success vs timeout,
//    or differing post-await state). Rejected at deploy like BigInt/RegExp.
function pushAsyncErrors(code, hardened, globalAlias, optionalChain, errors) {
    for (const hit of findBannedAsync(code, hardened, globalAlias, optionalChain)) {
        const advice = hit.kind === 'promise'
            ? 'Promise schedules microtasks whose drain timing is isolated-vm version-dependent and unpinned'
            : hit.kind === 'import'
                ? 'dynamic import() evaluates to a Promise; the microtask surface it schedules is nondeterministic across validators'
                : hit.kind === 'await'
                ? 'await resumes after the synchronous contract invocation returns; post-await state writes are nondeterministic across validators'
                : 'async functions return a pending Promise the synchronous CONTRACT_WRAPPER cannot await; their post-await effects are nondeterministic across validators';
        errors.push({
            rule: 'banned-async',
            message: 'banned async surface: ' + hit.kind + ' at line ' + hit.line + ' (' + advice + ')',
            line: lineOrNull(hit),
            severity: 'error'
        });
    }
}

// 6b. Banned generator surface (function*, generator methods, yield). A
//     suspended generator frame enters the depth guard but its matching exit
//     runs only on drain, so undrained generators leak __stackDepth to the 512
//     cap and trip a spurious deterministic out_of_stack (29912bd8). Rejected
//     at deploy like the async surface. Pkg 3 bundle (CONSENSUS_VERSION 3).
function pushGeneratorErrors(code, errors) {
    for (const hit of findBannedGenerator(code)) {
        const advice = hit.kind === 'yield'
            ? 'yield suspends a generator frame without unwinding the call-depth guard; rewrite without generators'
            : 'a suspended generator frame is not unwound until drained, so undrained generators leak __stackDepth toward the 512 cap and throw a spurious deterministic out_of_stack; use a plain function';
        errors.push({
            rule: 'banned-generator',
            message: 'banned generator surface: ' + hit.kind + ' at line ' + hit.line + ' (' + advice + ')',
            line: lineOrNull(hit),
            severity: 'error'
        });
    }
}

// 6c. Banned WebAssembly global reference. wasm bodies run native code with no
//     __gas metering (unmetered native execution) and are a consensus-fork
//     surface; the sandbox strips the global at the Pkg 3 height flag-day
//     (75190596). This is the deploy-lint half. Identifier-precise (member
//     property / object key / shadowed local excluded), so error severity is
//     sound, unlike the name-only banned-proto-method warnings. Pkg 3 bundle.
// 6d. Banned unmeterable destructuring-rest positions. See findBannedRest: the
//     metering transform charges a rest destructure by wrapping its SOURCE
//     expression, and these four positions have none, so the O(n) copy would stay
//     free. Emitted unconditionally here; validateSyntax drops it from the blocking
//     set below the REST_PATTERN_METER flag-day (enforceBannedRest).
function pushRestErrors(code, errors) {
    for (const hit of findBannedRest(code)) {
        const advice = hit.kind === 'rest parameter'
            ? 'the copy is performed by the caller\'s argument list, which has no source expression to charge, so f.apply(null, bigArr) in a loop copies O(n) elements for ~1 gas. Read arguments.length / index the parameters instead'
            : hit.kind === 'catch-clause rest'
                ? 'the source is the thrown value, bound by the runtime rather than by an expression, so the own-key copy cannot be charged. Destructure the caught binding on a following line instead'
                : hit.kind === 'for-loop-head rest'
                    ? 'the source is a per-iteration value produced by the iterator, with no expression to charge. Bind the iteration value and destructure it in the loop body instead'
                    : 'a nested rest copies an intermediate value produced by the enclosing destructure, with no expression to charge. Destructure in two steps so the rest reads a named binding instead';
        errors.push({
            rule: 'banned-rest',
            message: 'unmeterable rest pattern: ' + hit.kind + ' at line ' + hit.line +
                     ' (' + advice + ')',
            line: lineOrNull(hit),
            severity: 'error'
        });
    }
}

// 6e. Banned `with` statement. A with block resolves free identifiers against an
//     arbitrary object at runtime, which defeats every identifier-precise ban
//     (reserved helpers, stripped globals, Math members) from inside the block.
function pushWithErrors(code, errors) {
    for (const hit of findBannedWith(code)) {
        errors.push({
            rule: 'banned-with',
            message: 'banned statement: with at line ' + hit.line +
                     '; a with block rebinds free identifiers to an object at runtime, which bypasses the ' +
                     'identifier-based deploy bans and the metering rewrite. Read the properties through the object instead',
            line: lineOrNull(hit),
            severity: 'error'
        });
    }
}

function pushWasmErrors(code, globalAlias, optionalChain, errors) {
    for (const hit of findBannedWasm(code, globalAlias, optionalChain)) {
        errors.push({
            rule: 'banned-wasm',
            message: 'banned global: WebAssembly at line ' + hit.line +
                     '; WebAssembly executes native code that carries no __gas metering (unmetered native execution) ' +
                     'and is a consensus-fork surface. The sandbox removes it, so this is unreachable at runtime',
            line: lineOrNull(hit),
            severity: 'error'
        });
    }
}

// 7. Sandbox-neutered prototype methods. sandbox.js replaces these with an
//    undefined, non-writable, non-configurable property, so a call fails
//    closed with a TypeError on FIRST EXECUTION rather than at deploy. The
//    linter already blocks RegExp LITERALS (rule 'banned-literal') for the
//    ReDoS half of this ban; the regex-COERCING methods that survive the
//    RegExp-global delete are the other half, and only the runtime half
//    shipped. WARNING severity, never a CONSENSUS_RULE: see the
//    STRIPPED_PROTO_METHOD_NAMES comment for why a name-only match must
//    not be allowed to red-line a contract's own .search()/.match().
function pushProtoMethodWarnings(code, warnings) {
    for (const hit of findBannedProtoMethods(code)) {
        const advice = hit.regex
            ? 'coerces its argument to a RegExp through the %RegExp% intrinsic, so catastrophic backtracking still runs for ~1 gas'
            : 'its output depends on the host ICU data/version, which varies across validator builds';
        warnings.push({
            rule: 'banned-proto-method',
            message: 'neutered method: .' + hit.name + '() at line ' + hit.line + '; ' + advice +
                     '. The sandbox removes it, so this throws TypeError at runtime',
            line: lineOrNull(hit),
            severity: 'warning'
        });
    }
}

// 7b. Sandbox-DELETED globals. sandbox.js removes these from the isolate so
//     every validator computes the same result from the same inputs, which
//     means a contract that reads one deploys clean and then throws
//     ReferenceError on its FIRST execution. Only WebAssembly (banned-wasm)
//     and Promise (banned-async) had a rule; the other 22 names had none, so
//     the shipped templates' own promise ("a contract CANNOT fetch a URL
//     directly: the sandbox strips fetch, Date, timers") was unenforced by
//     any static check. WARNING severity and deliberately NOT a
//     CONSENSUS_RULE: the sandbox strip is the load-bearing enforcement and
//     is already unconditional, so promoting this to a deploy-blocking rule
//     would move on-chain verdicts and needs its own activation epoch.
function pushStrippedGlobalWarnings(code, globalAlias, optionalChain, warnings) {
    for (const hit of findBannedStrippedGlobals(code, globalAlias, undefined, optionalChain)) {
        warnings.push({
            rule: 'banned-stripped-global',
            message: 'stripped global: ' + hit.name + ' at line ' + hit.line +
                     '; the sandbox deletes it so every validator computes the same result, ' +
                     'so this throws ReferenceError at runtime. Use the xchain.* gateway instead ' +
                     '(e.g. xchain.attestation.request to read a URL, blockContext.timestamp for time)',
            line: lineOrNull(hit),
            severity: 'warning'
        });
    }
}

/**
 * Run every acorn-coverable contract rule (steps 2–5 of validateSyntax + the
 * float warnings) plus the Move-2 logic-level advisories. The V8 syntax compile
 * (step 1) is NOT here; it needs isolated-vm and stays in syntax.js.
 *
 * Consensus errors are returned in deploy-check order (metering -> reserved ->
 * banned-math -> banned-literal -> banned-async -> banned-generator -> banned-rest ->
 * banned-wasm -> banned-with) FIRST, so errors[0] (filtered to CONSENSUS_RULES) is exactly the
 * failure validateSyntax surfaces and the indexer records. That order is
 * consensus-visible: reordering the checks changes recorded verdict strings, so it
 * moves only behind a flag day. Move-2 findings (advisory) are appended after and
 * never affect the deploy verdict.
 *
 * @param {string} code - Contract source code
 * @param {object} [opts]
 * @param {boolean} [opts.hardened=true] - apply the VM_LINT_HARDENING rule set
 *        (exponentiation ban, reserved control bindings, SAFE_MATH complement,
 *        dynamic import(), shorthand { Promise }, shadowed-local Promise
 *        relaxation). CONSENSUS-GATED on the deploy path: the indexer resolves
 *        protocol_changes.isEnabled('VM_LINT_HARDENING') per block so a
 *        from-genesis replay reproduces the historical verdicts. Defaults to
 *        true for author-facing callers (SDK linter, CLI, unit tests).
 * @param {boolean} [opts.globalAlias=true] - apply the LINT_GLOBAL_ALIAS rule
 *        refinement: sloppy-mode `this` and the `globalThis.globalThis...` self-
 *        reference chain count as the global object for banned-async,
 *        banned-wasm and banned-math. Its OWN activation epoch, not VM_LINT_HARDENING's: that gate
 *        is already open on every network, so riding it would retroactively reject
 *        contracts already accepted. Resolved per-coin on block HEIGHT (xchain-vm
 *        LINT_GLOBAL_ALIAS_ACTIVATION / the xchain-indexer registry row
 *        vm_lint_global_alias_activation.VM_LINT_GLOBAL_ALIAS_ACTIVATION in
 *        src/protocol_changes/gates_3.js). Defaults to true for author-facing
 *        callers (SDK linter, CLI, unit tests).
 * @param {boolean} [opts.optionalChain=true] - apply the LINT_OPTIONAL_CHAIN
 *        refinement: a parenthesized optional chain is unwrapped while resolving
 *        global-object and Math references. Resolved per-coin on block HEIGHT
 *        (xchain-vm LINT_OPTIONAL_CHAIN_ACTIVATION / the xchain-indexer registry
 *        row vm_lint_optional_chain_heights.VM_LINT_OPTIONAL_CHAIN_ACTIVATION).
 *        Defaults to true for author-facing callers (SDK linter, CLI, unit tests).
 * @returns {{ errors: Array<{rule,message,line,severity}>, warnings: Array<{rule,message,line,severity}> }}
 */
function lintSource(code, opts) {
    const hardened = !opts || opts.hardened !== false;
    const globalAlias = !opts || opts.globalAlias !== false;
    const optionalChain = !opts || opts.optionalChain !== false;
    if (typeof code !== 'string') {
        return {
            errors: [{ rule: 'invalid-type', message: 'Contract source must be a string', line: null, severity: 'error' }],
            warnings: []
        };
    }

    const errors = [];
    pushSizeError(code, errors);
    // Without a parse there is nothing more to scan deterministically.
    if (!pushParseError(code, errors)) return { errors, warnings: [] };

    pushReservedErrors(code, hardened, errors);
    pushMathErrors(code, hardened, globalAlias, optionalChain, errors);
    pushLiteralErrors(code, errors);
    pushAsyncErrors(code, hardened, globalAlias, optionalChain, errors);
    pushGeneratorErrors(code, errors);
    pushRestErrors(code, errors);
    pushWasmErrors(code, globalAlias, optionalChain, errors);
    pushWithErrors(code, errors);

    const warnings = findFloatWarnings(code);
    pushProtoMethodWarnings(code, warnings);
    pushStrippedGlobalWarnings(code, globalAlias, optionalChain, warnings);

    // Move 2: logic-level advisories (crossCallable integrity, gas/footgun heuristics).
    // These run AFTER the consensus checks above and NEVER affect the deploy verdict.
    // validateSyntax blocks only on CONSENSUS_RULES. analyzeContract is fully wrapped so
    // a detector bug can never throw into the deploy path.
    const move2 = analyzeContract(code);
    for (const e of move2.errors) errors.push(e);
    for (const w of move2.warnings) warnings.push(w);

    return { errors, warnings };
}

module.exports = { lintSource };
