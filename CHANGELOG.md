# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `test/regression/contract-host-fixtures.js` / `test/regression/determinism.test.js` / `test/regression/determinism-baseline.test.js` / `test/regression/DETERMINISM_BASELINE.json` — extended the determinism regression suite to cover the two cross-contract/cross-chain call emit paths, previously absent from both the run-twice and pinned-baseline layers despite being the most complex gas-charging code in the VM. `xchain.emit.execute` is exercised at call depths 1–4 (one fixture per depth, pinning the atomic `VM_EMISSION + gasLimit` charge, the `remaining = ceiling − used` guard, the queued `EXECUTE` emission, and the `getCallDepth()` threading) plus a depth-5 fixture pinning the deterministic depth-gate throw that must fire before any gas is reserved. `xchain.emit.crossExecute` is exercised with valid params, pinning the 4-bucket `VM_EMISSION + VM_XCALL_REQUEST + gasLimit + VM_XCALL_CALLBACK` charge and the deterministic `callId` (the full `network:chain:txHash:actionIndex:contractIndex:emissionIndex:targetChain` sha256 preimage, every input pinned via fixture opts). A `gasUsed` or `callId` regression in `src/gateway-emit.js` directly diverges `contract_executions.gas_used` and therefore the per-block contracts hash across validators, so these paths must fail CI rather than fork consensus. Both determinism suites' `GAS_SCHEDULE` (and the shared regression `helpers.js` schedule) gained the `VM_XCALL_REQUEST: 2000` / `VM_XCALL_CALLBACK: 20000` keys at the production per-chain config values, so the pinned baselines are computed against the production schedule rather than `gateway-emit.js`'s fallback defaults. The run-twice fixture loop now honours an `expectSuccess: false` fixture flag so deterministic-failure fixtures (the depth gate) assert hash equality without demanding success.
- `package.json` — the per-commit `ci` script now runs `test/regression/determinism.test.js` and `test/regression/determinism-baseline.test.js`. Neither file matched any `ci` glob before (they only ran under `test:all`), which is how a stale pinned digest could sit unnoticed: the committed baseline for `inline:attestation-request` predated the attestation `request_id` preimage gaining `actionIndex` and no longer matched the VM's actual output. The regenerated baseline corrects that one stale digest; all other pre-existing digests are byte-identical. Regenerate with `REGEN_DETERMINISM_BASELINE=1` when behaviour intentionally changes.
- `test/regression/determinism.test.js` / `test/regression/determinism-baseline.test.js` / `test/regression/DETERMINISM_BASELINE.json` — extended the determinism regression suite to cover the six contract-targeted staking and external attestation host methods that previously had no run-twice or pinned-baseline coverage: `xchain.contract.getStake` / `getTotalStaked` / `getStakers` (charge `VM_STATE_READ`), `xchain.contract.slash` (charges `VM_EMISSION`, emits a `SLASH` action), `xchain.attestation.request` (charges `VM_ATTEST_REQUEST + VM_EMISSION`, emits `ATTEST` and returns a deterministic `request_id`), and `xchain.attestation.getResponse` (charges `VM_STATE_READ`). These methods run on every chain in the indexer EXECUTE path, so a regression in their gas charging, response serialisation, or `__gas` injection would previously have surfaced only as an on-chain block-hash divergence rather than a failing CI gate. Added one minimal inline contract per method family — shared between the run-twice and pinned-baseline suites via the new `test/regression/contract-host-fixtures.js` so both exercise byte-identical code and identical injected accessor data (deterministic stand-ins for the indexer's `contractStakeData` / attestation-response providers) — and pinned a SHA-256 digest for each in `DETERMINISM_BASELINE.json`. All seven pre-existing digests are unchanged. Regenerate with `REGEN_DETERMINISM_BASELINE=1` when behaviour intentionally changes.
- `test/fuzz/generators/code.js` — added four valid contract templates that exercise `xchain.contract.*` and `xchain.attestation.*`, so the fuzz determinism/emission/code suites now reach these host call sites instead of skipping them. The templates run with the host's null-guarded defaults (no injected stake/attestation data) and so remain deterministic and invariant-safe.
- `test/unit/metering.test.js` — added a "per-iteration gas cost (regression pin)" test group that asserts the exact per-iteration gas charged by each loop kind. An indexed `for` loop is metered **twice** per iteration — once at the top of the loop body and once in the update expression (`for (…; i++)` is rewritten as `for (…; (__gas(1), i++))`) — so a `for` loop of N iterations costs `2 × N × VM_COMPUTATION`, while a `while` loop of N iterations costs `1 × N × VM_COMPUTATION`. The tests execute the metered output with a `__gas` stub that mirrors `src/index.js` (each injected call charges `VM_COMPUTATION` via `GasTracker.chargeComputation()`) and assert the exact totals — including a `for` loop with no author-written update, which still receives a synthesized update-slot charge. This pins the current double-charge behaviour against silent regression. No production code changed; the behaviour is deterministic and identical on every node.

### Changed
- `src/metering.js`, `src/syntax.js` — the contract language version is now an explicit, frozen consensus constant (`CONTRACT_ECMA_VERSION = 2020`) instead of five independently hardcoded `ecmaVersion: 2020` acorn options scattered across the metering transform, the reserved-identifier scan, deploy-time validation, and the two lint scans. The version choice is deliberate, not an accident of an old acorn default: V8 on the pinned Node runtime accepts a superset of ES2020, so everything acorn accepts parses identically at execution time and the only effect of the gap is that post-2020 syntax (logical assignment, class static blocks, …) is rejected at deploy — a DX limitation, never a consensus divergence; the deploy error names the standard (`unsupported syntax (ES2020 maximum)`). Bumping the constant is a protocol migration (the metering transform must be re-verified against every AST node type the new version introduces), and the new regression suite pins it: the constant equals 2020 with a migration-checklist assertion message, no parse site may hardcode an `ecmaVersion` outside the constant, ES2020 idioms meter/validate normally, and ES2021/ES2022 syntax is rejected by both `meterCode` and `validateSyntax` with the standard-naming error.

### Fixed
- `src/index.js`, `src/metering.js` — intra-contract recursion is now bounded by a deterministic, in-isolate call-depth limit, so the depth a contract can reach is no longer the platform's native V8 stack depth. Previously the only normalization of a recursion overflow was the host-side `out_of_stack` clamp, which fires solely when the native `RangeError` propagates to the host; a contract that *catches* the overflow itself (`function f(n){ try { return f(n+1); } catch(e){ return n; } }`) never reached that clamp and instead observed the raw native stack depth as a plain integer. That depth depends on CPU architecture (the engine supports linux/arm64 and linux/amd64) and on the host stack remaining when execution begins, so a contract that committed the caught depth into state (`x.state.set('depth', String(f(0)))`) would diverge validators on different machines → divergent `contract_hash` → chain fork. The `MAX_CALL_DEPTH` constant (value 4) only bounds cross-contract `emit.execute` chains, never intra-contract recursion, so this path was unguarded. The metering pass now wraps every contract function body as `__depth_enter(); try { <body> } finally { __depth_exit(); }` (Phase 4, run after all `__gas()` injection so depth bounding is gas-free and existing contracts' gas costs are unchanged), and the isolate harness enforces a fixed, platform-independent limit (`MAX_STACK_DEPTH`, 512 — chosen well below the smallest native V8 stack limit across supported platforms so it always fires first) on those hooks. The fault it throws is un-swallowable: once tripped it poisons the metering choke point, so the `__gas(1)` injected at the top of every `catch` block re-throws — a contract cannot catch the fault, resume, and read a depth value, exactly as gas exhaustion cannot be swallowed. The fault carries a "call stack" message so it normalizes to the same deterministic `out_of_stack` status as a native overflow, with `gasUsed` clamped to the ceiling. `__depth_enter`/`__depth_exit` are reserved identifiers (rejected at deploy time) and locked non-writable/non-configurable in the isolate. New coverage: a try/catch recursion fixture (`test/contracts/catch_recursion.js`) and `test/determinism/stack-depth-determinism.test.js` asserting the catch-the-overflow contract fails deterministically with `out_of_stack`, commits no state, and produces an identical result hash across runs, while legitimate bounded recursion still succeeds; the reserved-identifier and global-leak suites were extended for the two hooks.
- `src/index.js` — the constructor's execution mode is now validated at construct time. With the previous bare `config.execution || 'in-process'` fallback, any unrecognized value — a typo like `'subproces'`, `'sub-process'`, a trailing space — silently selected in-process mode, dropping the host-crash (SIGABRT) containment that subprocess mode exists to provide; a production embedder could believe it had opted in while running uncontained. Unknown mode strings now throw `XChainVM: unknown execution mode ...` at construct time. Separately, an embedder that never sets `execution` at all now gets a once-per-process `console.warn` stating that the in-process default has no SIGABRT containment and that production embedders must pass `execution: 'subprocess'` — passing `execution: 'in-process'` explicitly acknowledges the trade-off and silences it (the in-child worker `vm-worker.js` and the test harnesses already choose explicitly). The default itself is unchanged: in-process callers pass closure accessors that cannot cross IPC, so flipping the default would break legitimate embedders; the production wiring (`xchain-indexer` passes `execution: 'subprocess'`) is unaffected. New unit coverage in `test/unit/execution-mode.test.js`: explicit in-process accepted silently, six malformed mode values throw, the implicit-default warning fires exactly once per process and names the fix.
- `src/process-executor.js` — the subprocess watchdog now starts when a request is DISPATCHED to the worker, not when `execute()` accepts it. Started at acceptance, the timeout bounded queue-wait + execution, so a validator whose executor queue was backed up (many contracts in one block, a slow host, a worker respawn in progress) could hit the watchdog for a contract that was still waiting its turn and fabricate the deterministic `out_of_resource` clamp — while every other validator executed the same contract to completion. `out_of_resource` is a committed, fork-relevant status, so one backed-up node diverged its contract status (and contracts-hash) from the fleet: a fork caused by host load, not contract behaviour. The watchdog timer is now created in `_flush()` at the moment the request is sent to a ready worker, so it bounds a single contract's execution only — the stuck-isolate/native-deadlock belt it was always meant to be — and queue wait can never expire a request. The pre-dispatch path is instead covered by a new worker-readiness timeout (`WORKER_READY_TIMEOUT_MS`, 30s): a spawned child that never signals `ready` is killed and counted as a spawn failure, feeding the existing broken-latch machinery that rejects queued work with `HostFaultError` — a halt-and-retry local fault, never a fabricated consensus result. Regression tests: a request held queued across 3+ watchdog windows must run and succeed once the worker is dispatchable (the fork case), and a dispatched request on a frozen (`SIGSTOP`) worker is still watchdog-terminated with the deterministic clamp, after which the executor respawns and keeps serving.
- `src/gateway.js` / `src/index.js` — `xchain.attestation.request()` now enforces a per-provider `deadlineBlocks` ceiling at contract call time when the host injects one. The gateway previously validated `deadlineBlocks` only against the platform-wide `[1, 100]` cap, regardless of which provider the contract named. A provider whose deadline window is narrower than 100 (e.g. a judge-model provider capped at 20 blocks) would accept a request with `deadlineBlocks` in `(window, 100]` at the VM layer, queue the `ATTEST v0` emission, and return a `request_id` — but the request was then rejected downstream by the host's structural deadline check and silently dead-lettered, so the contract's callback was never invoked and there was no call-time error. `execute()` now accepts an optional `opts.providerDeadlines` map (`{ [providerId]: maxDeadlineBlocks }`), threaded into the gateway via `readOnlyData.providerDeadlines`; `attestation.request()` looks up the named provider's window and throws `deadlineBlocks N exceeds the "<provider>" provider window of M blocks` when it is exceeded, before any emission is queued. The `[1, 100]` cap is retained as a platform-wide safety net, and the per-provider check is skipped for any provider id absent from the injected map (leaving the host's own known-provider validation authoritative), so behaviour is unchanged when no map is supplied. Added regression tests in `test/integration/gateway-attestation.test.js` covering an over-limit request (rejected with no emission), an at-the-limit request, a wider-window provider, and the no-map fallback.

