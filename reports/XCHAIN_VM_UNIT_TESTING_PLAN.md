# XChain VM Unit Testing Plan

**Date:** 2026-04-03  
**Component:** xchain-vm  
**Current Test Count:** 81+ tests across 11 test files  
**Framework:** Mocha (--timeout 0)

---

## 1. Rationale

The XChain VM is the deterministic smart contract execution engine for the XChain Platform. It runs untrusted JavaScript inside sandboxed V8 isolates, with every ledger-affecting operation funneled through 16 predefined platform actions. Flaws in this component can directly lead to:

- **Unauthorized ledger mutations** - if emit validation or action enforcement is bypassed
- **Non-determinism** - if sandbox stripping misses a global, consensus across nodes diverges
- **Denial of service** - if gas metering or resource limits have gaps, a single contract can stall the indexer
- **State corruption** - if dirty-tracking, key limits, or serialization have edge-case bugs

Unit tests are the fastest, most targeted way to verify these invariants in isolation before integration with the indexer.

---

## 2. Target Components & Functions

### 2.1 Gas Metering (`metering.js`, `gas.js`)

**Current coverage:** 28 metering tests, 7 gas tracker tests - solid baseline.

**Gaps to address:**

| Area | Specific Tests Needed |
|------|----------------------|
| Deep binary expressions | Verify `__gas()` injection at depth-10 boundary for chains like `a+b+c+d+...` (12+ operands). Confirm gas is charged, not just injected. |
| Interaction of injection phases | Code combining loops, ternaries, deep binaries, and call expressions - verify total gas call count matches expectations. |
| Arrow function edge cases | Arrow with destructured params, default values, rest params - metered source must remain syntactically valid. |
| Directive prologue correctness | Multiple directives (`"use strict"; "use asm"`) - gas inserted after all of them. |
| `hasGasIdentifier` false negatives | Property access (`obj.__gas`), string containing `__gas`, comment containing `__gas` - must not false-positive. |
| Negative/zero gas charge | `GasTracker.charge(0)` and `charge(-1)` - define expected behavior (no-op vs error). |
| Ceiling exactly zero | `new GasTracker(schedule, 0)` - first charge should immediately exhaust. |

### 2.2 Sandbox & Determinism (`sandbox.js`, `determinism.test.js`)

**Current coverage:** 10 sandbox tests, 5 determinism tests.

**Gaps to address:**

| Area | Specific Tests Needed |
|------|----------------------|
| Complete global removal | `WeakRef`, `FinalizationRegistry`, `Proxy`, `SharedArrayBuffer`, `Atomics`, `fetch`, `XMLHttpRequest`, `WebSocket`, `importScripts`, `queueMicrotask` - each must be `undefined` inside isolate. |
| Indirect access patterns | `(0, eval)('1+1')` (indirect eval), `Object.getPrototypeOf(Object.getPrototypeOf({})).constructor('return this')()` (prototype chain escape), `Reflect.construct` shenanigans. |
| Math object freezing | Confirm `Math.random = () => 0.5` throws or is silently ignored inside the isolate. Confirm allowed methods (`floor`, `ceil`, `abs`, etc.) are callable. |
| Cross-run determinism with math | Same contract using `xchain.math.divide` with long decimal results - identical string output across 10 runs. |
| Date/timing channels | `new Date`, `Date.now`, `performance.now` - all must be undefined or throw. |

### 2.3 Gateway API (`gateway.js`)

**Current coverage:** 20+ tests - context accessors and state ops covered, but many API surfaces untested.

**Gaps to address:**

