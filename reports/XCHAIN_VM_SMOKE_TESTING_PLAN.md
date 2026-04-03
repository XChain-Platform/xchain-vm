# XChain VM — Smoke Testing Plan

**Date:** 2026-04-03
**Component:** `xchain-vm`
**Scope:** Minimal, fast health-check suite to confirm basic operational readiness after build or deployment.

---

## 1. Objective

Provide a sub-5-second test suite that answers one question: **"Is the VM fundamentally operational?"** If any smoke test fails, the build is broken and no further testing is meaningful. The suite covers VM instantiation, sandbox isolation, end-to-end contract execution, and gateway interaction — the four pillars without which no smart contract can run.

---

## 2. Critical Smoke Test Scenarios (Prioritized)

### S1 — VM Instantiation (Priority: P0)

| Aspect | Detail |
|--------|--------|
| **What** | Construct an `XChainVM` instance with a minimal `gasSchedule`, default `gasCeiling`, and default `limits`. |
| **Verify** | Constructor returns without throwing. `vm.beginBlock()` and `vm.endBlock()` complete without error. |
| **Why critical** | Every other operation depends on a valid VM instance. If `isolated-vm` native module is missing or misconfigured, this fails immediately and surfaces the root cause. |
| **Estimated time** | < 100 ms |

### S2 — Sandbox Environment Creation (Priority: P0)

| Aspect | Detail |
|--------|--------|
| **What** | Call `vm.execute()` with a trivial contract that accesses a stripped global (e.g., `typeof Date`) and returns the result. |
| **Verify** | Execution succeeds (`result.success === true`). The return value confirms `Date` is `"undefined"`, proving the sandbox stripped non-deterministic APIs. |
| **Why critical** | If the sandbox fails to initialize or strip globals, contracts run in a non-deterministic environment — a consensus-breaking defect. This is the single cheapest way to verify the entire isolate-creation + `stripGlobals()` + harness-injection pipeline. |
| **Estimated time** | < 500 ms |

### S3 — Basic Contract Execution (Priority: P0)

| Aspect | Detail |
|--------|--------|
| **What** | Execute a minimal contract that performs a state write and a state read, then returns a value. A good candidate is a stripped-down version of the `state_counter` fixture: set `counter` to `"0"`, read it back, return it. |
| **Verify** | `result.success === true`. `result.returnValue` equals `"0"`. `result.stateChanges` contains the expected key. `result.gasUsed > 0` (metering is operational). |
| **Why critical** | Exercises the full execution pipeline end-to-end: code metering (`acorn` parse + `__gas()` injection + `astring` regeneration), V8 compilation, contract wrapper invocation, state manager CRUD, and result collection. A failure here means the core execution engine is broken. |
| **Estimated time** | < 500 ms |

### S4 — Multi-Method Dispatch (Priority: P1)

| Aspect | Detail |
|--------|--------|
| **What** | Execute a contract that exports an object with multiple named methods. Call one specific method by name. |
| **Verify** | `result.success === true`. The correct method was invoked (verified by a distinct return value or state key). |
| **Why critical** | The contract wrapper dispatches to methods via `contractExports[__methodName]`. If method dispatch is broken, no real-world contract (which almost universally uses multi-method exports) will work, even though single-function contracts might. |
| **Estimated time** | < 500 ms |

### S5 — Platform Action Gateway — Emit (Priority: P0)

| Aspect | Detail |
|--------|--------|
| **What** | Execute a contract that calls `xchain.emit.send()` with valid parameters (destination, tick, quantity). |
| **Verify** | `result.success === true`. `result.emittedActions` contains exactly one action of type `SEND` with the expected fields. The `ActionValidator` did not reject it. |
| **Why critical** | Emission is the VM's primary side-effect mechanism — it's how contracts move tokens, create assets, and trigger cross-chain actions. This verifies the full gateway bridge: host-side `ivm.Reference` callback, JSON serialization across the isolate boundary, `EmissionCollector` accumulation, and `ActionValidator` post-validation. |
| **Estimated time** | < 500 ms |

### S6 — Platform Action Gateway — Context Accessors (Priority: P1)

| Aspect | Detail |
|--------|--------|
| **What** | Execute a contract that reads `xchain.getBlockHeight()`, `xchain.getSourceAddress()`, and `xchain.getInputParam(0)`, then returns them. |
| **Verify** | `result.success === true`. Returned values match the `blockContext`, `caller`, and `params` passed to `vm.execute()`. |
| **Why critical** | Context accessors are the contract's only view of the outside world. If the gateway bridge silently returns `undefined` or corrupts values, contracts will malfunction in subtle ways that are hard to debug downstream. |
| **Estimated time** | < 300 ms |

### S7 — Deterministic Math (Priority: P1)

| Aspect | Detail |
|--------|--------|
| **What** | Execute a contract that performs `xchain.math.add("1", "2")` and returns the result. |
| **Verify** | `result.success === true`. `result.returnValue` equals `"3"`. |
| **Why critical** | All token amounts and fee calculations go through the `mathjs` bignumber bridge. If the math gateway is broken, every financial operation in every contract is wrong. |
| **Estimated time** | < 300 ms |

### S8 — Syntax Validation (Priority: P1)

| Aspect | Detail |
|--------|--------|
| **What** | Call `vm.validateSyntax()` with a valid contract and an invalid one (e.g., `"function {{{"`). |
| **Verify** | Valid code returns `{ valid: true }`. Invalid code returns `{ valid: false, error: <string> }`. |
| **Why critical** | `validateSyntax()` gates DEPLOY actions in the indexer. If it incorrectly accepts or rejects code, the indexer either stores broken contracts or rejects valid ones — both are protocol-level failures. |
| **Estimated time** | < 50 ms |

