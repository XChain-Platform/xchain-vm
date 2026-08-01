<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright © 2025-2026 Dankest, LLC -->

# XChain Platform Virtual Machine (VM)

<p align="center">
  <img src="https://img.shields.io/badge/version-1.11.14-blue" alt="Version">
  <img src="https://img.shields.io/badge/tests-1653%2B%20passing-brightgreen" alt="Tests">
  <img src="https://img.shields.io/badge/node-%3E%3D22-green" alt="Node">
  <img src="https://img.shields.io/badge/license-AGPL--3.0--or--later-blue" alt="License">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/coverage-unit%20%7C%20integration%20%7C%20e2e%20%7C%20smoke%20%7C%20boundary%20%7C%20security%20%7C%20fuzz%20%7C%20chaos%20%7C%20mutation%20%7C%20regression%20%7C%20performance%20%7C%20determinism-brightgreen" alt="Coverage">
</p>

Deterministic smart contract execution engine for the XChain Platform. Runs JavaScript contracts in sandboxed V8 isolates with AST-based gas metering, ensuring identical results across all indexer nodes. Plugs into the XChain Indexer as the runtime for DEPLOY and EXECUTE actions.

## Features

- **Sandboxed V8 isolates**: contracts run in isolated-vm with no access to the host process, filesystem, or network
- **Deterministic execution**: all non-deterministic APIs (Date, Math.random, setTimeout, etc.) stripped; same input always produces same output
- **AST-based gas metering**: acorn parses contract code and injects `__gas()` calls at control flow points; no V8 modifications required
- **19 emittable actions**: contracts can emit SEND, DESTROY, ISSUE, MINT, ORDER, DISPENSER, DIVIDEND, AIRDROP, CALLBACK, FILE, LIST, COINPAY, SWEEP, LINK, BROADCAST, MESSAGE, VOTE, EXECUTE (cross-contract call: deferred, caller-funded gasLimit, max depth 4, no return value), and XCALL (cross-chain call via `emit.crossExecute`: federation-relayed to a contract on another chain, outcome delivered to a callback method)
- **Cross-chain contract calls**: `emit.crossExecute(...)` emits an XCALL for federation relay to a target chain; the receiving contract must list the method in its exported `crossCallable` array; outcomes arrive asynchronously via a named callback method; `crossChain.getCallResult(callId)` reads the terminal result
- **External attestation**: `xchain.attestation.request(...)` namespace lets contracts emit `ATTEST` v0 (request) against a registered provider (`http_get`, `llm`) with a deterministic `request_id`; the hub federation reaches PBFT quorum off-chain and submits `ATTEST` v1 (response) to invoke the contract's callback. Payload cap: 8192 bytes.
- **Deterministic math**: `xchain.math.*` wraps mathjs bignumber with string I/O; no floating-point; native `Math.sqrt/pow/log/log2/log10` rejected at deploy time
- **Contract state management**: key-value state with dirty tracking, key count limits, and value size limits
- **Deploy-time validation**: syntax checking via V8 + acorn, reserved identifier detection, banned Math/literal/async/generator/WebAssembly checks (see `CONSENSUS_RULES` in `src/lint-core.js`), float usage warnings
- **Per-block compilation cache**: V8 cached compilation data eliminates redundant parsing for hot contracts
- **Resource limits**: configurable memory (MB), gas ceiling, emission cap, state key cap, value size cap, wall-clock timeout
- **Multi-method contracts**: contracts export a function (single entry) or an object with named methods

## Documentation