### Changed
- `test/determinism/golden.determinism.test.js` — added an explanatory reason to the bare `// eslint-disable-next-line no-console` directive above the determinism-verification banner (`-- intentional test progress output`), so the suppression is self-documenting. Test-only; no behavior change.
- `package.json` — pinned `acorn-walk` 8.3.5 to the exact version already frozen in `package-lock.json` (dropped the `^` caret range). This was the one remaining unpinned runtime dependency; all other deps in this service were already exact-pinned, and the lockfile resolution is unchanged. No source changes.
- `src/index.js` — the contract code-size limit (`maxCodeSize`, 64 KiB) is now declared as an exported module constant `MAX_CODE_SIZE` and referenced from the default `limits` object instead of an inline literal. No behavior change — the value is identical — but the constant is now importable, so the cross-service regression suite can assert it has not drifted from the canonical protocol value in `xchain-documentation/protocol/constants.js` (kept equal across the SDK, indexer, and VM).

## [1.11.13] - 2026-05-30

### Fixed
- `src/metering.js` — `meterCode` now charges gas at the top-level script entry point. The metered source is executed as a function body (`new __Fn('module', 'exports', 'xchain', meteredCode)`), but Phase 1 only injected `__gas()` into the bodies of `FunctionDeclaration` / `FunctionExpression` / `ArrowFunctionExpression` — never into the top-level `Program.body`. As a result, pure top-level statements with no embedded calls (variable declarations, object-literal initializers, plain assignments — e.g. `const lookup = { a: 1, …, z: 26 };`) executed entirely uncharged. Function calls in top-level code were already charged by Phase 3's `CallExpression` wrapping, so the gap was confined to call-free top-level initializers — a mild denial-of-service vector for contracts that front-load computation into module-scope initializers. The fix inserts a single `insertGasAfterDirectives(ast.body)` call at the start of Phase 1, reusing the same helper already applied to function bodies (so any top-level directive prologue such as `"use strict"` is correctly skipped). The change is deterministic and applied identically on every node, so there is no consensus-divergence risk; the practical blast radius was already bounded by the 64 KB code-size cap enforced before metering runs. Added regression tests in `test/unit/metering.test.js` asserting a call-free top-level declaration is gas-charged and that the entry-point charge follows a top-level `"use strict"` directive. Regenerated `test/regression/DETERMINISM_BASELINE.json` — every corpus contract's `gasUsed` rises by exactly the one new entry-point charge.