| Area | Specific Tests Needed |
|------|----------------------|
| Missing context accessors | `getBlockTimestamp()`, `getBlockHash()`, `getInputParamCount()` - verify they return the values passed in blockContext/params. |
| `getInputParam` boundaries | Index -1, 0, length-1, length, non-integer - expected: null for out-of-bounds. |
| `getInputParams` isolation | Mutating the returned array must not affect the gateway's internal copy. |
| `getBalance` / `getTokenInfo` | With and without matching entries; with empty balances object; with null/undefined readOnlyData. |
| Oracle accessors | `oracle.getPrice(pair)` with matching/missing data, `oracle.getPriceAtRound(pair, round)`, `oracle.getSnapshotAge()`. |
| Cross-chain accessors | `crossChain.getAttestation(chain, idx)` and `crossChain.isSettled(chain, idx)` - with present/absent data. |
| Gas charging per operation | Verify each gateway method charges the correct gas schedule entry (VM_STATE_READ, VM_STATE_WRITE, VM_STATE_DELETE, VM_ORACLE_READ, VM_CROSSCHAIN_READ, VM_EMISSION). Context accessors must charge 0. |
| `revert()` / `require()` | `revert()` with no reason, `require(false)` with no reason, `require(true, 'msg')` - no error. Verify error type is `ContractRevertError`. |
| Logging edge cases | `log()` with no args, `log()` with object/array args (should stringify), `isLogFull()` at exactly 99 and 100 entries, `getLogCount()` accuracy. |
| Gateway object freezing | Confirm `xchain.state = {}` or `xchain.emit.send = null` throws or is ignored inside contract code. |

### 2.4 Emit API & Action Validation (`gateway-emit.js`, `validator.js`)

**Current coverage:** Only SEND emission and missing-params validation tested.

**Gaps to address:**

| Area | Specific Tests Needed |
|------|----------------------|
| All 16 action types | Each emit method called with valid params - verify action is queued with correct type and deep-copied params. |
| Required field validation per type | For each of the 16 methods, call with each required field missing individually. Expect descriptive error. |
| Extra fields passthrough | Emit with extra params beyond required - verify they are preserved (not stripped). |
| Params deep copy | Mutate the params object after calling emit - queued action must retain original values. |
| Gas charging | Each emit charges `VM_EMISSION` exactly once, regardless of param count. |
| `ActionValidator.validate` | Test with each allowed action string, unknown action string ("TRANSFER", "DEPLOY"), null action, params as null, params as non-object (string, array, number). |

### 2.5 State Management (`state.js`)

**Current coverage:** 18 tests - CRUD, limits, and dirty tracking well covered.

**Gaps to address:**

| Area | Specific Tests Needed |
|------|----------------------|
| Circular reference in `set()` | Object with circular ref - should fail JSON.stringify validation. |
| Non-serializable values | Functions, Symbols, BigInt, `undefined` nested in object - expected behavior. |
| Key count after repeated delete-set | Delete key A, set key B, delete key B, set key A - verify count equals initial count. |
| Exactly at maxStateKeys | Set exactly N keys (at limit), then attempt N+1 - verify error. Then delete one and set again - should succeed. |
| Exactly at maxStateValueSize | Value whose byte length === limit - should succeed. Value at limit+1 - should fail. Test with multi-byte UTF-8 characters. |
| `getChanges()` ordering | Changes and deletes should be returned in insertion order (Map iteration order). |
| Empty string key | `state.set('', 'value')` - define expected behavior. |
| Boolean/number/array values | Ensure all JSON-serializable types work and round-trip correctly through get/set. |

### 2.6 Emission Collector (`collector.js`)

**Current coverage:** 7 tests.

**Gaps to address:**

| Area | Specific Tests Needed |
|------|----------------------|
| Emission at exactly maxEmissions | Add N actions (at limit) - should succeed. Add N+1 - should throw. |
| Log at boundary | 100th log accepted, 101st silently dropped. |
| Log truncation accuracy | Message of exactly 1024 bytes - no truncation. Message of 1025 bytes - truncated with marker. Verify marker text. |
| Multi-byte log truncation | Log with emoji/CJK at the 1024-byte boundary - verify no broken character encoding. |
| Empty action params | `add('SEND', {})` - should succeed (validation is in gateway-emit, not collector). |
| `getActions()` returns reference | Verify callers cannot corrupt internal array via the returned reference (or document this as by-design). |