### S9 — Error Classification — Revert (Priority: P2)

| Aspect | Detail |
|--------|--------|
| **What** | Execute a contract that calls `xchain.revert("test revert")`. |
| **Verify** | `result.success === false`. `result.error` starts with `"revert: "`. `result.stateChanges` and `result.emittedActions` are empty (atomicity preserved). `result.logs` are preserved. |
| **Why critical** | Revert is the primary contract error-handling mechanism. If revert doesn't work, contracts can't enforce preconditions, and if atomicity isn't preserved on revert, the state machine is corrupt. |
| **Estimated time** | < 300 ms |

---

## 3. Execution Strategy

### 3.1 — Runner

| Aspect | Recommendation |
|--------|---------------|
| **Framework** | Mocha (already used for the full test suite — no new dependency). |
| **Entry point** | `npm run smoke` — a dedicated script in `package.json` that runs only the smoke test file. |
| **File location** | `test/smoke.test.js` — single file, clearly separated from the full suite. |
| **Timeout** | `--timeout 10000` (10 s hard ceiling; expected wall-clock is < 3 s). |

### 3.2 — CI/CD Integration

```
Build → npm install → npm run smoke → (if pass) → npm test (full suite)
                                     → (if fail) → ABORT, report failure
```

- Smoke tests run **before** the full 81+ test suite. If smoke fails, the full suite is skipped entirely, saving ~30 s of CI time and providing an immediate, clear signal.
- Smoke tests should also run as a **post-deployment health check** in staging/production-like environments where the VM is deployed as part of the indexer.

### 3.3 — Isolation

- Each smoke test scenario creates its own `XChainVM` instance — no shared state between tests.
- No external dependencies (no MariaDB, no coin node, no network). The VM is a pure in-process library; smoke tests exercise it as such.
- Inline contract source strings (not fixture files) to keep the smoke suite self-contained and immune to fixture changes breaking the health check.

---

## 4. Pass/Fail Criteria

| Criterion | Pass | Fail |
|-----------|------|------|
| **VM instantiation** | Constructor completes; `beginBlock()`/`endBlock()` run without error | Any throw during construction or lifecycle |
| **Contract execution** | `result.success === true` for happy-path scenarios | `result.success === false` or unhandled exception |
| **Return values** | Match expected values exactly (strict equality) | Any mismatch |
| **Emitted actions** | Correct count, type, and field values | Missing, extra, or malformed actions |
| **State changes** | Expected keys present with correct values | Missing or incorrect state mutations |
| **Gas metering** | `result.gasUsed > 0` for metered operations | Zero gas on operations that should be metered |
| **Sandbox** | Non-deterministic globals are `undefined` inside the isolate | Any stripped global is accessible |
| **Error scenarios** | Correct error classification; atomicity preserved (no state changes/emissions on failure) | Wrong error type or leaked state |
| **Suite timing** | All scenarios complete in < 5 s total | Any individual scenario > 2 s or total > 5 s |

**Overall verdict:** ALL scenarios must pass. Any single failure = smoke test suite FAILS. There is no partial pass.

---

## 5. Scenarios NOT Included (and Why)

| Excluded Scenario | Reason |
|---|---|
| Gas exhaustion / infinite loops | Resource-limit enforcement is important but is a correctness concern, not an operational readiness check. Covered by `limits.test.js` in the full suite. |
| Compilation cache behavior | Optimization detail, not fundamental operability. |
| All 16 emit action types | One emit type (`SEND`) is sufficient to verify the gateway bridge. Testing all 16 is regression/integration scope. |
| Oracle / cross-chain queries | These require mock data injection and test contract-level logic, not VM operability. |
| Memory bombs / OOM handling | Stress/adversarial testing, not smoke. |
| Float warnings | Advisory feature, not critical path. |
| Concurrent isolate execution | Performance/scalability concern, not health check. |

---

## 6. Rationale — Why Smoke Testing is Critical for the VM

The XChain VM sits at the center of the platform's smart contract pipeline. Every DEPLOY and EXECUTE action processed by the indexer flows through it. A broken VM means:

1. **Silent consensus failure** — If the sandbox doesn't strip globals or metering doesn't inject correctly, contracts produce non-deterministic results. Different nodes diverge without any error being raised.
2. **Total contract blackout** — If the VM can't instantiate an isolate or compile the harness, every contract execution fails. No tokens move, no state updates, no emissions.
3. **Cascading indexer failure** — The indexer calls `vm.execute()` synchronously per block. An unhandled exception or hang in the VM stalls the entire indexing pipeline.

A fast smoke suite that runs in seconds catches all three failure modes before the full test suite (30+ seconds) or, worse, production traffic discovers them. The cost of running 9 scenarios in < 5 seconds is negligible; the cost of deploying a VM that can't create an isolate is catastrophic.

---

## Appendix: Minimal Contract Templates for Smoke Scenarios

These are conceptual templates showing what each smoke test contract would look like. They are provided for planning clarity, not as production test code.

**S2 — Sandbox check:**
```javascript
module.exports = function(xchain) { return typeof Date; };
```

**S3 — Basic execution with state:**
```javascript
module.exports = function(xchain) {
    xchain.state.set('counter', '0');
    return xchain.state.get('counter');
};
```

**S5 — Emit SEND:**
```javascript
module.exports = function(xchain) {
    xchain.emit.send({ destination: '...', tick: 'TEST', quantity: '100' });
    return 'emitted';
};
```

**S7 — Math bridge:**
```javascript
module.exports = function(xchain) { return xchain.math.add('1', '2'); };
```

**S9 — Revert:**
```javascript
module.exports = function(xchain) { xchain.revert('test revert'); };
```
