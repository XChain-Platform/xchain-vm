# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- PRICE_MAX and ORACLE_DEVIATION_THRESHOLD are now covered by the cross-repo value-equality gate.
- Corrected the changelog's armed flag-day timestamp for ASYNC_SURFACE_GATE_BLOCK_TIME.
- Pinned the lockfile's Node engine ceiling to match the manifest so a reinstall cannot resolve on an unsupported Node version.
- Aligned the code-size gate with the chain, switched timeout corroboration to a monotonic clock, unified the simulator's max-code-size constant, and added missing license headers to three test files.

### Added
- Added AI-assisted contract authoring that builds prompts from a knowledge base and runs a model's reply through the deploy gate with an automatic repair loop.
- Added a developer toolkit (`xchain-foundry` and `create-xchain-contract`) with a local contract simulator, a determinism gate and gas profiler, TypeScript authoring support, and a project scaffolder.
- Confirmed the contract-era flag-day timestamps for the async-surface and binary-allocation gates, in lockstep with the indexer.
- The linter now enforces the code-size cap and flags sandbox-neutered prototype methods, matching the CLI.

### Changed
- Bound the validator's unit tests to the full allowed-actions list so every production-allowed emission is exercised and drift can no longer pass green.
- The E2E harness now models per-tick decimals for emitted amounts, mirroring indexer precision.

### Fixed
- Guarded `JSON.parse` against reviver recursion depth so contracts can no longer trigger a host-stack-dependent error.
- Fixed a metering bypass where a non-finite gas charge billed almost nothing instead of the maximum charge.
- Updated reserved-identifier comments to reference their source lists instead of a hand-copied subset that had drifted.

## [1.11.14] - 2026-07-16

### Fixed
- Corrected the README's emittable-actions count to 19, including VOTE, matching the implementation.

## [1.11.13] - 2026-06-20

### Added
- Added a determinism fixture pinning the paid-attestation emission path.
- Extended the determinism regression suite to cover cross-contract and cross-chain call paths, pinning their gas charges and call-id derivation.
- Wired the new determinism regression files into the CI script so a stale pinned baseline fails the build.
- Extended the determinism regression suite to cover the staking and attestation host methods.
- Added fuzz-test contract templates exercising the contract and attestation host call sites.
- Added regression tests pinning the exact gas cost per loop iteration.

### Changed
- Changed cross-chain call-id derivation to drop a non-deterministic input so all nodes compute the same value.
- Consolidated scattered ECMAScript-version literals into a single exported constant.
- Added an explanatory reason to a lint-disable directive in the determinism test suite.
- Pinned `acorn-walk` to an exact version instead of a caret range.
- Extracted the max-code-size limit into an exported constant so other services can assert it matches the protocol value.

### Fixed
- Gated the binary-allocation gas charge behind a flag-day timestamp so the whole fleet flips the rule atomically.
- Bounded intra-contract recursion with a deterministic, platform-independent stack-depth limit.
- The VM now throws at construction for an unrecognized execution mode, and warns once when the mode is omitted.
- Fixed the subprocess watchdog to start on dispatch rather than acceptance, so a queued request can no longer trigger a false resource-exhaustion clamp.
- Enforced a per-provider deadline ceiling so an over-limit attestation request is rejected at call time instead of silently dead-lettered.
- Added a gas charge at the script's top-level entry point so top-level initializers are no longer free.

## [1.11.12] - 2026-05-30

### Security
- Stripped `performance.now()` from the sandbox, closing another wall-clock non-determinism source.

## [1.11.11] - 2026-05-29

### Fixed
- Fixed a falsy-zero bug that gave contract index 0 a colliding attestation request id.

## [1.11.10] - 2026-05-29

### Security
- The gas tracker now validates that a gas schedule includes every canonical key, failing loudly instead of silently diverging.
- Added regression tests for gas-schedule validation and updated test harnesses with the missing gas key.

## [1.11.9] - 2026-05-29

### Security
- Stripped `Intl` from the sandbox to prevent locale-sensitive output from diverging state hashes across the validator fleet.
- Pre-emptively stripped `Temporal` and `structuredClone` for the same reason.
- Added regression tests asserting those APIs are undefined inside a live isolate.

## [1.11.8] - 2026-05-28

### Added
- Added regression tests asserting the stripped math transcendentals are undefined and throw inside a live isolate.

## [1.11.7] - 2026-05-28

### Security
- Removed floating-point transcendental functions from the sandbox math to eliminate cross-architecture divergence that could split consensus.
- Added deterministic bignumber-backed replacements for those functions.
- Deploy-time validation now rejects contracts that reference the banned native math functions.

## [1.11.6] - 2026-05-28

### Security
- Pinned the `tmp` dependency to remediate a path-traversal vulnerability (GHSA-ph9p-34f9-6g65).

## [1.11.5] - 2026-05-28

### Security
- The gas tracker now rejects non-finite charge amounts instead of silently zeroing out metering.

## [1.11.4] - 2026-05-28

### Security
- Pinned the `qs` dependency to remediate a denial-of-service vulnerability (GHSA-q8mj-m7cp-5q26).