## [1.11.12] - 2026-05-30

### Security
- `src/sandbox.js` — added `'performance'` to the `STRIP_SCRIPT` `toDelete` list, so the Web Performance API is neutralised in the isolate alongside `Date`, `Intl`, `Temporal`, and `structuredClone`. `performance.now()` returns wall-clock microseconds — a pure non-determinism source that, if reachable inside a contract, would diverge state hashes across a heterogeneous validator fleet. A bare V8 isolate likely does not expose `performance` today, but V8 10.4+ ships a minimal `performance` stub for Wasm tooling that could surface on newer host builds; the strip is a no-op when the global is absent and a critical guard when present, so it is applied pre-emptively. Added integration tests in `test/integration/sandbox.test.js` asserting `typeof performance === 'undefined'` and that `performance.now()` is inaccessible inside a contract.

## [1.11.11] - 2026-05-29

### Fixed
- `src/gateway.js` / `src/index.js` — the deterministic attestation `request_id` is derived from a `(tx_hash, contract_index, emission_index)` preimage, but a falsy coercion (`contractIndex || ''` in `gateway.js`, `opts.contractIndex || null` in `index.js`) collapsed `contractIndex === 0` — the first contract in a block — into the same preimage as an absent `contractIndex`. Index 0 therefore produced a `request_id` indistinguishable from `undefined`, breaking the documented per-triple uniqueness guarantee. Both sites now use an explicit `!= null` check (`readOnlyData.contractIndex != null ? Number(...) : ''` and `opts.contractIndex != null ? Number(...) : null`), so index 0 contributes `'0'` to the preimage as intended. The fix must reach both sites together: `index.js` populates the `contractIndex` that `gateway.js` reads, so correcting only the gateway would have left index 0 coerced to `null` before it ever arrived. The compilation cache-key in `index.js` was switched to the same explicit form for consistency (no behavioural change there). Added a regression test in `test/integration/gateway-attestation.test.js` asserting that `contractIndex = 0` yields a `request_id` distinct from an omitted `contractIndex`. Must be deployed in lockstep with the indexer-side guard fix — a mixed-version fleet would disagree on the `request_id` for any contract at index 0.