### 2.7 Math API (`math.js`)

**Current coverage:** 16 tests - arithmetic, comparison, and error handling covered.

**Gaps to address:**

| Area | Specific Tests Needed |
|------|----------------------|
| Extreme precision | 50+ decimal places - verify no silent rounding or truncation. |
| Scientific notation input | `"1e18"`, `"1.5e-10"` - verify correct parsing and string output in fixed notation. |
| Very large numbers | 100+ digit integers - verify no overflow or precision loss. |
| Negative zero | `subtract("1", "1")` - should return `"0"`, not `"-0"`. |
| `mod` edge cases | `mod("10", "3")`, `mod("-10", "3")`, `mod("10", "-3")`, `mod("0", "5")`, `mod("5", "0")` (should error). |
| `isZero` with near-zero | `isZero("0.0000000000000001")` - should return false. `isZero("0.00")` - should return true. |
| Invalid input types | Non-string input (number, null, undefined, object) - verify ContractRevertError. |
| `compare` result type | Returns number (-1, 0, 1) not string - verify. |

### 2.8 Syntax Validation (`syntax.js`)

**Current coverage:** 9 tests.

**Gaps to address:**

| Area | Specific Tests Needed |
|------|----------------------|
| ES2020 boundary | ES2021+ features (logical assignment `??=`, `||=`) - verify rejection. |
| Acorn-unsupported V8 syntax | Syntax valid in V8 but not acorn ES2020 - verify caught in step 2. |
| `__gas` in various positions | As variable name, function name, property name, in destructuring, as label - verify only variable/function usage is rejected. |
| Empty code | `""` - define expected behavior. |
| Code with only comments | `"// nothing"` - should be valid. |
| Float warnings accuracy | Multiple float literals on different lines - verify all reported with correct line numbers. Integer that looks like float (`1.0`) - check behavior. |
| Large code input | Near maxCodeSize - verify validation completes without timeout. |

### 2.9 XChainVM Orchestration (`index.js`)

**Current coverage:** Tested indirectly through gateway, limits, and determinism tests.

**Gaps to address:**

| Area | Specific Tests Needed |
|------|----------------------|
| `execute()` return structure | Verify all 8 fields present in success and failure cases. |
| Atomicity on revert | Contract that sets state + emits actions then reverts - stateChanges and emittedActions must be empty, logs preserved. |
| Atomicity on gas exhaustion | Same as above but triggered by gas ceiling. |
| Atomicity on timeout | Contract with wall-clock timeout - verify clean result. |
| Return value truncation | Contract returning string > 64KB - verify truncation to 64KB. |
| Return value serialization | Contract returning object, array, number, null - verify JSON serialization. |
| Method routing: function export | `module.exports = function(xchain) {...}` - method param is ignored. |
| Method routing: object export | `module.exports = { foo, bar }` - correct method called. Unknown method - error. |
| Method routing: missing export | Code that doesn't set `module.exports` - define expected behavior. |
| `beginBlock()` / `endBlock()` | Verify compilation cache is used for same code within a block. Verify cache is cleared between blocks. |
| Error classification | Each error type (revert, gas, timeout, OOM, generic) produces the correct error prefix string. |
| Code with existing `__gas` | Should be rejected at syntax validation, not at execute time. |
| `contractIndex` caching | Same contractIndex within a block uses cached compiled script. |

### 2.10 Isolate Management (`isolate.js`)

**Current coverage:** Tested indirectly. No direct unit tests.

**Gaps to address:**

