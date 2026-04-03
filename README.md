<!-- SPDX-License-Identifier: LicenseRef-Dankest-Community -->
<!-- Copyright © 2025 Dankest, LLC -->

# XChain Platform Virtual Machine (VM)

<p align="center">
  <img src="https://img.shields.io/badge/version-1.0.0-blue" alt="Version">
  <img src="https://img.shields.io/badge/tests-81%20passing-brightgreen" alt="Tests">
  <img src="https://img.shields.io/badge/coverage-unit%20%7C%20determinism%20%7C%20sandbox%20%7C%20gas%20%7C%20compilation-brightgreen" alt="Coverage">
  <img src="https://img.shields.io/badge/node-%3E%3D18-green" alt="Node">
  <img src="https://img.shields.io/badge/license-Dankest%20Community-orange" alt="License">
</p>

Deterministic smart contract execution engine for the XChain Platform. Runs JavaScript contracts in sandboxed V8 isolates with AST-based gas metering, ensuring identical results across all indexer nodes. Plugs into the XChain Indexer as the runtime for DEPLOY and EXECUTE actions.

## Features

- **Sandboxed V8 isolates** — contracts run in isolated-vm with no access to the host process, filesystem, or network
- **Deterministic execution** — all non-deterministic APIs (Date, Math.random, setTimeout, etc.) stripped; same input always produces same output
- **AST-based gas metering** — acorn parses contract code and injects `__gas()` calls at control flow points; no V8 modifications required
- **16 emittable actions** — contracts can emit SEND, DESTROY, ISSUE, MINT, ORDER, DISPENSER, DIVIDEND, AIRDROP, CALLBACK, FILE, LIST, COINPAY, SWEEP, LINK, BROADCAST, MESSAGE
- **Deterministic math** — `xchain.math.*` wraps mathjs bignumber with string I/O; no floating-point
- **Contract state management** — key-value state with dirty tracking, key count limits, and value size limits
- **Deploy-time validation** — syntax checking via V8 + acorn, reserved identifier detection, float usage warnings
- **Per-block compilation cache** — V8 cached compilation data eliminates redundant parsing for hot contracts
- **Resource limits** — configurable memory (MB), gas ceiling, emission cap, state key cap, value size cap, wall-clock timeout
- **Multi-method contracts** — contracts export a function (single entry) or an object with named methods

## Documentation