## [1.11.10] - 2026-05-29

### Security
- `src/gas.js` — the `GasTracker` constructor now validates that the supplied gas schedule contains every key the VM charges against. A new `CANONICAL_GAS_KEYS` set enumerates the eight metered operations (`VM_COMPUTATION`, `VM_STATE_READ`, `VM_STATE_WRITE`, `VM_STATE_DELETE`, `VM_ORACLE_READ`, `VM_CROSSCHAIN_READ`, `VM_ATTEST_REQUEST`, `VM_EMISSION`); construction throws `gas schedule is missing required key: <key>` if any are absent. Previously a schedule that omitted a charged key passed validation and only failed later — when a contract first hit that operation deep in execution — which meant two operators whose schedules disagreed on a key could silently reach divergent contract outcomes (different `gasUsed`, different state) on the same block. The check turns that latent, execution-time, fleet-divergent failure into a deterministic, loud error at VM construction. Extra keys are intentionally tolerated: the VM is a generic library and its caller passes the full protocol fee schedule, which legitimately carries keys the VM never charges (e.g. `ISSUE`, `OWNERSHIP_ESCROW`, `VM_DEPLOY_*`). `CANONICAL_GAS_KEYS` is exported for callers/tests.
- Added regression tests in `test/unit/gas.test.js` asserting that (a) a schedule missing any single canonical key throws at construction, (b) a schedule carrying extra non-charged keys is accepted, and (c) the complete canonical schedule is accepted. Test, integration, e2e, fuzz, chaos, boundary, security, smoke and bench harness schedules were updated to include `VM_ATTEST_REQUEST` so they continue to construct a complete schedule.