## [1.11.3] - 2026-05-28

### Fixed
- Added `SLASH` to the allowed-actions set so slashing calls no longer fail and discard their state changes.

### Changed
- Derived the validator's test cases from the full allowed-action set to guard against silent drift.

## [1.11.2] - 2026-04-06

### Changed
- Moved the coverage badge to its own line in the README for cleaner formatting.

## [1.11.1] - 2026-04-05

### Changed
- Moved the mutation-testing config and custom mutator into `test/mutation/`.
- Updated the mutation npm scripts to match the new paths.
- Reorganized the flat test directory into topic subdirectories.
- Added integration, boundary, and security test scripts.
- Changed the default test script to run only unit tests.

## [1.11.0] - 2026-04-03

### Added
- Added a tiered regression test suite covering critical VM execution, security, and platform actions.
- Added shared regression test helpers that fail loudly instead of silently skipping when the VM binding is unavailable.
- Added a P0 smoke regression tier covering VM instantiation and core execution paths.
- Added a P1 security regression tier covering blocked globals, sandbox escapes, and gas-bypass attempts.
- Added a P2 functional regression tier covering gas metering, state, emissions, and validation.
- Added a P3 integration regression tier covering resource limits and the full execution pipeline.
- Added regression npm scripts for each tier and a combined nightly and release run.
- Documented the regression testing scope, strategy, and maintenance plan.

## [1.10.0] - 2026-04-03

### Added
- Added mutation-testing infrastructure using Stryker with per-test coverage analysis.
- Added five custom VM-specific mutation operators targeting patterns Stryker's built-in mutators cannot reach.
- Added a standalone custom mutation runner that reports kill/survive results with progress output.
- Added a mutation report generator that merges results into a per-module summary with recommendations.
- Added mutation npm scripts for full, tiered, custom, and incremental runs.
- Configured Stryker with multiple reporters and tiered score thresholds.
- Documented the mutation testing plan.

## [1.9.0] - 2026-04-03

### Added
- Added a 3-phase chaos engineering test suite targeting VM resilience, fault tolerance, and recovery.
- Added phase 1 chaos tests covering memory exhaustion, gateway atomicity, hangs, and corrupted state.
- Added phase 2 chaos tests covering concurrent isolate load, memory leaks, and rapid block cycling.
- Added phase 3 chaos tests covering parser divergence and math precision boundaries.
- Added chaos test helpers for fault injection, heap tracking, and recovery verification.
- Added programmable mock oracle and cross-chain providers with per-method fault rules.
- Added four adversarial test contracts for chaos testing.
- Documented the chaos engineering plan and failure-point inventory.
- Added chaos npm scripts for the full suite and each phase.

## [1.8.0] - 2026-04-03

### Added
- Added a performance benchmark suite with a harness, tiered contracts, and scenario scripts.
- Added pipeline microbenchmarks measuring metering and execution latency.
- Added gateway benchmarks isolating per-call overhead for state, emit, math, and logging.
- Added a block throughput benchmark simulating blocks of varying size and complexity.
- Added a soak test monitoring memory and throughput stability under sustained load.
- Added a benchmark measuring compilation-cache effectiveness at varying hit rates.
- Added quick, full, and soak benchmark npm scripts.

## [1.7.0] - 2026-04-03

### Added
- Documented a security risk register covering 19 risks with prioritized mitigations.
- Added a security test suite covering sandbox escapes, error spoofing, gas bypass, prototype pollution, and information leakage.
- Enforced string types on emit parameter fields.
- Added a math input length limit to prevent a bignumber denial-of-service.

### Fixed
- Closed a sandbox escape via the prototype chain by neutering built-in constructor properties.
- Closed a sandbox escape via generator and async function constructors.
- Removed the `Reflect` API from the sandbox.
- Fixed error-type spoofing by classifying reverts from stored context instead of a catchable error message.
- Closed a gas-metering bypass by making the metering callback non-writable and non-configurable.
- Closed unmetered getter/setter traps by removing property-definition APIs from the sandbox.
- Removed the `RegExp` constructor from the sandbox to prevent catastrophic backtracking; regex literals still work.
- Closed prototype pollution in the state store by using a null-prototype object.
- Closed prototype pollution in emission parameters by copying into a null-prototype object and stripping dangerous keys.
- Sanitized generic error messages to strip file paths and truncate length, closing an information leak.
- Fixed variable leakage into contract scope by block-scoping harness internals.
- Fixed a crash when several emit methods received null parameters.

### Changed
- Expanded the sandbox strip list with additional constructor neutering and property-definition removal.
- Gateway revert and require calls now store their reason in the execution context.
- Error classification now uses execution context state instead of error message text.
- Added a method for sanitizing generic error messages.
- Added an input-length validator applied to all math operations.

## [1.6.0] - 2026-04-03

