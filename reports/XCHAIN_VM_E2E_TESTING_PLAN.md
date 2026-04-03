# XChain VM — End-to-End Testing Plan

## 1. Objective

Validate the complete execution pipeline: JavaScript contract deployment and execution → platform action gateway invocation → correct ledger state changes. E2E tests prove the VM works as a cohesive system within the broader XChain platform, catching integration issues that unit tests cannot.

The xchain-vm already has 81+ unit/integration tests covering individual modules (metering, sandbox, gas, state, gateway, etc.). This E2E plan targets the gaps that remain: **full-stack workflows where the VM interacts with real or simulated indexer state, decoder-produced blocks, and platform fee accounting.**

---

## 2. Rationale

### Why E2E testing is critical for xchain-vm

1. **Security surface**: The VM is the only component that executes arbitrary user-submitted code. A sandbox escape, gas bypass, or gateway validation failure has catastrophic consequences. Unit tests verify individual guardrails; E2E tests verify they compose correctly under realistic attack conditions.

2. **Determinism consensus**: Every node in the network must produce identical results for the same contract execution. E2E tests that replay real block sequences confirm determinism holds across the full pipeline (decode → index → execute → state commit).

3. **Atomicity under real conditions**: The VM guarantees all-or-nothing state changes. E2E tests verify this holds when the indexer processes DEPLOY/EXECUTE/DEPOSIT/WITHDRAW sequences with interleaved failures, reorgs, and edge cases.

4. **Platform action correctness**: Emitted actions (SEND, DESTROY, ISSUE, etc.) must be valid, properly validated, and correctly applied to ledger state. The gateway-emit module validates parameters in isolation, but E2E tests confirm the emitted actions produce the expected indexer state changes.

5. **Fee accounting**: Gas consumption must translate correctly into XCHAIN fee deductions via the unified gas schedule. E2E tests verify the fee pipeline end-to-end.

---

## 3. Critical E2E Scenarios

### 3.1 Contract Deployment & Basic Execution

| ID | Scenario | Steps | Verification |
|----|----------|-------|-------------|
| E2E-001 | Deploy a simple contract and execute it | 1. Encode a DEPLOY action with a simple contract (e.g., `simple_send.js`) 2. Process through decoder → indexer 3. Encode an EXECUTE action targeting the deployed contract 4. Process through decoder → indexer → VM | Contract stored in `contracts` table. Execution produces expected `emittedActions`. SEND action applied to `balances` table. `contract_state` updated. Gas fee deducted from caller's XCHAIN balance. |
| E2E-002 | Deploy with invalid syntax | 1. Encode DEPLOY with syntactically invalid JS 2. Process through indexer | DEPLOY action rejected at validation (`validateSyntax`). No contract record created. Gas fee still charged for the attempt. |
| E2E-003 | Deploy exceeding code size limit | 1. Encode DEPLOY with >65536 byte contract 2. Process through indexer | DEPLOY rejected with code size error. No contract stored. |
| E2E-004 | Execute non-existent contract | 1. Encode EXECUTE targeting a contract address with no deployment 2. Process through indexer | EXECUTE fails gracefully. Error recorded. No state changes. |
| E2E-005 | Execute with method routing | 1. Deploy a multi-method contract (object export pattern) 2. EXECUTE with `method` param targeting specific function 3. EXECUTE with different method | Each execution invokes the correct method. Return values and state changes match expected method behavior. |

### 3.2 Complex Contract Logic with Multiple Actions

| ID | Scenario | Steps | Verification |
|----|----------|-------|-------------|
| E2E-010 | AMM swap contract | 1. Deploy AMM contract (`amm_swap.js` pattern) 2. DEPOSIT tokens to contract custody 3. EXECUTE swap function with input params 4. Verify output | Constant-product invariant maintained. Emitted SEND actions transfer correct amounts. Contract state (reserves) updated. All math uses `xchain.math` (no floating-point drift). |
| E2E-011 | Vesting contract with time-locked release | 1. Deploy vesting contract 2. DEPOSIT tokens 3. EXECUTE before unlock height → should revert 4. Mine blocks past unlock height 5. EXECUTE after unlock height → should succeed | Pre-unlock: revert with clear message, no state change. Post-unlock: SEND emitted for vested amount. Contract state records claim. |
| E2E-012 | Contract emitting multiple action types | 1. Deploy contract that emits SEND + DESTROY + MINT in one execution 2. EXECUTE | All three emitted actions are valid and applied in order. Balances reflect all three operations. Emission count = 3 in result. |
| E2E-013 | Sequential executions with cumulative state | 1. Deploy state_counter contract 2. EXECUTE increment × 5 (5 separate EXECUTE actions in 5 blocks) 3. EXECUTE decrement × 2 | Counter state = 3 after all executions. Each execution's state changes are persisted and visible to subsequent calls. `contract_state` table has append-only history. |
| E2E-014 | Conditional logic branching | 1. Deploy contract with if/else paths based on input params and state 2. EXECUTE with params triggering path A 3. EXECUTE with params triggering path B | Each path produces distinct state changes and emitted actions. No cross-contamination between paths. |