## [1.11.9] - 2026-05-29

### Security
- Strip `Intl` from the sandbox isolate (`src/sandbox.js` `toDelete`). `Intl` (ECMAScript 402) is locale-sensitive and its output depends on the ICU data compiled into the host Node.js binary — full-icu vs small-icu builds, and the ICU version bundled with each Node.js release, format the same value differently (`new Intl.NumberFormat('de').format(1234.5)` yields `'1.234,5'` on one build and `'1,234.5'` on another). A contract using `Intl` would therefore diverge state hashes across a heterogeneous validator fleet, i.e. split consensus. It is now `undefined` inside the isolate alongside the other non-deterministic globals.
- Pre-emptively strip `Temporal` and `structuredClone` for the same non-determinism class: `Temporal` exposes time-zone-sensitive output, and `structuredClone`'s serialization edge cases have varied across V8 versions. Neither is currently guaranteed present in the isolate, but stripping them now prevents a future V8 build from silently exposing a divergent surface.
- Added runtime regression tests in `test/integration/sandbox.test.js` asserting `Intl`/`Temporal`/`structuredClone` are `undefined` inside the live isolate, plus an explicit check that `new Intl.NumberFormat('de').format(1234.5)` throws inside a contract.

## [1.11.8] - 2026-05-28

### Added
- Runtime regression tests in `test/integration/sandbox.test.js` asserting the stripped transcendentals (`pow`, `log`, `log2`, `log10`, `sqrt`) are `undefined` inside the live isolate, plus an explicit check that calling `Math.pow(2.1, 1.5)` throws inside a contract. This complements the existing deploy-time `validateSyntax()` rejection by verifying the `SafeMath` strip at the execution layer itself, so a reintroduction of any of these into the sandbox `Math` is caught even if the syntax validator is bypassed or changed.

