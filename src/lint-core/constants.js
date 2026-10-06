// Frozen lint constants: sandbox mirrors, size cap, stripped names and the deploy-blocking rule set.
// @ts-nocheck

const BANNED_MATH_MEMBERS = new Set(['sqrt', 'pow', 'log', 'log2', 'log10']);

// The FROZEN whitelist of Math members the sandbox's deterministic SafeMath
// subset exposes. MUST stay byte-equal to sandbox.js SAFE_MATH_MEMBERS (a
// parity test in xchain-vm asserts it); duplicated here (not required) so this
// file stays dependency-light for the vendored SDK/browser copies. Under the
// VM_LINT_HARDENING flag-day the banned set is the COMPLEMENT of this list:
// any statically-resolvable Math member NOT in it (Math.random, Math.atan2,
// future additions...) is rejected at deploy instead of failing at runtime.
const SAFE_MATH_MEMBERS = new Set([
    'floor', 'ceil', 'round', 'abs', 'min', 'max', 'sign', 'trunc', 'PI', 'E'
]);

// The CONTRACT_WRAPPER's injected control bindings (index.js). Legacy deploys
// compile them as script-level lexical bindings, visible from contract code
// (which is evaluated via the saved Function constructor in global scope), so
// a contract can read or shadow them to defeat crossCallable/manifest/method
// dispatch. Under VM_LINT_HARDENING the wrapper moves them into the IIFE
// closure AND the deploy validator rejects any reference to them
// (rule 'reserved-identifier'), mirroring the metering helper ban.
const RESERVED_CONTROL_BINDINGS = [
    '__contractCode', '__methodName', '__isCrossCall', '__readManifest'
];

// The deploy code-size cap, in UTF-8 BYTES. Inlined (not required from
// index.js or protocol/constants.js) for the same reason SAFE_MATH_MEMBERS is
// duplicated above: this file must be BYTE-IDENTICAL to the SDK's vendored copy
// at xchain-sdk/src/contract/lint-core.js, and constants.js sits at a different
// relative depth in each tree, so no single require() line resolves in both.
// It MUST stay equal to src/protocol/constants.js MAX_CODE_SIZE (and therefore
// to the indexer's deploy.js cap); a parity test asserts it.
const MAX_CODE_SIZE = 65536;

// The sandbox's hard-neutered prototype METHODS (sandbox.js
// STRIPPED_PROTO_METHODS). Duplicated here for the dependency-light reason
// above; a parity test asserts this list stays equal to sandbox.js.
// Two hazard classes, both consensus-relevant: the regex-coercing methods
// (match/matchAll/search) route a ReDoS through %RegExp% for ~1 gas even after
// the RegExp global is deleted, and the locale/ICU methods return host-ICU-
// version-dependent bytes. Calling any of them throws TypeError at runtime, so
// the linter's job here is to turn a first-execution failure into a deploy-time
// diagnostic. Matching is by METHOD NAME on a statically-resolvable call site,
// which cannot tell `someString.search(x)` from a contract's own
// `myIndex.search(x)`, so these are WARNINGS: never deploy-blocking, never in
// CONSENSUS_RULES, and never a false red on the CLI (bin/lint.js fails a file
// on error-severity findings only).
const STRIPPED_PROTO_METHOD_NAMES = [
    'match', 'matchAll', 'search',
    'normalize', 'localeCompare',
    'toLocaleLowerCase', 'toLocaleUpperCase', 'toLocaleString'
];
const REGEX_COERCING_METHODS = new Set(['match', 'matchAll', 'search']);