Full VM architecture and protocol details are available in the [xchain-documentation](https://github.com/XChain-Platform/xchain-documentation) repository:

| Document | Description |
|---|---|
| [Smart Contracts](https://github.com/XChain-Platform/xchain-documentation/blob/master/concepts/smart-contracts.md) | VM architecture, contract model, bounded execution, use cases |
| [Block Hashes](https://github.com/XChain-Platform/xchain-documentation/blob/master/concepts/block-hashes.md) | Ledger, actions, and contract hashes: how contract state is verified |
| [Ledger](https://github.com/XChain-Platform/xchain-documentation/blob/master/concepts/ledger.md) | Double-entry ledger: how contract derived addresses participate |
| [DEPLOY](https://github.com/XChain-Platform/xchain-documentation/blob/master/protocol/actions/deploy.md) | DEPLOY action spec: code encoding, api_version, gas costs |
| [EXECUTE](https://github.com/XChain-Platform/xchain-documentation/blob/master/protocol/actions/execute.md) | EXECUTE action spec: method calls, params, gas metering |
| [DEPOSIT](https://github.com/XChain-Platform/xchain-documentation/blob/master/protocol/actions/deposit.md) | DEPOSIT action spec: transferring tokens into contract custody |
| [WITHDRAW](https://github.com/XChain-Platform/xchain-documentation/blob/master/protocol/actions/withdraw.md) | WITHDRAW action spec: owner-initiated withdrawal from contract |
| [Indexer Database](https://github.com/XChain-Platform/xchain-documentation/blob/master/components/indexer/database.md) | Schema reference: contracts, contract_state, executions, emissions tables |
| [Fee Schedule](https://github.com/XChain-Platform/xchain-documentation/blob/master/components/indexer/configuration.md) | Unified gas schedule: VM gas costs, GAS_PRICE, fee conversion |

## Quick Start

```bash
git clone https://github.com/XChain-Platform/xchain-vm.git
cd xchain-vm
npm install
```

### Prerequisites

`isolated-vm` requires native C++ compilation. Install build dependencies:

```bash
# Ubuntu/Debian
sudo apt-get install -y build-essential python3 libnghttp2-dev libicu-dev libbrotli-dev libc-ares-dev

# macOS (Xcode command-line tools)
xcode-select --install
```

If `npm install` fails to compile `isolated-vm`, rebuild after installing dependencies:

```bash
npm rebuild isolated-vm
```

### Basic Usage

```javascript
const XChainVM = require('xchain-vm');

const vm = new XChainVM({
    gasSchedule: {
        VM_COMPUTATION: 1,
        VM_STATE_READ: 100,
        VM_STATE_WRITE: 200,
        VM_STATE_DELETE: 100,
        VM_ORACLE_READ: 100,
        VM_CROSSCHAIN_READ: 100,
        VM_ATTEST_REQUEST: 5000,
        VM_EMISSION: 500,
        VM_XCALL_REQUEST: 1000,
        VM_XCALL_CALLBACK: 1000
    },
    gasCeiling: 1000000,
    limits: {
        maxCpuTimeMs: 30000,
        maxMemory: 8,
        maxEmissions: 50,
        maxStateKeys: 10000,
        maxStateValueSize: 65536,
        maxCodeSize: 65536
    }
});

const result = await vm.execute({
    code: `module.exports = {
        increment: function(xchain) {
            var count = xchain.state.get('counter') || '0';
            count = xchain.math.add(count, '1');
            xchain.state.set('counter', count);
            return count;
        }
    };`,
    state: { counter: '5' },
    method: 'increment',
    params: [],
    caller: 'source_address',
    contractAddress: 'C:BTC:100',
    blockContext: { height: 500, timestamp: 1700000000, hash: 'blockhash' }
});

// result = {
//     success: true,
//     error: null,
//     gasUsed: 302,
//     returnValue: '"6"',
//     stateChanges: [{ key: 'counter', value: '6' }],
//     stateDeletes: [],
//     emittedActions: [],
//     logs: []
// }
```

## Developer Toolkit (`xchain-foundry`)

A local on-ramp for authoring XChain contracts: write, lint, gas-profile, and
unit-test a contract with millisecond feedback and no regtest stack. Ships as
two bins plus a library at `require('xchain-vm/toolkit')`.

```bash
# Scaffold a project (contract + simulator test + README); add --ts for TypeScript
npx create-xchain-contract my-token
npx create-xchain-contract my-token --ts

# Static determinism gate + gas estimate (runs on ANY OS/CPU; no isolated-vm)
xchain-foundry lint contracts/my-token.js

# Deploy + run a method in the in-memory simulator (Node 22 / Linux)
xchain-foundry simulate contracts/my-token.js --constructor 5 --method increment --params 3

# AI-assisted authoring (Tier 3): print a ready-to-use prompt, no network call or key
xchain-foundry describe "an escrow that releases on a signed delivery attestation"
xchain-foundry from-solidity MyContract.sol

# Close the loop: run a model's reply through the deploy gate, printing a repair
# prompt on failure (use `-` for stdin)
xchain-foundry validate model-response.txt
```

Programmatic use:

```js
const { ContractSimulator, runGate } = require('xchain-vm/toolkit');

runGate(source);                        // { ok, errors, advisories, warnings, gas }

const sim = new ContractSimulator({ coin: 'BTC' });
sim.setBalance('alice', 'GOLD', '1000');   // seed read-only ledger/oracle state
const { contractIndex } = await sim.deploy(source, { constructorParams: ['5'] });
const res = await sim.call(contractIndex, 'increment', ['3']); // state persists across calls
await sim.close();
```

The `lint` gate (banned-API / float / async / syntax checks + gas estimate)
is pure JS and runs anywhere. The simulator executes contracts, so it needs
the isolated-vm binding (Node 22 / Linux); on a macOS dev box use `lint`
locally and run the simulator / generated tests on Node-22 Linux (CI). See the
`src/toolkit/` modules for details.

## Scripts

| Command | Description |
|---|---|
| `npm test` | Unit tests (669 tests, 30s timeout) |
| `npm run test:toolkit` | Developer-toolkit tests (gate/scaffold/transpile run anywhere; simulator on Node-22 Linux) (52 tests) |
| `npm run test:integration` | Integration tests (164 tests) |
| `npm run test:security` | Security tests (201 tests) |
| `npm run test:boundary` | Boundary condition tests (115 tests) |
| `npm run test:determinism` | Determinism tests (79 tests) |
| `npm run test:performance` | Performance benchmarks-as-tests (5 tests) |
| `npm run test:all` | Every `*.test.js` under `test/` (1,653+ tests) |
| `npm run test:e2e` | E2E tests only (64 tests) |
| `npm run smoke` | Smoke tests (10 tests, < 5s) |
| `npm run test:fuzz` | Fuzz / property-based tests (57 tests) |
| `npm run test:chaos` | Chaos engineering tests (76 tests) |
| `npm run test:regression:smoke` | P0 regression (11 tests, < 50ms) |
| `npm run test:regression:core` | P0+P1 regression (31 tests, < 200ms) |
| `npm run test:regression:full` | P0-P3 + gate/pin regression (128 tests, < 1s) |
| `npm run test:regression:nightly` | Regression + E2E + fuzz + chaos phase 1 |
| `npm run test:regression:release` | All tests + mutation testing |
| `npm run mutation` | Mutation testing (Stryker, full suite) |
| `npm run bench:quick` | Pipeline + gateway benchmarks |
| `npm run bench:full` | All benchmarks except soak |

## Test Suite

### Unit Tests (669)

| Category | Tests | Description |
|---|---|---|
| Metering | 69 | AST injection points, edge cases (arrow bodies, directive prologue, nested ternary, optional chaining, deep binary expressions) |
| Gas | 23 | Ceiling enforcement, boundary conditions, cumulative charges, negative/float/non-number rejection |
| Math | 48 | Precision (0.1+0.2=0.3), large numbers, comparisons, division by zero, string I/O, input length limits |
| State | 38 | CRUD, delete-then-set cycles, key/value/key-size limits, NaN/Infinity rejection, UTF-8 handling, insertion order |
| Collector | 16 | Emission cap, log truncation (byte-aware), param copy isolation, multi-byte truncation |
| Compilation | 2 | Metering benchmark, worst-case 64KB contract compilation time |
| Sandbox | 37 | 18 blocked globals, constructor escapes, prototype chain, eval/Function, Math freeze, xchain freeze |
| Gateway | 39 | State ops, emit queuing, math, revert/require, logging, method routing, oracle stubs |
| Gateway-Emit | 67 | All 19 emit types, required field validation, gas charging, params copy/rejection |
| Validator | 15 | Action allowlist, unknown action rejection, params type validation |
| Syntax | 44 | Valid/invalid code, ES2020 support, `__gas` rejection, float warnings, edge cases |
| Errors | 18 | ContractRevertError, GasExhaustedError construction and instanceof checks |
| Isolate | 14 | Isolate creation, compilation, disposal, cached data |
| Newer coverage (~20 files added since this table was last authored) | 239 | Contract-language-version guards, execution-mode dispatch, gateway `.d.ts` parity + guard-mode, cross-contract `emit.execute` / cross-chain `emit.crossExecute` call-path derivation, lint CLI/generator/hardening/parity/shared-rules, metered compilation cache, protocol constants, capability-manifest reading, read-only accessors, xcall bounds parity, limits backfill, dependency-advisory scan, mutation-report scripting, error-classification corroboration, consensus-runtime gating. Row total is exact (669 minus the 13 rows above); the file-to-topic grouping is a best-effort summary and **needs operator review**, not a verified per-row breakdown |

### E2E Tests (64)

| Category | Tests | Description |
|---|---|---|
| Deploy & Execute | 8 | Contract lifecycle, invalid syntax rejection, code size limits |
| Deposit & Withdraw | 5 | Token custody transfers, balance tracking |
| Error Handling | 6 | Revert recovery, gas exhaustion, runtime errors |
| State Persistence | 6 | Cross-execution state, multi-contract isolation |
| Security | 9 | Sandbox enforcement in full pipeline |
| Resource Limits | 9 | Gas, OOM, timeout, emission/state floods |
| Determinism | 3 | 10-run consistency, block replay |
| Complex Workflows | 7 | AMM swap, vesting, multi-action, sequential counter |
| Gas Fees | 5 | Fee accounting, gas charging on failure |
| Oracle & Cross-chain | 6 | Oracle price reads, cross-chain attestation |

### Integration Tests (164)

Full-pipeline coverage promoted out of the old embedded "Index (Integration)" unit category into its own `test/integration/` suite: result structure, atomicity, return values, method routing, error classification, context, and all 19 emit types.

### Security Tests (201)

Sandbox escape vectors, error spoofing, gas-bypass attempts, prototype pollution, math abuse, and information-leakage probes, now in a dedicated `test/security/` suite (grown well past the RISK-01 through RISK-15 set the table used to enumerate; see the suite for the current catalog).

### Boundary Tests (115)

Gas ceiling, timeout, memory, code size, state management, emissions, logs, return values, math, metering, sandbox, gateway, emit-field, and compound-interaction edge cases in `test/boundary/`.

### Smoke Tests (10)

VM instantiation, sandbox creation, basic execution, method dispatch, gateway, math, syntax, and revert, unchanged from the original set.

### Determinism Tests (79)

Cross-run and cross-process determinism guarantees in `test/determinism/`: golden-hash fixtures, consensus-parameter and consensus-runtime gates, cross-repo call-id byte-matching, cache/subprocess/stack-depth/timeout-fee determinism, plus a `known-red` probe subset (`npm run test:known-red`) that intentionally documents non-determinism failure modes rather than passing.

### Performance Tests (5)

Latency/throughput assertions in `test/performance/` (`npm run test:performance`), distinct from the `bench/` scenario scripts below.

### Toolkit Tests (52)

`xchain-foundry` / `create-xchain-contract` developer-toolkit coverage: gate, scaffold, and TypeScript-strip logic run on any OS; simulator-backed cases need the isolated-vm binding (Node 22 / Linux).

### Regression Tests (128 via `test:regression:full`; +31 determinism-tagged tests live alongside them in `test/regression/` but run under `test:determinism`)

| Tier | Tests | Target Time | Scope |
|---|---|---|---|
| P0 Smoke | 11 | < 50ms | VM boot, sandbox, basic execution, emit, revert |
| P1 Security | 20 | < 200ms | Blocked globals, escape vectors, gas bypass, atomicity, determinism |
| P2 Functional | 41 | < 300ms | Metering injection, state ops, all 19 emit types, math, validation |
| P3 Integration | 24 | < 350ms | Resource limits, full pipeline, cache, E2E lifecycle, state isolation |
| Gate / pin regressions | 32 | < 1s | `binary-alloc-gate`, `compilation-cache-live`, `math-golden`, `metering-eval-order-gate`, `slash-token-delimiter-gate`, `state-key-nul-gate`, `state-key-type-gate`: single-issue pinned regressions, one file each |

### Fuzz Tests (57)

Property-based and adversarial input testing: code mutation, argument injection, emission payloads, state operations, math properties, sandbox escapes, determinism verification, resource exhaustion.

### Chaos Engineering Tests (76)

3-phase resilience testing: Phase 1 (critical failures), Phase 2 (load and concurrency), Phase 3 (parser divergence and precision boundaries).

### Mutation Tests

Stryker with Mocha runner plus custom VM-specific operators. Mutant/module counts come from a live Stryker run, not a static scan, so they are **not re-verified here**; treat the previously published "1,136 mutants across 13 modules" as unverified pending a fresh `npm run mutation` pass.

### **Total: 1,653+ tests**

Static `it()`/`test()` occurrence count across every file under `test/` (all categories above, including toolkit and the determinism-tagged files inside `test/regression/`). This is a source-line count, not a suite-run count: property-based fuzz cases and looped fixtures can execute more assertions per matched line than this number shows, so treat it as a floor, not an exact total.

### Test Contracts

Fixture contracts in `test/contracts/` cover real-world and adversarial scenarios:

| Contract | Purpose |
|---|---|
| `simple_send.js` | Reads state, emits one SEND |
| `state_counter.js` | Increments a counter, tests state read/write cycle |
| `amm_swap.js` | Constant-product AMM with xchain.math, emits SENDs |
| `vesting.js` | Time-based release using block height |
| `multi_method.js` | Object export with multiple named methods |
| `infinite_loop.js` | Must hit gas limit |
| `memory_bomb.js` | Must hit memory limit |
| `sandbox_escape.js` | All known escape techniques, must all fail |
| `emit_flood.js` | 51 emits, must fail at 51st |
| `state_flood.js` | 10,001 keys, must fail at limit |
| `bad_math.js` | Native 0.1+0.2 vs xchain.math |
| `compile_bomb.js` | Deeply nested expressions for compilation benchmark |
| `oracle_read.js` | Oracle stub API (returns null until Track B) |

## Architecture

```
Contract Source Code
    |
  acorn (parse AST)
    |
  metering.js (inject __gas() calls at control flow points)
    |
  astring (regenerate source from modified AST)
    |
  isolated-vm (V8 isolate)
    |-- sandbox.js (strip non-deterministic globals)
    |-- gateway.js (inject xchain object via ivm.Reference callbacks)
    |-- gas.js (__gas -> chargeComputation on host side)
    +-- script.runSync() (execute with wall-clock timeout)
    |
  Collect results
    |-- state.js -> stateChanges, stateDeletes
    |-- collector.js -> emittedActions, logs
    +-- gas.js -> gasUsed
    |
  Return to indexer (execute.js)
```

## Module Structure

```
xchain-vm/
|-- package.json
|-- src/
|   |-- index.js          (XChainVM class, main entry point)
|   |-- isolate.js        (V8 isolate management: create, compile, dispose)
|   |-- gateway.js        (builds the xchain gateway object)
|   |-- gateway-emit.js   (emit API: 19 action types, incl. cross-contract emit.execute and cross-chain emit.crossExecute)
|   |-- gas.js            (gas tracking and ceiling enforcement)
|   |-- sandbox.js        (strips non-deterministic APIs)
|   |-- metering.js       (AST-based gas injection)
|   |-- validator.js      (validates emitted actions)
|   |-- syntax.js         (deploy-time validation + float warnings)
|   |-- math.js           (deterministic math, wraps mathjs bignumber)
|   |-- state.js          (contract state management)
|   |-- collector.js      (emission and log collection)
|   +-- errors.js         (ContractRevertError, GasExhaustedError)
|-- test/
|   |-- *.test.js         (36 unit test files, 669 tests)
|   |-- contracts/        (13 test fixture contracts)
|   |-- integration/      (164 tests: full pipeline, all 19 emit types)
|   |-- security/         (201 tests: sandbox escapes, gas bypass, info leakage)
|   |-- boundary/         (115 tests: gas/timeout/memory/code-size/state edges)
|   |-- smoke/            (10 tests)
|   |-- determinism/      (79 tests, incl. a known-red probe subset)
|   |-- performance/      (5 tests, distinct from bench/ below)
|   |-- toolkit/          (52 tests: xchain-foundry gate/scaffold/simulate)
|   |-- e2e/              (10 E2E test files, 64 tests + helpers + contracts)
|   |-- fuzz/             (9 fuzz test files, 57 tests + harness + generators)
|   |-- chaos/            (3-phase chaos tests, 76 tests + helpers + contracts)
|   +-- regression/       (4-tier + gate/pin regression suite, 159 tests + helpers)
|-- bench/                (5 benchmark scenarios + harness + contracts)
|-- reports/              (9 test plan reports)
+-- stryker-xchain-vm-mutator/  (custom mutation testing operators)
```

## Integration

The VM integrates with the XChain Indexer at `xchain-indexer/src/actions/execute.js`. The indexer instantiates a single `XChainVM` instance at startup and calls `vm.execute()` for each EXECUTE action and `vm.validateSyntax()` for each DEPLOY action.

```javascript
// In xchain-indexer/src/actions.js
const XChainVM = require('xchain-vm');
this.vm = new XChainVM({
    gasSchedule: this.config['GAS_SCHEDULE'],
    gasCeiling: 1000000,
    limits: { ... }
});
```

Per-block compilation caching:
```javascript
this.actions.vm.beginBlock();   // before processing block transactions
// ... process transactions ...
this.actions.vm.endBlock();     // after processing block transactions
```

## Dependencies

| Package | Purpose |
|---|---|
| `isolated-vm` | V8 isolate sandbox (native C++ module) |
| `mathjs` | Deterministic bignumber arithmetic |
| `acorn` | JavaScript parser for AST-based gas injection |
| `acorn-walk` | AST walker for gas injection and float detection |
| `astring` | AST-to-source code generator |

---

**Copyright &copy; 2025-2026 Dankest, LLC**

**Based on XChain Platform by Dankest, LLC &ndash; https://dankest.llc**

Licensed under the **GNU Affero General Public License v3.0** (AGPL-3.0-or-later)
with a commercial license available for proprietary use.

You may use, modify, and distribute this material under the terms of the License.
See [LICENSE](./LICENSE.md) and [NOTICE](./NOTICE.md) for full terms.
See the [licensing overview](https://docs.xchain.io/legal/LICENSING.html).