## [1.11.7] - 2026-05-28

### Security
- Removed the IEEE 754 transcendental functions (`sqrt`, `pow`, `log`, `log2`, `log10`) from the sandbox's `SafeMath` object in `src/sandbox.js`. IEEE 754 only mandates correctly-rounded results for `sqrt` — not for `pow`/`log`/`log2`/`log10` — so the host libm can differ by 1 ULP across CPU architectures (e.g. x86-64 vs ARM64). A 1-ULP difference in a serialized contract result is enough to diverge state hashes across a heterogeneous validator fleet, i.e. split consensus. The retained `SafeMath` members (`floor`/`ceil`/`round`/`abs`/`min`/`max`/`sign`/`trunc` and the `PI`/`E` constants) are exact, spec-defined operations and remain available.
- Added deterministic, architecture-independent replacements under `xchain.math`: `sqrt`, `pow`, `log`, `log2`, `log10`, backed by mathjs bignumber (pure-software arithmetic, bit-identical on every platform). Results that are not real and finite (e.g. `sqrt` of a negative, `log` of zero) revert with a `ContractRevertError` rather than returning a complex-number or `Infinity` string.
- `validateSyntax()` now rejects contract source that references `Math.sqrt`/`Math.pow`/`Math.log`/`Math.log2`/`Math.log10` (both `Math.pow(...)` and `Math['pow']` forms) with a clear deploy-time error pointing to the `xchain.math.*` equivalent, turning what would otherwise be a silent runtime failure into an early, explicit rejection.

## [1.11.6] - 2026-05-28

### Security
- Pin `tmp` to `>=0.2.3` via an `overrides` entry, remediating GHSA-ph9p-34f9-6g65 (path traversal: `tmp` constructed temp paths from unsanitized `prefix`/`postfix` options, allowing directory escape). The vulnerable `tmp@0.0.33` was pulled in transitively as a dev-only dependency via `external-editor` (under `@stryker-mutator`); the override forces a patched version (resolves to `0.2.7`) across all transitive paths, clearing the advisory from `npm audit`.

## [1.11.5] - 2026-05-28

### Security
- `src/gas.js` — `GasTracker.charge()` now rejects any non-finite amount (`undefined`/`NaN`), not just negatives. A missing `GAS_SCHEDULE` key resolves to `undefined`, and previously `used += undefined` set `used` to `NaN`, which made the `used > ceiling` comparison permanently false and silently disabled gas metering for the rest of that execution (effectively charging zero gas). The guard now throws immediately, so a config gap surfaces at runtime instead of being silently billed as free.

## [1.11.4] - 2026-05-28

### Security
- Pin `qs` to `^6.15.2` via an `overrides` entry, remediating GHSA-q8mj-m7cp-5q26 (moderate DoS: `qs.stringify` throws a `TypeError` on null/undefined entries in comma-format arrays when `encodeValuesOnly` is set). The override forces the patched version across all transitive dependency paths.

## [1.11.3] - 2026-05-28

### Fixed
- `SLASH` emission action was missing from `ActionValidator`'s allowlist, so every `xchain.contract.slash()` call failed post-execution validation and returned `success: false`, discarding all state changes and other emissions atomically. Added `SLASH` to the allowed-actions set, restoring `xchain.contract.slash()` end-to-end.

