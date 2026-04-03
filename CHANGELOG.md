# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.7.0] - 2026-04-03

### Added
- Security audit plan report at `reports/XCHAIN_VM_SECURITY_AUDIT_PLAN.md` — comprehensive risk register covering 19 risks across 7 categories with prioritized mitigations
- Security test suite (`test/security.test.js`) — 75 tests covering sandbox escape vectors, error type spoofing, gas metering bypass, prototype pollution, emit type validation, math input limits, information leakage, and state isolation
- Emit parameter type validation (`gateway-emit.js`) — `destination`, `tick`, `quantity`, `giveAmount`, `getAmount`, `dividendTick`, `coin1`, `coin2` fields enforced as strings
- Math input length limit — inputs exceeding 256 characters rejected to prevent bignumber DoS (RISK-12/RISK-18)

### Fixed
- **Sandbox escape via prototype chain** (RISK-01) — neutered `Object.prototype.constructor`, `Array.prototype.constructor`, `String.prototype.constructor`, `Number.prototype.constructor`, `Boolean.prototype.constructor`, `RegExp.prototype.constructor` with `writable:false, configurable:false`
- **Sandbox escape via function-type constructors** (RISK-02) — neutered `GeneratorFunction`, `AsyncFunction`, `AsyncGeneratorFunction` prototype constructors
- **Reflect API available in sandbox** (RISK-03) — `Reflect` removed from isolate globals
- **Error type spoofing via caught reverts** (RISK-04) — `execContext.revertReason` stores original reason; classifier uses stored reason instead of error message to prevent spoofing after `try { xchain.revert() } catch(e) {}`
- **Gas metering bypass via __gas overwrite** (RISK-06) — `__gas` defined as `writable:false, configurable:false` on `globalThis`; contracts cannot overwrite or delete the metering callback
- **Unmetered getter/setter traps** (RISK-05 partial) — `Object.defineProperty`, `Object.defineProperties` removed from sandbox; `Object.create` restricted to single-argument form
- **RegExp catastrophic backtracking** (RISK-05/M-07) — `RegExp` global removed from sandbox; regex literals still work
- **Prototype pollution in state store** (RISK-11) — `StateManager` uses `Object.create(null)` for state object
- **Prototype pollution in emission params** (RISK-10) — `EmissionCollector.add()` copies params into `Object.create(null)` object, strips `__proto__` and `constructor` keys
- **Information leakage via error messages** (RISK-15) — generic errors sanitized: first line only, file paths stripped, truncated to 256 characters
- **Variable leakage to contract scope** — `__contractCode`/`__methodName` changed from `var` to `let` (block-scoped); `__defineProperty` cleaned up after harness use
- **Null emit params crash** — `dispenser`/`file`/`list`/`broadcast` emit methods handle null params gracefully

### Changed
- `sandbox.js` STRIP_SCRIPT significantly expanded with constructor neutering, `Object.defineProperty` removal, and `__defineProperty` preservation for harness
- `gateway.js` `revert()`/`require()` store reason in `execContext.revertReason`
- `index.js` `_classifyError()` uses `execContext.revertReason` and `gasTracker` values instead of error message payloads
- `index.js` adds `_sanitizeError()` method for generic error message sanitization
- `math.js` adds `validateInput()` with 256-char length limit applied to all math operations

## [1.6.0] - 2026-04-03

### Added
- Fuzz testing suite (`test/fuzz/`) — 86 property-based and adversarial tests across 8 categories using fast-check
- Fuzz harness (`test/fuzz/harness.js`) — shared VM factory, execute wrapper, deterministic result hashing, configurable iteration count via `FUZZ_ITERATIONS` env var
- 7 invariant checkers (`test/fuzz/invariants.js`) — result shape, atomicity, gas ceiling, emission cap, state limits, prototype pollution detection, determinism verification
- 5 input generators (`test/fuzz/generators/`) — AST-mutated code (10 templates + 25 adversarial patterns), argument arrays, emission payloads for all 16 action types, state key/value adversarial inputs, math edge-case numerics
- Code fuzz tests — gas/revert spoof detection, serialization boundary marker safety, AST mutation resilience
- Argument fuzz tests — protocol marker injection, out-of-bounds param access, param shape invariants
- Emission fuzz tests — valid/malformed/non-object params for all 16 methods, emission cap boundary enforcement
- State fuzz tests — null/NaN/Infinity rejection, key/value size limits, prototype-poisoning key safety, delete-set cycle integrity, initial state isolation
- Math fuzz tests — commutativity (add, multiply), antisymmetry (compare), additive identity, roundtrip identity (subtract(add(a,b),b)=a), no scientific notation in output
- Sandbox fuzz tests — 20 static escape vectors (constructor chains, prototype walking, eval/Function, Proxy/WeakRef, JSON override, getter traps, globalThis enumeration) + property-based prototype pollution sweep
- Determinism fuzz tests — dual-VM identical results for code, math, state, gas usage, block context
- Resource exhaustion fuzz tests — 12 metering bypass attempts, 4 memory bombs, deep recursion, compilation bombs, wall-clock termination, return value truncation
- CLI fuzz runner (`test/fuzz/run.js`) with per-category filtering
- `npm run test:fuzz` and `npm run fuzz` scripts
- Fuzz testing plan report at `reports/XCHAIN_VM_FUZZ_TESTING_PLAN.md`
- `fast-check` dev dependency for property-based testing