// The sandbox's deleted GLOBALS. NOT mirrored: required from the one module
// that defines them, ./stripped-globals.js, which sandbox.js and the AI-authoring
// knowledge base require too. That module is dependency-free precisely so this
// single require line resolves in BOTH trees at the two depths this file is
// vendored to (xchain-vm/src/ and xchain-sdk/src/contract/), which is the reason
// SAFE_MATH_MEMBERS and MAX_CODE_SIZE above still cannot be required: their
// homes (sandbox.js, protocol/constants.js) do not sit at a common relative
// path, and sandbox.js additionally pulls isolated-vm, which this file must
// never load. The SDK vendors stripped-globals.js byte-identically under the
// same sha256 parity guard as this file.
const {
    STRIPPED_GLOBAL_NAMES,
    ADVISORY_STRIPPED_GLOBAL_NAMES
} = require('../stripped-globals.js');

// Retained under its historical export name: the list is no longer a mirror,
// but callers (and the SDK's vendored copy's tests) import it by this name.
const STRIPPED_GLOBAL_NAMES_MIRROR = STRIPPED_GLOBAL_NAMES;

// The subset this file WARNS on: every name stripped from genesis on every
// network, so the warning's claim holds unconditionally. The two consensus-gated
// names (Promise, WebAssembly) are held out by stripped-globals.js, which
// explains why that is not a gap.
const ADVISORY_STRIPPED_GLOBALS = ADVISORY_STRIPPED_GLOBAL_NAMES;

// Move 2: logic-level lint rules (advisory; NEVER deploy-blocking).
// CONSENSUS_RULES are the only findings the on-chain deploy validator
// (validateSyntax -> xchain-indexer/deploy.js) acts on. Everything analyzeContract
// adds is author-facing signal for the SDK linter and the CLI; it must not change
// what the chain accepts, or the Move-1 deploy-parity invariant breaks. Keep this
// set in lockstep with the error-severity rules emitted above lintSource's Move-2
// section.
const CONSENSUS_RULES = new Set([
    'invalid-type',
    'unsupported-syntax',
    'reserved-identifier',
    'banned-math',
    'banned-literal',
    'banned-async',
    // Pkg 3 VM-sandbox bundle (CONSENSUS_VERSION 3, per-coin height flag-day). The
    // generator ban (29912bd8) and the WebAssembly deploy-lint ban (75190596, the
    // deploy half of the runtime global strip) ship in the same unshipped v3 epoch;
    // both are error-severity and precisely identify their target, so they belong in
    // the deploy-blocking set (their on-chain activation is the indexer's per-coin
    // gate, threaded through validateSyntax as enforceBannedGenerator/enforceBannedWasm).
    'banned-generator',
    'banned-wasm',
    // REST_PATTERN_METER (block-time flag-day, its own FUTURE instant). The rest
    // positions transformAllocators cannot reach by wrapping a source expression
    // (parameter lists, nested rest, catch-clause rest, for-of/for-in heads). Rejecting
    // them is what makes the metering rewrite close the free-O(n)-copy class rather than
    // relocate it; error-severity and AST-precise, so it belongs in the deploy-blocking
    // set. Its on-chain activation is threaded through validateSyntax as
    // enforceBannedRest, so below the flag-day a from-genesis replay reproduces the
    // historical accepted verdict.
    'banned-rest'
]);

const TYPED_ARRAY_CTORS = new Set([
    'Array', 'ArrayBuffer', 'Int8Array', 'Uint8Array', 'Uint8ClampedArray',
    'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array'
]);
const BULK_ALLOC_METHODS = new Set(['fill', 'repeat', 'padStart', 'padEnd']);

module.exports = {
    BANNED_MATH_MEMBERS,
    SAFE_MATH_MEMBERS,
    RESERVED_CONTROL_BINDINGS,
    MAX_CODE_SIZE,
    STRIPPED_PROTO_METHOD_NAMES,
    REGEX_COERCING_METHODS,
    STRIPPED_GLOBAL_NAMES,
    STRIPPED_GLOBAL_NAMES_MIRROR,
    ADVISORY_STRIPPED_GLOBALS,
    CONSENSUS_RULES,
    TYPED_ARRAY_CTORS,
    BULK_ALLOC_METHODS
};