### Changed
- Validator unit test now drives its accept-cases from the full allowed-action set (now including `ATTEST` and `SLASH`), keeping the test allowlist in sync with the validator and guarding against silent allowlist drift.

## [1.11.2] - 2026-04-06

### Changed
- Move coverage badge to its own line in README.md for cleaner formatting

## [1.11.1] - 2026-04-05

### Changed
- Moved `stryker.config.json` and `stryker-xchain-vm-mutator/` from project root into `test/mutation/`
- Updated all `mutation*` npm scripts to reference new config and mutator paths
- Reorganized flat `test/` files into subdirectories: `unit/` (11 files), `smoke/`, `integration/` (3 files), `boundary/` (2 files), `security/`, `regression/` (determinism)
- Added npm scripts: `test:integration`, `test:boundary`, `test:security`
- Default `npm test` now runs only unit tests

## [1.11.0] - 2026-04-03

### Added
- Regression test suite (`test/regression/`) — 152 tests across 4 priority tiers (P0-P3) covering all critical VM execution, security, and platform action functionality
- Regression test helpers (`test/regression/helpers.js`) — shared VM factory, execute wrapper, determinism helpers, result shape/atomicity assertions, fail-loud isolated-vm check (regression tests never silently skip)
- P0 smoke regression (`p0-smoke.regression.test.js`) — 11 tests: VM instantiation, sandbox activation, basic execution, method dispatch, emit pipeline, context accessors, deterministic math, syntax validation, revert atomicity
- P1 security regression (`p1-security.regression.test.js`) — 34 tests: 15 blocked globals, constructor chain escapes, Function/eval blocking, Math.random removal, xchain/Math freeze, gas bypass prevention, __gas overwrite protection, error atomicity (revert/gas/throw), determinism verification across 3 runs
- P2 functional regression (`p2-functional.regression.test.js`) — 73 tests: gas metering injection for all 13 AST node types, GasTracker unit regression, StateManager CRUD/validation/limits, EmissionCollector caps/copy/truncation, all 16 emit types with required field validation, ActionValidator allowlist, deterministic math (precision/large numbers/comparisons/division-by-zero/input length), syntax validation (ES2020/__gas/floats), error classes, full 16-type emit pipeline through real VM execution
- P3 integration regression (`p3-integration.regression.test.js`) — 34 tests: resource limits (gas ceiling/memory/emissions/state keys/value size/code size with exact boundary), full execution pipeline (result shape/method routing/input params/gas charging), compilation cache consistency, gateway context (block/address/balance/require/logging), E2E critical path (multi-method deploy-execute lifecycle, state persistence, AMM contract), state isolation between contracts
- NPM scripts: `test:regression:smoke` (P0, <5s), `test:regression:core` (P0+P1, <30s), `test:regression:full` (P0-P3, <60s), `test:regression:nightly` (regression + E2E + fuzz + chaos phase 1), `test:regression:release` (all tests + mutation), `test:regression:bugfix` (bug-fix specific regressions)
- Regression testing plan report at `reports/XCHAIN_VM_REGRESSION_TESTING_PLAN.md` — scope definition, test selection criteria, execution strategy with tiered triggers, maintenance procedures, integration map with all 8 existing test phases

## [1.10.0] - 2026-04-03

### Added
- Mutation testing infrastructure using Stryker 8.7.1 with Mocha runner — 1,136 built-in mutants across 13 source modules, `perTest` coverage analysis for efficient per-mutant test execution
- Custom VM-specific mutation operators (`stryker-xchain-vm-mutator/`) — 5 operators targeting patterns Stryker's built-in mutators cannot reach:
  - `ArrayElementDeletion` — removes individual elements from array literals (sandbox `toDelete` list, validator `ALLOWED_ACTIONS`, emit required fields)
  - `StringPrefixSwap` — swaps `\x01`/`\x02`/`\x03` protocol prefix characters in cross-isolate communication
  - `GuardDeletion` — removes `throw` statements inside `if` blocks (gas ceiling, state validation, input checks)
  - `ObjectFreezeRemoval` — removes `Object.freeze`/`Object.defineProperty` calls (sandbox constructor neutering, `__gas` protection)
  - `EmbeddedCodeMutation` — applies inner operators to JS code embedded in template literal strings (`STRIP_SCRIPT`, `HARNESS_SOURCE`, `CONTRACT_WRAPPER`)