## [1.5.0] - 2026-04-03

### Added
- Boundary test suite (`test/boundary.test.js`) — 106 tests across 15 sections covering gas ceiling, timeout, memory, code size, state management, emissions, logs, return values, math, metering, sandbox escapes, gateway parameters, emit fields, compound interactions, and determinism at boundaries
- Boundary testing plan report at `reports/XCHAIN_VM_BOUNDARY_TESTING_PLAN.md`
- Gas schedule validation — GasTracker constructor rejects non-negative-integer schedule values, `charge()` rejects negative amounts
- State key size limit — new `maxStateKeySize` config (default 1,024 bytes), enforced on `set()` and `delete()`
- Block cache size limit — new `maxBlockCacheSize` config (default 1,000 entries), prevents unbounded cache growth per block
- Code size enforcement at execution — `maxCodeSize` is now checked in `execute()` before metering, not just at deploy time

### Fixed
- **Bridge control character collision** — `bridge()` now JSON-encodes all non-null/undefined return values with `\x01` prefix, preventing user-supplied strings containing `\x01` from being misinterpreted as protocol markers
- **Error classification spoofing** — `_classifyError()` now verifies `\x03`-prefixed error messages against gas tracker state and an execution context revert flag, preventing contracts from spoofing `out_of_gas` or `revert` errors via `throw new Error('\x03GAS:...')`
- **Log truncation byte-awareness** — `addLog()` now uses `Buffer.byteLength()` instead of `string.length` for the 1,024-byte cap, correctly handling multi-byte UTF-8 characters

### Changed
- `gateway.js` `buildGateway()` accepts a 6th `execContext` parameter for revert tracking
- `_classifyError()` accepts a 5th `execContext` parameter for error verification

## [1.4.0] - 2026-04-03

### Added
- End-to-end test suite (`test/e2e/`) — 64 tests across 10 test files covering the full VM execution pipeline
- E2E test infrastructure: MockLedger (in-memory ledger with balances, contract state, oracle, cross-chain, reorg rollback), MockIndexer (processes emitted actions against ledger), E2EHarness (orchestrates deploy/execute cycles with real XChainVM), assertion helpers (15 functions)
- 9 E2E contract fixtures: token_sender, multi_method, amm, vesting, counter, multi_action, sandbox_escape, oracle_conditional, simple_func
- Phase 1 tests: deploy/execute (E2E-001–005), deposit/withdraw lifecycle (E2E-020–023), error handling & recovery (E2E-050–055), state persistence & isolation (E2E-060–064)
- Phase 2 tests: sandbox security enforcement (E2E-030–034), resource limits — gas/OOM/timeout/emission flood/state flood (E2E-040–046), determinism verification across 10 runs and block replay (E2E-080–082)
- Phase 3 tests: AMM swap, vesting time-lock, multi-action emission, sequential counter, conditional branching (E2E-010–014), gas fee accounting (E2E-070–073)
- Phase 4 tests: oracle price reads with conditional logic and staleness checks (E2E-090–091), cross-chain attestation and settlement (E2E-092)
- `npm run test:e2e` script for running E2E tests independently
- `npm run test:all` script for running unit + E2E tests together
- E2E testing plan report at `reports/XCHAIN_VM_E2E_TESTING_PLAN.md`

### Changed
- `npm test` now runs only unit tests (`test/*.test.js`) to keep the default fast; use `test:all` for everything

## [1.3.0] - 2026-04-03

