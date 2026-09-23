// Canonical knowledge base. Sourced from developer-guide/Solidity_To_XChain.md
// (itself verified against src/gateway.js / gateway_emit.js). Kept as structured
// data so it drives the prompt AND is assertable in tests; a drift here is a
// drift the authoring prompt would teach the model, so it is worth pinning.

// The three model shifts an EVM author must internalize.
const MODEL_SHIFTS = [
    'Contracts orchestrate; they never mutate the ledger. You cannot write a ' +
        'balance. You emit a validated ACTION (xchain.emit.*) and the protocol\'s ' +
        'audited handler moves tokens. A contract may only emit ACTIONs a user could.',
    'There is no msg.value. Value does not ride a call. Tokens enter a contract ' +
        'via a separate DEPOSIT action to the contract address; logic runs via ' +
        'EXECUTE; the caller makes them atomic with BATCH. Trust your own balance ' +
        '(xchain.getBalance(getContractAddress(), tick)), never a caller-supplied amount.',
    'Emissions are deferred (snapshot semantics). Emitted actions apply only after ' +
        'your method returns; getBalance/getTokenInfo reflect start-of-call state. ' +
        'A contract cannot observe its own emissions mid-call, so classic reentrancy ' +
        'is largely a non-issue. Compute from start-of-call state.'
];

// "Reach for a native primitive before writing a contract." { want, solidity, xchain }
const NATIVE_PRIMITIVES = [
    { want: 'A fungible token', solidity: 'write an ERC-20', xchain: 'ISSUE action (tokens are first-class); no contract' },
    { want: 'Transfer a token', solidity: 'transfer()', xchain: 'SEND action' },
    { want: 'Check a balance', solidity: 'balanceOf()', xchain: 'explorer/SDK query, or in-contract getBalance(addr, tick) for the caller or the contract itself only (any other address reads null)' },
    { want: 'An NFT', solidity: 'ERC-721', xchain: 'ISSUE with DECIMALS=0 + LOCK_MAX_SUPPLY=1' },
    { want: 'Token sale', solidity: 'crowdsale contract', xchain: 'DISPENSER action, or the crowdsale template' },
    { want: 'Swap two tokens', solidity: 'a DEX pair', xchain: 'ORDER / SWAP actions, or the amm template' },
    { want: 'Pay dividends', solidity: 'loop transfers', xchain: 'DIVIDEND action' },
    { want: 'Airdrop', solidity: 'loop transfers', xchain: 'AIRDROP action over a LIST' },
    { want: 'Enforced royalties / transfer rules', solidity: 'ERC-20 hooks / ERC-2981', xchain: 'controller-bound token: a guard contract bound at ISSUE (v6)' }
];

