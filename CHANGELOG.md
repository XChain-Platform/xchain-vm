# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