### Added
- Smoke test suite (`test/smoke.test.js`) — 10 fast health-check assertions across 9 scenarios: VM instantiation, sandbox environment, basic contract execution, multi-method dispatch, gateway emit, context accessors, deterministic math, syntax validation, revert/atomicity
- `npm run smoke` script for running smoke tests independently (32ms, < 5s target)
- Smoke testing plan report at `reports/XCHAIN_VM_SMOKE_TESTING_PLAN.md`

## [1.2.0] - 2026-04-03

### Fixed
- Replace `ivm.ExternalCopy` with JSON-based bridge protocol for isolate boundary crossing — fixes "could not be cloned" error when injecting math API functions
- Serialize arguments and return values as JSON strings across isolate boundary, since `applySync` only transfers primitives
- Encode `ContractRevertError` and `GasExhaustedError` type information in error messages so error classification survives isolate boundary crossing
- Preserve `Function` constructor reference through sandbox stripping so `CONTRACT_WRAPPER` can compile contract code
- Bump throwaway isolate `memoryLimit` from 4MB to 8MB (minimum required by current isolated-vm)
- JSON-serialize contract return values inside isolate before crossing boundary, fixing null/object/array returns

### Changed
- Gateway methods injected as individual `bridge()` References instead of `ExternalCopy` bulk transfer
- Math API injected as 15 individual bridge References instead of single `ExternalCopy` object
- `__gas` Reference now encodes `GasExhaustedError` for correct error classification

## [1.1.0] - 2026-04-03

### Added
- 5 new test files: errors.test.js, validator.test.js, gateway-emit.test.js, isolate.test.js, index.test.js
- Unit tests for all 16 emit action types with required field validation coverage
- Unit tests for ActionValidator (allowed/unknown actions, params validation)
- Unit tests for ContractRevertError and GasExhaustedError error classes
- Unit tests for IsolateManager (create, compile, dispose, cached data)
- Comprehensive XChainVM orchestration tests (result structure, atomicity, return value serialization, method routing, error classification, context accessors, balance/tokenInfo, oracle, crossChain, logging, compilation cache, all 16 emit types integration)
- Extended gas.test.js with zero/boundary charge tests
- Extended math.test.js with precision, negative zero, scientific notation, mod edge cases
- Extended state.test.js with exact limit boundaries, UTF-8, empty key, type coverage, insertion order
- Extended collector.test.js with exact emission/log boundaries, truncation accuracy
- Extended metering.test.js with deep binary expressions, combined constructs, arrow variants, directive prologues
- Extended sandbox.test.js with WeakRef, Proxy, SharedArrayBuffer, Atomics, Math freeze, indirect eval, Function constructor, xchain freeze
- Extended determinism.test.js with math ops, emit ops, 5-run consistency
- Extended syntax.test.js with empty code, comments, __gas variants, ES2020 features
- Unit testing plan report at reports/XCHAIN_VM_UNIT_TESTING_PLAN.md

### Changed
- README: add documentation table linking to xchain-documentation (action specs, concepts, indexer schema, fee schedule)

## [1.0.0] - 2026-04-03

### Added
- XChainVM class with `execute()`, `validateSyntax()`, `checkFloatWarnings()`, `beginBlock()`/`endBlock()` API
- Sandboxed V8 isolate execution via isolated-vm with all non-deterministic APIs stripped
- AST-based gas metering via acorn/acorn-walk/astring — injects `__gas()` calls at control flow points
- Gateway object (`xchain.*`) with state CRUD, balance/token queries, oracle/cross-chain stubs, emit API, deterministic math, revert/require, logging
- 16 emittable action types: SEND, DESTROY, ISSUE, MINT, ORDER, DISPENSER, DIVIDEND, AIRDROP, CALLBACK, FILE, LIST, COINPAY, SWEEP, LINK, BROADCAST, MESSAGE
- Deterministic math (`xchain.math.*`) wrapping mathjs bignumber with string I/O
- StateManager with dirty tracking, key count limits, value size limits, delete-then-set cycle support
- EmissionCollector with configurable emission cap and log collection (100 entries, 1KB each)
- ActionValidator for pre-validation of emitted actions
- Deploy-time syntax validation (V8 + acorn), reserved identifier detection (`__gas`), float usage warnings
- Per-block compilation cache using V8 `createCachedData()`/`cachedData` for hot contracts
- ContractRevertError and GasExhaustedError error classification
- 81 unit tests covering metering, gas, math, state, collector, compilation, sandbox, gateway, limits, determinism, syntax
- 13 fixture contracts: simple_send, state_counter, amm_swap, vesting, multi_method, infinite_loop, memory_bomb, sandbox_escape, emit_flood, state_flood, bad_math, compile_bomb, oracle_read