| Area | Specific Tests Needed |
|------|----------------------|
| `createIsolate()` | Returns object with isolate and context properties. Memory limit applied from config. |
| `createThrowawayIsolate()` | Returns object with isolate property. Fixed 4MB memory limit. |
| `compileScript()` | Valid code compiles successfully. Invalid code throws. |
| `compileScript()` with cached data | Cached compilation data from `getCachedData()` accepted on recompile. |
| `dispose()` idempotency | Calling dispose twice does not throw. Disposing already-disposed isolate is safe. |
| `dispose()` error resilience | If internal dispose throws, error is swallowed (not propagated). |

### 2.11 Error Classes (`errors.js`)

**Current coverage:** Implicitly tested throughout.

**Gaps to address:**

| Area | Specific Tests Needed |
|------|----------------------|
| `ContractRevertError` | Verify `instanceof Error`, `name` property, `message` matches reason, `stack` exists. |
| `GasExhaustedError` | Verify `instanceof Error`, `name`, `used`, `ceiling` properties, message format. |
| Reason-less revert | `new ContractRevertError()` - message should be undefined or empty, not crash. |

---

## 3. Test Design Strategy

### 3.1 Test Structure

Each test file should follow this pattern:

```
describe('<ModuleName>', () => {
  describe('<functionOrMethod>', () => {
    it('should <expected behavior> when <condition>', () => { ... });
  });
});
```

Group tests by: **happy path** -> **boundary conditions** -> **error cases** -> **edge cases**.

### 3.2 Input/Output Design

**Contract Execution Tests:**
- Input: Minimal contract code strings exercising one behavior each. Avoid reusing complex fixture contracts for unit tests - write targeted inline snippets.
- State: Plain objects `{ key: 'value' }` with known contents.
- Block context: Fixed objects `{ height: 100, timestamp: 1700000000, hash: '0xabc...' }`.
- Expected output: Assert on specific fields of the result object, not the entire object.

**Module-Level Tests:**
- Instantiate modules directly (`new GasTracker(schedule, ceiling)`, `new StateManager(state, limits)`, `buildGateway(...)`, etc.).
- Use minimal constructor arguments - only what's needed for the test.
- Assert on return values, thrown errors, and side effects (e.g., `getChanges()` after state ops).

### 3.3 Mocking Strategy

| Dependency | How to Mock | When to Mock |
|------------|-------------|--------------|
| `isolated-vm` | Skip tests with `before()` check if native module unavailable (already implemented). For unit tests of gateway/state/gas/math/collector, no isolate needed - test the module directly. | Always for pure-logic module tests. |
| Blockchain state | Pass plain objects as `balances`, `tokenInfo`, `oracleData`, `crossChainData` to `buildGateway()`. | All gateway tests. |
| Gas tracker | Pass a real `GasTracker` instance with high ceiling for non-gas tests. Pass a tracker with ceiling=0 or ceiling=N for gas boundary tests. | Gateway and emit tests that aren't specifically testing gas. |
| State manager | Pass a real `StateManager` with known initial state. | Gateway state operation tests. |
| Emission collector | Pass a real `EmissionCollector` with configurable max. | Gateway emit tests. |

**Key principle:** Most xchain-vm modules are pure JavaScript with no external I/O. Test them directly with real instances, not mocks. Only mock `isolated-vm` when testing modules that don't need it.

### 3.4 Assertion Strategy

- **Equality:** Use `assert.strictEqual` for primitives, `assert.deepStrictEqual` for objects/arrays.  
- **Errors:** Use `assert.throws` with error type and message matching. For async: `assert.rejects`.  
- **Gas accounting:** Assert exact gas values, not ranges - gas metering is deterministic.  
- **Determinism:** Run the same execution N times (N >= 3) and compare full result objects.  
- **Isolation:** Mutate inputs after passing them to the module - verify outputs are unaffected.

### 3.5 Test Independence

- Each `describe` block creates its own module instances in `beforeEach`.
- No shared mutable state between tests.
- Tests must pass in any order and in isolation (`--grep` friendly).
- No filesystem, network, or database access - pure in-memory.