### Added
- Added a property-based fuzz testing suite using fast-check.
- Added a shared fuzz test harness with deterministic result hashing and a configurable iteration count.
- Added invariant checkers for result shape, atomicity, resource limits, and determinism.
- Added input generators for mutated code, arguments, emission payloads, state, and math edge cases.
- Added fuzz tests for gas/revert spoofing and AST mutation resilience.
- Added fuzz tests for argument injection and parameter shape invariants.
- Added fuzz tests for emission parameter validation and cap enforcement.
- Added fuzz tests for state input validation and isolation.
- Added fuzz tests asserting deterministic math properties.
- Added fuzz tests sweeping sandbox escape vectors and prototype pollution.
- Added fuzz tests asserting identical results across dual VM instances.
- Added fuzz tests for resource exhaustion and metering bypass attempts.
- Added a CLI fuzz runner with per-category filtering.
- Added fuzz npm scripts.
- Documented the fuzz testing plan.
- Added `fast-check` as a dev dependency for property-based testing.

## [1.5.0] - 2026-04-03

### Added
- Added a boundary test suite covering resource limits, sandbox escapes, and determinism at their edges.
- Documented the boundary testing plan.
- The gas tracker now rejects invalid schedule and charge values.
- Added a configurable state key size limit.
- Added a configurable block cache size limit to prevent unbounded growth.
- Code size is now enforced at execution time, not only at deploy time.

### Fixed
- Fixed a collision between user-supplied strings and an internal protocol marker by JSON-encoding bridged return values.
- Fixed error classification spoofing by verifying protocol-marker error messages against actual gas and revert state.
- Fixed log truncation to count bytes instead of characters, correctly handling multi-byte UTF-8.

### Changed
- The gateway builder now accepts an execution context parameter for revert tracking.
- Error classification now accepts an execution context parameter for verification.

## [1.4.0] - 2026-04-03

### Added
- Added an end-to-end test suite covering the full VM execution pipeline.
- Added end-to-end test infrastructure: a mock ledger, mock indexer, execution harness, and assertion helpers.
- Added nine end-to-end contract fixtures covering common and adversarial patterns.
- Added phase 1 end-to-end tests for deploy/execute, deposit/withdraw, error recovery, and state persistence.
- Added phase 2 end-to-end tests for sandbox enforcement, resource limits, and determinism across runs and block replay.
- Added phase 3 end-to-end tests for complex contract workflows and gas fee accounting.
- Added phase 4 end-to-end tests for oracle reads and cross-chain attestation.
- Added an end-to-end test npm script.
- Added a combined unit and end-to-end test npm script.
- Documented the end-to-end testing plan.

### Changed
- Changed the default test script to run only unit tests for speed.

## [1.3.0] - 2026-04-03

### Added
- Added a fast smoke test suite covering core health-check scenarios.
- Added a smoke test npm script.
- Documented the smoke testing plan.

## [1.2.0] - 2026-04-03

### Fixed
- Replaced the isolate boundary-crossing mechanism with a JSON-based bridge protocol, fixing a cloning error.
- Serialized arguments and return values as JSON across the isolate boundary.
- Encoded error type information in error messages so classification survives the isolate boundary.
- Preserved the `Function` constructor through sandbox stripping so contract code can still compile.
- Raised the throwaway isolate's memory limit to meet the current minimum requirement.
- Fixed null, object, and array return values by JSON-serializing them before crossing the isolate boundary.

### Changed
- Gateway methods are now injected individually instead of as a bulk transfer.
- The math API is now injected as individual references instead of a single bulk object.
- The gas-charge reference now encodes its error type for correct classification.

## [1.1.0] - 2026-04-03

### Added
- Added five new unit test files covering errors, the validator, emit, isolate management, and orchestration.
- Added unit tests for every emit action type's required field validation.
- Added unit tests for the action validator.
- Added unit tests for the custom error classes.
- Added unit tests for isolate lifecycle management.
- Added comprehensive orchestration tests for the main VM class.
- Extended gas tests with zero and boundary charge cases.
- Extended math tests with precision and edge-case coverage.
- Extended state tests with boundary and encoding coverage.
- Extended collector tests with boundary and truncation coverage.
- Extended metering tests with complex expression coverage.
- Extended sandbox tests with additional escape vector coverage.
- Extended determinism tests with multi-run consistency checks.
- Extended syntax tests with additional edge cases.
- Documented the unit testing plan.

### Changed
- Added a documentation table to the README linking to protocol references.

## [1.0.0] - 2026-04-03

### Added
- Added the initial `XChainVM` class with its execution and validation API.
- Added sandboxed V8 isolate execution with non-deterministic APIs stripped.
- Added AST-based gas metering that injects charges at control flow points.
- Added the `xchain` gateway object exposing state, balances, oracle/cross-chain stubs, emit, math, and logging.
- Added sixteen emittable action types.
- Added deterministic math wrapping bignumber arithmetic with string input and output.
- Added a state manager with dirty tracking and configurable limits.
- Added an emission collector with a configurable cap and log collection.
- Added an action validator for pre-validating emitted actions.
- Added deploy-time syntax validation with reserved-identifier detection and float usage warnings.
- Added a per-block compilation cache for hot contracts.
- Added typed revert and gas-exhaustion error classes.
- Added the initial unit test suite covering the core VM modules.
- Added thirteen fixture contracts for testing.