Full VM architecture and protocol details are available in the [xchain-documentation](https://github.com/XChain-platform/xchain-documentation) repository:

| Document | Description |
|---|---|
| [Smart Contracts](https://github.com/XChain-platform/xchain-documentation/blob/master/concepts/SMART_CONTRACTS.md) | VM architecture, contract model, bounded execution, use cases |
| [Block Hashes](https://github.com/XChain-platform/xchain-documentation/blob/master/concepts/BLOCK_HASHES.md) | Ledger, actions, and contract hashes — how contract state is verified |
| [Ledger](https://github.com/XChain-platform/xchain-documentation/blob/master/concepts/LEDGER.md) | Double-entry ledger — how contract derived addresses participate |
| [DEPLOY](https://github.com/XChain-platform/xchain-documentation/blob/master/protocol/actions/DEPLOY.md) | DEPLOY action spec — code encoding, api_version, gas costs |
| [EXECUTE](https://github.com/XChain-platform/xchain-documentation/blob/master/protocol/actions/EXECUTE.md) | EXECUTE action spec — method calls, params, gas metering |
| [DEPOSIT](https://github.com/XChain-platform/xchain-documentation/blob/master/protocol/actions/DEPOSIT.md) | DEPOSIT action spec — transferring tokens into contract custody |
| [WITHDRAW](https://github.com/XChain-platform/xchain-documentation/blob/master/protocol/actions/WITHDRAW.md) | WITHDRAW action spec — owner-initiated withdrawal from contract |
| [Indexer Database](https://github.com/XChain-platform/xchain-documentation/blob/master/components/indexer/DATABASE.md) | Schema reference — contracts, contract_state, executions, emissions tables |
| [Fee Schedule](https://github.com/XChain-platform/xchain-documentation/blob/master/components/indexer/CONFIGURATION.md) | Unified gas schedule — VM gas costs, GAS_PRICE, fee conversion |

## Quick Start

```bash
git clone https://github.com/XChain-platform/xchain-vm.git
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
        VM_EMISSION: 500
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

## Scripts

| Command | Description |
|---|---|
| `npm test` | Run all tests (81 tests, 30s timeout) |

## Test Suite

| Type | Tests | Description |
|---|---|---|
| Metering | 28 | AST injection points, edge cases (arrow bodies, directive prologue, nested ternary, optional chaining, class methods) |
| Gas | 7 | Ceiling enforcement, boundary conditions, cumulative charges |
| Math | 16 | Precision (0.1+0.2=0.3), large numbers, comparisons, division by zero, string I/O |
| State | 18 | CRUD, delete-then-set cycles, key count limits, value size limits, NaN/Infinity rejection |
| Collector | 7 | Emission cap, log truncation, param copy isolation |
| Compilation | 3 | Metering benchmark, worst-case 64KB contract compilation time |
| Sandbox | 10 | process/require/eval/Date/Math.random/setTimeout blocking, constructor escape, prototype pollution |
| Gateway | 20+ | State ops, emit queuing, math, revert/require, logging, method routing, oracle stubs |
| Limits | 7 | Infinite loop (gas), memory bomb (OOM), emission flood, state flood, value size |
| Determinism | 5 | Same input produces identical results across runs (hash comparison) |
| Syntax | 9 | Valid/invalid code detection, ES2020 support, `__gas` rejection, float warnings |
| **Total** | **81+** | Tests requiring isolated-vm are skipped if the native module is not compiled |

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
    ↓
  acorn (parse AST)
    ↓
  metering.js (inject __gas() calls at control flow points)
    ↓
  astring (regenerate source from modified AST)
    ↓
  isolated-vm (V8 isolate)
    ├── sandbox.js (strip non-deterministic globals)
    ├── gateway.js (inject xchain object via ivm.Reference callbacks)
    ├── gas.js (__gas → chargeComputation on host side)
    └── script.runSync() (execute with wall-clock timeout)
    ↓
  Collect results
    ├── state.js → stateChanges, stateDeletes
    ├── collector.js → emittedActions, logs
    └── gas.js → gasUsed
    ↓
  Return to indexer (execute.js)
```

## Module Structure

```
xchain-vm/
├── package.json
├── src/
│   ├── index.js          — XChainVM class (main entry point)
│   ├── isolate.js        — V8 isolate management (create, compile, dispose)
│   ├── gateway.js        — builds the xchain gateway object
│   ├── gateway-emit.js   — emit API (16 action types)
│   ├── gas.js            — gas tracking and ceiling enforcement
│   ├── sandbox.js        — strips non-deterministic APIs
│   ├── metering.js       — AST-based gas injection
│   ├── validator.js      — validates emitted actions
│   ├── syntax.js         — deploy-time validation + float warnings
│   ├── math.js           — deterministic math (wraps mathjs bignumber)
│   ├── state.js          — contract state management
│   ├── collector.js      — emission and log collection
│   └── errors.js         — ContractRevertError, GasExhaustedError
└── test/
    ├── metering.test.js
    ├── sandbox.test.js
    ├── gas.test.js
    ├── gateway.test.js
    ├── limits.test.js
    ├── determinism.test.js
    ├── math.test.js
    ├── state.test.js
    ├── collector.test.js
    ├── compilation.test.js
    ├── syntax.test.js
    └── contracts/        — test fixture contracts
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

**Copyright &copy; 2025 Dankest, LLC**

**Based on XChain Platform by Dankest, LLC &ndash; https://dankest.llc**

Licensed under the **Dankest Community License**
(based on the Apache License 2.0 with additional non-commercial and network-disclosure terms).

You may not use, modify, or distribute this material except in compliance with the License.
See [LICENSE](./LICENSE.md) and [NOTICE](./NOTICE.md) for full terms.
A full copy of the License is also available at: [https://dankest.llc/license](https://dankest.llc/license)