### 3.6 Edge Case Checklist (Apply to Every Module)

- Empty/null/undefined inputs where the API accepts parameters
- Maximum-length strings and objects at configured limits
- Boundary values: exactly at limit, limit-1, limit+1
- Type mismatches: number where string expected, object where string expected
- Multi-byte UTF-8 in string parameters (state keys, values, log messages)
- Re-entrant patterns: calling the same method repeatedly in sequence

---

## 4. Priority Ordering

### P0 - Security-Critical (implement first)

1. **Sandbox escape vectors** (2.2) - indirect eval, prototype chain traversal, constructor escape
2. **Emit validation completeness** (2.4) - all 16 action types, required field enforcement
3. **Gas metering completeness** (2.1) - deep binary expressions, combined injection phases
4. **Atomicity guarantees** (2.9) - revert/gas/timeout all discard state and emissions

### P1 - Correctness-Critical

5. **Gateway API completeness** (2.3) - all untested context, oracle, cross-chain accessors
6. **State management edge cases** (2.5) - circular refs, key count accuracy, byte boundaries
7. **Math precision edge cases** (2.7) - extreme precision, negative zero, mod with zero
8. **Error classification** (2.9) - each error type maps to correct prefix

### P2 - Robustness

9. **Collector boundaries** (2.6) - exact limit behavior, multi-byte truncation
10. **Syntax validation boundaries** (2.8) - ES2020 limit, empty code, large code
11. **Isolate management** (2.10) - dispose idempotency, cache behavior
12. **Method routing** (2.9) - function vs object export, missing export

### P3 - Confidence

13. **Determinism expansion** (2.2) - cross-block, math precision, timing channels
14. **Error class properties** (2.11) - instanceof checks, property existence

---

## 5. Estimated New Test Count

| Target Area | Existing | New Tests Needed | Total |
|-------------|----------|-----------------|-------|
| Gas Metering (metering.js + gas.js) | 35 | ~12 | ~47 |
| Sandbox & Determinism | 15 | ~15 | ~30 |
| Gateway API | 20 | ~30 | ~50 |
| Emit & Validation | 2 | ~40 | ~42 |
| State Management | 18 | ~10 | ~28 |
| Collector | 7 | ~8 | ~15 |
| Math API | 16 | ~12 | ~28 |
| Syntax Validation | 9 | ~8 | ~17 |
| XChainVM Orchestration | 5 | ~15 | ~20 |
| Isolate Management | 0 | ~6 | ~6 |
| Error Classes | 0 | ~4 | ~4 |
| **TOTAL** | **~127** | **~160** | **~287** |

---

## 6. File Organization

New tests should be added to existing test files where they belong. New files only for currently untested modules:

| New File | Covers |
|----------|--------|
| `test/isolate.test.js` | Direct IsolateManager unit tests |
| `test/errors.test.js` | Error class property/behavior tests |
| `test/validator.test.js` | Direct ActionValidator unit tests |
| `test/gateway-emit.test.js` | All 16 emit methods in isolation |
| `test/index.test.js` | XChainVM orchestration (execute lifecycle, atomicity, method routing) |

Existing files to extend: `metering.test.js`, `gas.test.js`, `math.test.js`, `state.test.js`, `collector.test.js`, `sandbox.test.js`, `gateway.test.js`, `determinism.test.js`, `syntax.test.js`.

---

## 7. Success Criteria

- Every public method in every `src/` module has at least one happy-path and one error-path test
- All 16 emit action types have validation coverage
- All sandbox-stripped globals verified as undefined inside isolate
- Atomicity verified for every failure mode (revert, gas, timeout, OOM)
- All boundary conditions at configured limits tested (keys, value size, emissions, gas ceiling, code size, log count)
- Zero reliance on external services - all tests run in-memory with sub-second execution
- Tests pass deterministically on repeated runs (no flaky timing dependencies)