// Solidity -> XChain concept map. { solidity, xchain, note }
const CONCEPT_MAP = [
    { solidity: 'constructor', xchain: 'initialize(xchain)', note: 'runs once at DEPLOY with CONSTRUCTOR_PARAMS' },
    { solidity: 'function f() public', xchain: 'f: function (xchain) { ... }', note: 'invoked by name via EXECUTE' },
    { solidity: 'function arguments', xchain: 'xchain.getInputParam(i) / getInputParamCount()', note: 'all params are strings' },
    { solidity: 'msg.sender', xchain: 'xchain.getSourceAddress()', note: 'the calling address' },
    { solidity: 'address(this)', xchain: 'xchain.getContractAddress()', note: 'C:CHAIN:index' },
    { solidity: 'msg.value', xchain: '(none)', note: 'use DEPOSIT + BATCH; read getBalance(getContractAddress(), tick)' },
    { solidity: 'block.number', xchain: 'xchain.getBlockHeight()', note: '' },
    { solidity: 'block.timestamp', xchain: 'xchain.getBlockTimestamp()', note: '' },
    { solidity: 'blockhash(n)', xchain: 'xchain.getBlockHash()', note: 'current block only' },
    { solidity: 'storage variable', xchain: 'xchain.state.set/get/has/delete', note: 'flat k/v; values are strings (JSON for structs)' },
    { solidity: 'mapping(k => v)', xchain: 'composed key, e.g. state.set("bal:" + addr, amt)', note: 'no native map type' },
    { solidity: 'struct', xchain: 'JSON string in one key', note: 'state.set("cfg", JSON.stringify(obj))' },
    { solidity: 'require(c, "m")', xchain: 'xchain.require(c, "m")', note: 'reverts the whole execution + emissions' },
    { solidity: 'revert("m")', xchain: 'xchain.revert("m")', note: '' },
    { solidity: 'emit Event(...)', xchain: 'xchain.emit.broadcast(...)', note: 'or rely on the indexer action log' },
    { solidity: 'uint math / SafeMath', xchain: 'xchain.math.add/subtract/multiply/divide/compare/gt/gte/lt/lte/eq/...', note: 'bignumber, no overflow; NATIVE Math.pow/sqrt/log AND `**` ARE REJECTED AT DEPLOY (a decimal literal only warns)' },
    { solidity: 'transfer / send value', xchain: 'xchain.emit.send({ ... })', note: 'emits SEND; applied after return' },
    { solidity: 'external call returning a value', xchain: 'xchain.emit.execute({ contractIndex, method, params, gasLimit })', note: 'ASYNC, NO return value; respond via a callback method' },
    { solidity: 'cross-chain call', xchain: 'xchain.emit.crossExecute({ targetChain, contractIndex, method, params, gasLimit, callbackMethod, callbackParams, deadlineBlocks })', note: 'bridgeless; target must export crossCallable' },
    { solidity: 'modifier onlyOwner', xchain: 'a guard helper from patterns/', note: 'check getSourceAddress() against stored owner' },
    { solidity: 'Ownable / AccessControl', xchain: 'patterns/ access control (OZ-equivalent, audited)', note: '' },
    { solidity: 'Pausable', xchain: 'patterns/ pausable (or token-level SLEEP)', note: '' },
    { solidity: 'ReentrancyGuard', xchain: 'usually unnecessary', note: 'snapshot semantics; keep state-before-emit discipline' },
    { solidity: 'view / pure', xchain: 'a method that only reads', note: 'just do not write state or emit' },
    { solidity: 'oracle price feed (Chainlink)', xchain: 'xchain.oracle.getPrice(coinPair)', note: 'validator-attested, built in' },
    { solidity: 'external data / API', xchain: 'xchain.attestation.request(providerId, payload, callbackMethod, callbackParams, opts)', note: 'PBFT-certified; http_get and llm providers' },
    { solidity: 'payable receive()', xchain: '(none)', note: 'DEPOSIT' },
    { solidity: 'selfdestruct / delegatecall', xchain: '(none)', note: 'not in the model' },
    { solidity: 'gas limit', xchain: 'GAS_LIMIT on deploy/execute; sdk.suggestGasLimit(...)', note: 'metered per the gas schedule' }
];

// The names the sandbox deletes, taught verbatim. Required from the one module
// that defines them rather than re-copied: ../stripped_globals.js is
// dependency-free, so requiring it keeps this module isolated-vm-free (its whole
// point is that the authoring loop and the acorn gate run on any OS) while
// making a taught/enforced mismatch impossible to write. sandbox.js and
// lint_core.js require the same module.
const { STRIPPED_GLOBAL_NAMES: STRIPPED_GLOBALS_TAUGHT } = require('../../stripped_globals.js');

// The identifiers the deploy gate rejects, taught by NAME rather than retyped as
// a prefix sketch. Two authorities, both acorn-only (so requiring them keeps this
// module isolated-vm-free, and lint_core is already in the graph via gate.js):
// metering.RESERVED_IDENTIFIERS is the metering pass's own helper set, and
// lint_core.RESERVED_CONTROL_BINDINGS the contract wrapper's control bindings,
// rejected by the same 'reserved-identifier' rule once hardening is active.
// Matching in findReservedIdentifier / findReservedControlBinding is on the exact
// name, so a prefix wording would ban ordinary names (`__gasBudget`) the chain
// allows while missing the helpers it does not.
const { RESERVED_IDENTIFIERS } = require('../../metering.js');
const { RESERVED_CONTROL_BINDINGS } = require('../../lint_core.js');
const RESERVED_NAMES_TAUGHT = RESERVED_IDENTIFIERS.concat(RESERVED_CONTROL_BINDINGS);