### 3.3 DEPOSIT and WITHDRAW Lifecycle

| ID | Scenario | Steps | Verification |
|----|----------|-------|-------------|
| E2E-020 | Deposit tokens to contract | 1. Ensure caller has token balance 2. Encode DEPOSIT action (tick, quantity, contract address) 3. Process through indexer | Caller's balance decremented. `contract_balances` table shows contract holds the tokens. |
| E2E-021 | Contract-initiated withdrawal | 1. DEPOSIT tokens to contract 2. EXECUTE contract function that emits SEND from contract's custody 3. Process emitted action | Contract's custody balance decremented. Recipient's balance incremented. |
| E2E-022 | WITHDRAW tokens from contract | 1. DEPOSIT tokens 2. Encode WITHDRAW action 3. Process through indexer | Contract custody balance decremented. Caller balance restored. Contract state unaffected (WITHDRAW is external). |
| E2E-023 | Overdraw attempt | 1. DEPOSIT 100 tokens 2. EXECUTE contract that tries to emit SEND for 200 tokens | Execution reverts or emitted action is rejected. No balance changes. Contract state rolled back. |

### 3.4 Security Enforcement

| ID | Scenario | Steps | Verification |
|----|----------|-------|-------------|
| E2E-030 | Sandbox escape attempts (full pipeline) | 1. Deploy contract containing all known escape vectors (constructor access, prototype pollution, process access, require, eval, Function constructor) 2. EXECUTE | Every escape attempt fails. Contract either reverts or returns without gaining host access. No process-level side effects. |
| E2E-031 | Non-deterministic API usage | 1. Deploy contract using `Date.now()`, `Math.random()`, `setTimeout` 2. EXECUTE | All calls throw or return undefined (globals stripped). Contract execution fails predictably. Error message indicates the blocked API. |
| E2E-032 | Gas identifier injection | 1. Deploy contract containing a variable named `__gas` (attempting to shadow the metering function) 2. Process through `validateSyntax` | Deployment rejected — `__gas` is a reserved identifier. |
| E2E-033 | Emission of invalid action | 1. Deploy contract that calls `emit.send()` with missing required fields 2. EXECUTE | ActionValidator rejects the emission. Execution fails. No partial actions applied. |
| E2E-034 | Cross-contract interference attempt | 1. Deploy Contract A 2. Deploy Contract B 3. EXECUTE Contract A (sets state) 4. EXECUTE Contract B (attempts to read Contract A's state) | Contract B cannot access Contract A's state. Each contract has isolated state namespace. |

### 3.5 Resource Limit Enforcement

| ID | Scenario | Steps | Verification |
|----|----------|-------|-------------|
| E2E-040 | Gas exhaustion (infinite loop) | 1. Deploy `infinite_loop.js` 2. EXECUTE | Execution terminates with `out_of_gas` error. `gasUsed` equals gas ceiling. No state changes persisted. Logs preserved. System stable for subsequent executions. |
| E2E-041 | Memory exhaustion (OOM) | 1. Deploy `memory_bomb.js` 2. EXECUTE | Execution terminates with `out_of_memory` error. V8 isolate disposed cleanly. No memory leak in host process. System stable for subsequent executions. |
| E2E-042 | Wall-clock timeout | 1. Deploy contract with computationally expensive but gas-efficient code (e.g., tight loop with low per-iteration gas) 2. EXECUTE with maxCpuTimeMs = 1000 (reduced for testing) | Execution terminates with `timeout` error. Isolate disposed. No state changes. |
| E2E-043 | Emission flood (>50 actions) | 1. Deploy `emit_flood.js` 2. EXECUTE | Execution fails at 51st emission. First 50 emissions discarded (atomicity). Error message indicates emission cap exceeded. |
| E2E-044 | State key flood (>10,000 keys) | 1. Deploy `state_flood.js` 2. EXECUTE | Execution fails when key limit reached. All state changes from this execution discarded. |
| E2E-045 | State value size exceeded | 1. Deploy contract that writes a >65536 byte value 2. EXECUTE | Write rejected. Execution reverts. No oversized values in `contract_state`. |
| E2E-046 | Sequential resource consumption | 1. Deploy contract 2. EXECUTE with gas usage near ceiling (succeeds) 3. EXECUTE again (gas resets per execution) | Each execution gets a fresh gas budget. Second execution succeeds. Gas does not accumulate across calls. |

### 3.6 Error Handling & Recovery

| ID | Scenario | Steps | Verification |
|----|----------|-------|-------------|
| E2E-050 | Contract throws runtime error | 1. Deploy contract with `throw new Error('oops')` 2. EXECUTE | Result: `success: false`, `error: 'error: oops'`. No state changes. Logs preserved. |
| E2E-051 | Contract calls xchain.revert() | 1. Deploy contract using `xchain.revert('insufficient balance')` 2. EXECUTE | Result: `success: false`, `error: 'revert: insufficient balance'`. State/emissions discarded. Logs preserved. |
| E2E-052 | xchain.require() failure | 1. Deploy contract: `xchain.require(false, 'precondition failed')` 2. EXECUTE | Same as revert. Clear error message propagated. |
| E2E-053 | Math error (division by zero) | 1. Deploy contract calling `xchain.math.divide('10', '0')` 2. EXECUTE | ContractRevertError with `math error:` prefix. No state changes. |
| E2E-054 | Execution after previous failure | 1. EXECUTE contract that reverts 2. EXECUTE same contract with valid params | Second execution succeeds. No residual state from failed first execution. Clean isolation between runs. |
| E2E-055 | Compilation failure (metering) | 1. Deploy contract with syntax that passes initial validation but fails metering 2. EXECUTE | Execution fails with metering error. No partial execution. |

### 3.7 State Persistence & Isolation

| ID | Scenario | Steps | Verification |
|----|----------|-------|-------------|
| E2E-060 | State persists across blocks | 1. Deploy contract 2. EXECUTE in block N (sets state key "count" = "1") 3. EXECUTE in block N+1 (reads "count", increments to "2") | Block N+1 execution reads state set in block N. Final state = "2". `contract_state` table has two rows (append-only). |
| E2E-061 | State isolation between contracts | 1. Deploy Contract A and Contract B 2. Both use state key "count" 3. EXECUTE A (sets count=10) 4. EXECUTE B (sets count=20) 5. EXECUTE A (reads count) | Contract A reads count=10, not 20. State namespaced by contract address. |
| E2E-062 | State rollback on reorg | 1. EXECUTE contract in block N (state change) 2. Simulate reorg at block N 3. Reindex from block N-1 | `contract_state` rows for block >= N deleted. State reverts to pre-block-N values. Subsequent execution sees rolled-back state. |
| E2E-063 | Delete-then-set cycle | 1. EXECUTE: set key "x" = "1" 2. EXECUTE: delete key "x" 3. EXECUTE: set key "x" = "2" | Final state: key "x" = "2". Intermediate deletion correctly tracked. Append-only history preserves all three operations. |
| E2E-064 | State dirty tracking accuracy | 1. EXECUTE contract that reads a key, writes same value back 2. Check `stateChanges` | Even if value unchanged, write is recorded (dirty tracking doesn't compare values). This is correct behavior — ensures deterministic replay. |

### 3.8 Fee Accounting & Gas Schedule

| ID | Scenario | Steps | Verification |
|----|----------|-------|-------------|
| E2E-070 | Gas fee deduction on successful execution | 1. Check caller's XCHAIN balance 2. EXECUTE contract (uses N gas) 3. Check caller's XCHAIN balance | Balance decreased by: gasUsed × GAS_PRICE. Fee sent to GAS address. |
| E2E-071 | Gas fee deduction on failed execution | 1. EXECUTE contract that reverts after consuming gas 2. Check caller's balance | Gas still charged for computation performed before failure. Partial gas consumed. |
| E2E-072 | Gas costs for different operations | 1. EXECUTE contract that performs: 10 state reads (100 gas each), 5 state writes (200 gas each), 2 emissions (500 gas each), computation loops 2. Verify total gas | Total gas = computation gas + (10 × 100) + (5 × 200) + (2 × 500) = computation + 3000. Gas breakdown matches schedule. |
| E2E-073 | DEPLOY gas cost | 1. DEPLOY a contract 2. Check gas charged | DEPLOY action has its own gas cost in the unified schedule. Verify correct deduction. |

### 3.9 Determinism Verification

| ID | Scenario | Steps | Verification |
|----|----------|-------|-------------|
| E2E-080 | Identical results across re-execution | 1. Record full execution result (state, emissions, gas, return value, logs) for a complex contract 2. Re-execute with identical inputs | Byte-for-byte identical results. Hash of serialized result matches. |
| E2E-081 | Determinism with math operations | 1. Execute contract performing extensive `xchain.math` operations (add, multiply, divide with many decimal places) 2. Re-execute | Results identical. No floating-point drift. String-based bignumber ensures precision. |
| E2E-082 | Determinism across block replay | 1. Process blocks N through N+10 containing multiple DEPLOY and EXECUTE actions 2. Roll back to N-1 3. Reprocess blocks N through N+10 | Final state identical after replay. Contract states, balances, and emitted actions all match. |

### 3.10 Oracle & Cross-Chain Integration

| ID | Scenario | Steps | Verification |
|----|----------|-------|-------------|
| E2E-090 | Oracle price read in contract | 1. Seed oracle data (price feed for BTC/USD) 2. Deploy contract that reads oracle price and conditionally emits SEND 3. EXECUTE | Contract reads correct price. Conditional logic branches correctly based on price. Gas charged for oracle reads (VM_ORACLE_READ = 100 each). |
| E2E-091 | Oracle snapshot age check | 1. Seed stale oracle data 2. Deploy contract: `xchain.require(xchain.oracle.getSnapshotAge() < 10, 'stale oracle')` 3. EXECUTE | Contract reverts with 'stale oracle' if data is old. Succeeds if fresh. |
| E2E-092 | Cross-chain attestation read | 1. Seed cross-chain attestation data 2. Deploy contract that checks `xchain.crossChain.isSettled(chain, actionIndex)` 3. EXECUTE conditionally | Contract reads attestation status correctly. Logic branches based on settlement state. |

---

## 4. Test Design Strategy

### 4.1 Environment Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    E2E Test Runner (Mocha)               │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │  Test Suite  │  │  Contract    │  │  Assertion     │  │
│  │  Scenarios   │  │  Fixtures    │  │  Helpers       │  │
│  └──────┬──────┘  └──────┬───────┘  └───────┬───────┘  │
│         │                │                   │          │
│  ┌──────▼────────────────▼───────────────────▼───────┐  │
│  │              Test Orchestration Layer              │  │
│  │  - Prepares mock ledger state                     │  │
│  │  - Deploys contracts via simulated DEPLOY action  │  │
│  │  - Executes via simulated EXECUTE action          │  │
│  │  - Processes emitted actions through mock indexer  │  │
│  │  - Verifies final state                           │  │
│  └──────────────────────┬────────────────────────────┘  │
│                         │                               │
│  ┌──────────────────────▼────────────────────────────┐  │
│  │              Simulated Platform Layer              │  │
│  ├──────────────┬────────────────┬───────────────────┤  │
│  │  XChainVM    │  Mock Indexer  │  Mock Ledger      │  │
│  │  (real)      │  State Engine  │  (in-memory DB)   │  │
│  │              │                │                    │  │
│  │  Executes    │  Applies       │  - balances        │  │
│  │  contracts   │  emitted       │  - contract_state  │  │
│  │  in sandbox  │  actions to    │  - contract_bal.   │  │
│  │              │  ledger state  │  - oracle_data     │  │
│  └──────────────┴────────────────┴───────────────────┘  │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### 4.2 Component Roles

**XChainVM (real instance)**: Use the actual `XChainVM` class — no mocking. E2E tests validate the real execution engine. Configure with production-like `gasSchedule`, `gasCeiling`, and `limits`.

**Mock Ledger (in-memory)**: An in-memory key-value store simulating the indexer database tables:
- `balances` — address/tick → quantity
- `contract_state` — contractAddress/key → value (append-only with block_index)
- `contract_balances` — contractAddress/tick → quantity
- `contracts` — contractAddress → { code, deployer, block_index }
- `oracle_prices` — coinPair/round → price
- `crosschain_attestations` — chain/actionIndex → attestation

**Mock Indexer State Engine**: Processes the VM's `emittedActions` array and applies them to the mock ledger. This is the critical glue — it translates SEND, DESTROY, MINT, etc. into balance changes. Must implement the same validation rules as the real indexer.

**Ledger Query Callbacks**: The VM's `execute()` accepts callback functions for `getBalance`, `getTokenInfo`, `getOraclePrice`, etc. Wire these to read from the mock ledger.

### 4.3 Test Orchestration Pattern

Each E2E test follows this lifecycle:

```
1. ARRANGE
   ├─ Initialize mock ledger with seed data (balances, tokens, oracle prices)
   ├─ Create XChainVM instance with production config
   └─ Prepare contract source code

2. ACT — DEPLOY
   ├─ Validate syntax via vm.validateSyntax(code)
   ├─ Store contract in mock ledger contracts table
   └─ Charge DEPLOY gas fee

3. ACT — EXECUTE (one or more times)
   ├─ Load contract code + current state from mock ledger
   ├─ Call vm.execute({ code, state, method, params, caller, contractAddress, blockContext })
   ├─ On success:
   │   ├─ Apply stateChanges/stateDeletes to mock contract_state
   │   ├─ Process emittedActions through mock indexer → update balances
   │   └─ Charge gas fee (gasUsed × GAS_PRICE)
   └─ On failure:
       ├─ Discard stateChanges/emittedActions
       ├─ Charge partial gas fee
       └─ Preserve logs for debugging

4. ASSERT
   ├─ Check mock ledger balances match expected values
   ├─ Check contract_state matches expected values
   ├─ Check execution result fields (success, error, gasUsed, returnValue, logs)
   └─ Check emittedActions count, types, and parameters
```

### 4.4 Test Data Strategy

**Contract Fixtures**: Organize test contracts by category:

```
test/e2e/contracts/
├── deploy/
│   ├── simple_token_send.js       # Minimal: emit one SEND
│   ├── multi_method_router.js     # Object export with 3+ methods
│   └── oversized_contract.js      # >64KB, should fail deployment
├── execution/
│   ├── amm_constant_product.js    # Complex math, multiple emissions
│   ├── vesting_schedule.js        # Block-height conditional logic
│   ├── counter_with_guards.js     # State read/write with require()
│   └── multi_action_batch.js      # SEND + DESTROY + MINT in one call
├── security/
│   ├── sandbox_escape_battery.js  # All known escape vectors
│   ├── nondeterministic_apis.js   # Date, Math.random, setTimeout
│   ├── gas_identifier_shadow.js   # __gas variable injection
│   └── cross_contract_probe.js    # Attempt to access other contract state
├── limits/
│   ├── infinite_loop.js           # Gas exhaustion
│   ├── memory_bomb.js             # OOM
│   ├── emit_flood_51.js           # Emission cap exceeded
│   ├── state_flood_10001.js       # State key cap exceeded
│   └── oversized_value.js         # >64KB single state value
├── errors/
│   ├── runtime_throw.js           # throw new Error()
│   ├── explicit_revert.js         # xchain.revert()
│   ├── require_failure.js         # xchain.require(false, ...)
│   └── math_division_zero.js      # xchain.math.divide by zero
└── oracle/
    ├── price_conditional.js       # Branch on oracle price
    └── stale_oracle_guard.js      # Require fresh oracle data
```

**Seed Data Profiles**: Predefined ledger states for common test setups:

| Profile | Contents |
|---------|----------|
| `basic` | 2 addresses with XCHAIN balance (for gas), 1 custom token with balances |
| `amm` | Above + token pair balances for AMM testing |
| `vesting` | Above + block context at specific heights |
| `oracle` | Above + seeded oracle price data at specific rounds |
| `empty` | Only XCHAIN gas balances (minimal) |

### 4.5 Assertion Helpers

Build assertion utilities that make tests readable and debuggable:

- `assertBalance(address, tick, expectedAmount)` — reads mock ledger, compares with `mathjs` precision
- `assertContractState(contractAddress, key, expectedValue)` — reads latest state
- `assertContractStateDeleted(contractAddress, key)` — confirms key no longer exists
- `assertEmittedActions(result, expectedActions)` — deep comparison of action array
- `assertGasInRange(result, min, max)` — gas consumed within expected range
- `assertReverted(result, messageSubstring)` — checks `success: false` and error contains substring
- `assertOutOfGas(result)` — checks for gas exhaustion error pattern
- `assertOutOfMemory(result)` — checks for OOM error pattern
- `assertTimeout(result)` — checks for timeout error pattern
- `assertLogsContain(result, substring)` — checks logs array

### 4.6 Block Context Simulation

Contracts access block context via `xchain.getBlockHeight()`, `xchain.getBlockTimestamp()`, `xchain.getBlockHash()`. Tests must provide realistic block contexts:

```javascript
const blockContext = {
  height: 100,
  timestamp: 1700000000,
  hash: 'abc123...'
};
```

For multi-block scenarios (E2E-013, E2E-060), increment block context between executions to simulate real block progression.

### 4.7 Framework & Configuration

- **Framework**: Mocha (consistent with existing xchain-vm and xchain-e2e-test suites)
- **Timeout**: `--timeout 0` (some E2E scenarios involve multiple sequential executions)
- **Assertion library**: Node.js `assert` (consistent with existing tests)
- **Math comparisons**: Always use `mathjs` bignumber for amount assertions — never native JS comparison
- **Parallelism**: E2E tests should run sequentially (shared mock ledger state within each test, but fresh state per test)
- **CI integration**: Separate npm script (`npm run test:e2e`) from unit tests, as E2E tests are slower

---

## 5. Test Execution Phases

### Phase 1: Core Pipeline (Priority: Critical)
Deploy → Execute → State Change → Balance Update

| Scenarios | Focus |
|-----------|-------|
| E2E-001 through E2E-005 | Basic deployment and execution |
| E2E-020 through E2E-023 | DEPOSIT / WITHDRAW lifecycle |
| E2E-050 through E2E-054 | Error handling and recovery |
| E2E-060 through E2E-064 | State persistence and isolation |

### Phase 2: Security & Limits (Priority: Critical)
Verify the VM cannot be exploited or abused

| Scenarios | Focus |
|-----------|-------|
| E2E-030 through E2E-034 | Sandbox and gateway security |
| E2E-040 through E2E-046 | Resource limit enforcement |
| E2E-080 through E2E-082 | Determinism verification |

### Phase 3: Complex Workflows (Priority: High)
Real-world contract patterns

| Scenarios | Focus |
|-----------|-------|
| E2E-010 through E2E-014 | Multi-action, conditional, stateful contracts |
| E2E-070 through E2E-073 | Fee accounting accuracy |

### Phase 4: Extended APIs (Priority: Medium)
Oracle and cross-chain integration

| Scenarios | Focus |
|-----------|-------|
| E2E-090 through E2E-092 | Oracle and cross-chain reads |

---

## 6. Risk Matrix

| Risk | Likelihood | Impact | Mitigation via E2E |
|------|-----------|--------|-------------------|
| Sandbox escape leads to host access | Low | Critical | E2E-030: Full escape battery through real pipeline |
| Gas metering bypass allows infinite execution | Low | Critical | E2E-040, E2E-042: Verify termination under real conditions |
| Emitted actions corrupt ledger state | Medium | Critical | E2E-012, E2E-023: Validate action→state pipeline |
| State leaks between contracts | Low | High | E2E-034, E2E-061: Cross-contract isolation verification |
| Non-deterministic execution across nodes | Low | Critical | E2E-080–082: Replay and compare results |
| Fee accounting error (over/under charge) | Medium | High | E2E-070–073: Verify gas→fee pipeline |
| Reorg causes inconsistent contract state | Medium | High | E2E-062: State rollback verification |
| OOM crash destabilizes host process | Low | High | E2E-041: Verify clean disposal after OOM |
| Partial state commit on error | Low | Critical | All error scenarios: Verify atomicity |

---

## 7. Success Criteria

1. **All Phase 1 and Phase 2 scenarios pass** before any xchain-vm release to production.
2. **Determinism tests (E2E-080–082)** produce identical results across 10 consecutive runs.
3. **No security scenario (E2E-030–034)** permits unauthorized access or action.
4. **No resource limit scenario (E2E-040–046)** leaves the system in an inconsistent state.
5. **All balance assertions** use `mathjs` bignumber comparison with zero tolerance.
6. **Test suite completes** in under 120 seconds (excluding timeout-specific tests which may need longer individual timeouts).

---

## 8. Dependencies & Prerequisites

| Dependency | Status | Notes |
|-----------|--------|-------|
| `isolated-vm` npm package | Required | Must be compiled for target platform. Tests skip gracefully if unavailable. |
| Mock indexer state engine | To build | Core piece — translates emitted actions into ledger state changes. |
| Contract fixture library | To build | Reuse existing `test/contracts/` as starting point, extend for E2E scenarios. |
| Oracle data seeding | To build | Required for Phase 4 scenarios. |
| Block replay harness | To build | For determinism and reorg scenarios (E2E-062, E2E-080–082). |

---

*Generated: 2026-04-03*