- Standalone custom mutation runner (`stryker-xchain-vm-mutator/index.js`) — applies 126 custom mutants, runs test suite per mutant, reports kill/survive with progress output
- Mutation report generator (`scripts/mutation-report.js`) — merges Stryker JSON and custom runner results, produces `MUTATION_SUMMARY.md` with per-module scores, tier-based pass/fail, survived mutation details, and actionable recommendations
- NPM scripts: `mutation` (full Stryker run), `mutation:critical` / `mutation:high` / `mutation:medium` (tier-scoped), `mutation:quick` (smallest modules), `mutation:custom` (VM-specific operators), `mutation:custom:dryrun` (preview), `mutation:report` (generate summary), `mutation:ci` (incremental mode)
- Stryker configuration (`stryker.config.json`) with HTML/JSON/clear-text reporters, `StringLiteral` exclusion, tiered thresholds (break: 75%, low: 80%, high: 90%)
- Mutation testing plan report at `reports/XCHAIN_VM_MUTATION_TESTING_PLAN.md`

## [1.9.0] - 2026-04-03

### Added
- Chaos engineering test suite (`test/chaos/`) — 93 tests across 10 experiments in 3 phases targeting VM resilience, fault tolerance, and recovery
- Phase 1 critical tests: memory cliff OOM handling, gateway error atomicity, gateway callback hang, sandbox partial failure, corrupted state input
- Phase 2 load tests: concurrent isolate exhaustion (20+ parallel executions), host process memory leak detection (1000+ sequential runs), rapid block cycling stress
- Phase 3 edge case tests: acorn/V8 parser divergence (18 syntax constructs), mathjs precision boundaries (256-char limits, division by zero, accumulated precision)
- Chaos test helpers (`test/chaos/helpers/`) — `ProgrammableMock` for fault-injectable oracle/crossChain accessors, `MemoryTracker` for heap snapshot analysis, `chaosAssertions` for recovery verification
- Programmable mock providers (`test/chaos/helpers/programmable-mock.js`) — `ProgrammableOracleProvider` and `ProgrammableCrossChainProvider` with per-method fault rules
- 4 adversarial test contracts (`test/chaos/contracts/`) — `memory_cliff.js`, `gateway_caller.js`, `math_extreme.js`, `parser_edge.js`
- Chaos engineering plan report at `reports/XCHAIN_VM_CHAOS_ENGINEERING_PLAN.md` — 22 failure points, 10 experiment designs, prioritized roadmap, integration strategy
- NPM scripts: `test:chaos` (full suite), `test:chaos:quick` (phase 1), `test:chaos:phase2`, `test:chaos:phase3`

## [1.8.0] - 2026-04-03

### Added
- Performance benchmark suite (`bench/`) — harness, 7 benchmark contracts (4 tiers + 3 stress), and 5 scenario scripts
- Pipeline microbenchmarks (`bench/scenarios/pipeline.js`) — measures metering, cold/warm execution, and stress contract latency per tier
- Gateway method benchmarks (`bench/scenarios/gateway.js`) — isolates per-call overhead for context getters, state CRUD, emit, math, and logging
- Block throughput benchmark (`bench/scenarios/throughput.js`) — simulates blocks of 50/200/1000 contracts with mixed complexity and cache comparison
- Soak test (`bench/scenarios/soak.js`) — sustained load with memory and throughput stability monitoring, configurable duration
- Cache effectiveness benchmark (`bench/scenarios/cache.js`) — measures compilation cache impact at 0%/50%/100% hit rates
- NPM scripts: `bench:quick` (pipeline + gateway), `bench:full` (all except soak), `bench:soak` (sustained load)

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