// Non-negotiable rules the generated contract MUST satisfy; teaching them up
// front cuts repair rounds. Most are deploy-blocking (lint_core CONSENSUS_RULES,
// the only findings the on-chain validator acts on). Two are NOT, and the wording
// has to keep them apart or an author reads the wrong signal off a clean lint:
//   - banned globals are deleted from the isolate at RUNTIME, so a contract that
//     touches one lints clean, deploys, and then throws a ReferenceError on its
//     first execution;
//   - a decimal NUMBER LITERAL is rule 'float-literal', which findFloatWarnings
//     emits at severity 'warning' and which is absent from CONSENSUS_RULES, so
//     validateSyntax returns { valid: true } and the contract deploys
//     (test/toolkit/gate.test.js pins exactly that). The deploy-blocking half of
//     the old combined sentence is 'banned-math': the native transcendental Math
//     calls, plus `**` once VM_LINT_HARDENING is active.
// All of them are hard rules for an author; only the wording distinguishes where
// each one bites.
const HARD_RULES = [
    'Export a CommonJS module: `module.exports = { initialize, methodA, ... }` (object of methods) or a single `module.exports = function (xchain) {...}`. Each method takes exactly one argument: the `xchain` gateway.',
    'Export contract identity as the FIRST key: `meta: { name, description, version }`. ' +
        '`name` and `description` are REQUIRED and the deploy gate REJECTS a contract without them ' +
        '(name 1..64 bytes, description 1..512 bytes, both plain printable text with no leading or ' +
        'trailing whitespace and no control, zero-width or bidi characters; `version` is optional, ' +
        '1..32 bytes, e.g. "1.0.0"). Use plain STRING LITERALS, never a computed expression: the ' +
        'chain evaluates meta once at deploy and records what it evaluated to. For a single-function ' +
        'contract attach it as a property: `contract.meta = { ... }; module.exports = contract;`.',
    'No native float math: no Math.sqrt/pow/log/log2/log10 and no `**` exponentiation. The deploy gate REJECTS these; use xchain.math.* bignumber ops instead.',
    'No numeric literal with a decimal point, and token amounts are decimal STRINGS. Mandatory authoring practice: the linter reports a decimal literal as a WARNING, not a deploy rejection, so the chain will accept a contract that quietly does native floating-point arithmetic. Route every amount through xchain.math.*.',
    'No BigInt literals, no RegExp literals, no `new RegExp`.',
    'No async surface: no `async`, no `await`, no `Promise`. Methods are synchronous.',
    'No host globals. These are DELETED from the sandbox, so a contract that touches one deploys and then throws at execution: ' +
        STRIPPED_GLOBALS_TAUGHT.join(', ') +
        '. Also no `eval`, no `Function`, no `.constructor` access, no `require`/`import`/filesystem/network.',
    'ES2020 syntax maximum (no numeric separators, no logical-assignment, no top-level await).',
    'Do not declare or reference these reserved identifiers (the metering pass and the contract wrapper inject them; the deploy gate rejects any reference): ' +
        RESERVED_NAMES_TAUGHT.join(', ') +
        '. Matching is on the exact name, so an ordinary name such as `__gasBudget` is fine.',
    'State keys <= 1024 bytes, values <= 65536 bytes (JSON), <= 10000 keys total; at most 50 emitted actions per call.'
];

const CONTRACT_SHAPE = [
    '// SPDX-License-Identifier: MIT',
    'module.exports = {',
    '    meta: {                                    // REQUIRED identity; string literals only',
    '        name: "OwnerCounter",                  // 1..64 bytes',
    '        description: "A counter only its owner may increment.",  // 1..512 bytes',
    '        version: "1.0.0"                       // optional, 1..32 bytes',
    '    },',
    '    initialize: function (xchain) {           // constructor; runs once at DEPLOY',
    '        var owner = xchain.getInputParam(0);  // params arrive as strings',
    '        xchain.require(owner, "owner required");',
    '        xchain.state.set("owner", owner);',
    '    },',
    '    doThing: function (xchain) {               // a public method, invoked by name',
    '        xchain.require(xchain.getSourceAddress() === xchain.state.get("owner"), "not owner");',
    '        var n = xchain.state.get("n") || "0";',
    '        xchain.state.set("n", xchain.math.add(n, "1"));  // bignumber math, never native +',
    '    }',
    '};'
].join('\n');

module.exports = {
    MODEL_SHIFTS,
    NATIVE_PRIMITIVES,
    CONCEPT_MAP,
    STRIPPED_GLOBALS_TAUGHT,
    RESERVED_NAMES_TAUGHT,
    HARD_RULES,
    CONTRACT_SHAPE
};
