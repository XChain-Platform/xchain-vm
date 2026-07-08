# XChain VM - Boundary Testing Plan

## 1. Rationale

The XChain VM executes untrusted smart contract code in sandboxed V8 isolates. Every resource limit, validation threshold, and input constraint is a boundary where the system must transition cleanly from "accepted" to "rejected." Boundary failures in this context can lead to:

- **Consensus divergence**: If boundary behavior differs across nodes (e.g., off-by-one in gas ceiling enforcement), the network forks.
- **Resource exhaustion**: Inputs at the edge of limits may trigger worst-case allocations that escape metering.
- **State corruption**: Values at size limits may be silently truncated or mis-serialized, corrupting contract state.
- **Sandbox escape**: Crafted inputs at parser/metering boundaries could bypass gas injection or exploit V8 edge cases.
- **Denial of service**: Compilation or metering of pathological code near size limits may block the indexer.

Testing exact boundary values (at, one below, one above each limit) is the most effective way to surface these defects.

---

## 2. Target Parameters & Limits

### 2.1 Resource Limits (Configurable)

| Parameter | Default | Source |
|---|---|---|
| `gasCeiling` | 1,000,000 | `index.js:195` |
| `maxCpuTimeMs` | 30,000 ms | `index.js:197` |
| `maxMemory` | 8 MB | `index.js:198` |
| `maxEmissions` | 50 | `index.js:199` |
| `maxStateKeys` | 10,000 | `index.js:200` |
| `maxStateValueSize` | 65,536 bytes (UTF-8) | `index.js:201` |
| `maxCodeSize` | 65,536 bytes | `index.js:202` |
| Return value truncation | 65,536 bytes | `index.js:345,350` |

### 2.2 Fixed Caps (Hardcoded)

| Parameter | Value | Source |
|---|---|---|
| Log entry cap | 100 entries | `collector.js:22` |
| Log entry size | 1,024 bytes | `collector.js:23` |
| Binary expression depth for gas injection | 10 levels | `metering.js:193` |
| Syntax check isolate memory | 8 MB | `isolate.js:33` |

### 2.3 Gas Schedule Costs

| Operation | Schedule Key | Source |
|---|---|---|
| Computation (per `__gas` call) | `VM_COMPUTATION` | `gas.js:24` |
| State read | `VM_STATE_READ` | `gateway.js:39` |
| State write | `VM_STATE_WRITE` | `gateway.js:60` |
| State delete | `VM_STATE_DELETE` | `gateway.js:64` |
| Oracle read | `VM_ORACLE_READ` | `gateway.js:72` |
| Cross-chain read | `VM_CROSSCHAIN_READ` | `gateway.js:90` |
| Emission | `VM_EMISSION` | `gateway-emit.js:18` |

### 2.4 Validation Boundaries

| Boundary | Constraint | Source |
|---|---|---|
| State value: null/undefined | Rejected | `state.js:38` |
| State value: NaN/Infinity | Rejected | `state.js:42` |
| State value: non-serializable | Rejected | `state.js:46-48` |
| State key: new key when at limit | Rejected | `state.js:56` |
| Emission params: not an object | Rejected | `gateway-emit.js:9-10` |
| Emission: missing required fields | Rejected per action type | `gateway-emit.js:22-95` |
| Action type: not in ALLOWED_ACTIONS set | Rejected | `validator.js:16` |
| Math: division by zero | Throws ContractRevertError | `math.js:20` |
| Math: non-numeric string input | Throws ContractRevertError | `math.js:29-36` |
| Reserved identifier `__gas` in source | Rejected at deploy | `syntax.js:43`, `metering.js:255` |
| ECMAScript version | 2020 max | `metering.js:91`, `syntax.js:60` |
| Contract export shape | Function or object with named methods | `index.js:169-178` |

---

## 3. Boundary Value Scenarios

### 3.1 Gas Ceiling Enforcement

| # | Scenario | Input | Expected Outcome |
|---|---|---|---|
| G-1 | Gas used exactly at ceiling | Contract that performs exactly `gasCeiling / VM_COMPUTATION` computation steps | `success: true`, `gasUsed === gasCeiling` |
| G-2 | Gas used one unit above ceiling | Same contract + one extra computation step | `success: false`, `error: out_of_gas` |
| G-3 | Gas ceiling of 1 | `gasCeiling: 1`, any contract | Fails immediately on first `__gas()` call (or succeeds with exactly 1 gas if the first operation costs exactly 1) |
| G-4 | Gas ceiling of 0 | `gasCeiling: 0` | First `__gas()` call charges 1, exceeds 0 → `out_of_gas` |
| G-5 | Gas exactly at ceiling after a state write | Contract does computation up to `gasCeiling - VM_STATE_WRITE`, then one `state.set()` | `success: true`, gas equals ceiling |
| G-6 | Gas overflow after mixed operations | Contract combining computation + reads + writes + emissions that sum to exactly `gasCeiling + 1` | `out_of_gas`, state changes discarded (atomicity) |
| G-7 | Negative gas schedule values | `VM_COMPUTATION: -1` | Investigate: does `used` decrease? Could this bypass the ceiling? |

### 3.2 Wall-Clock Timeout

| # | Scenario | Input | Expected Outcome |
|---|---|---|---|
| T-1 | Execution completes just under timeout | Contract with a calibrated busy loop finishing at ~`maxCpuTimeMs - 500ms` | `success: true` |
| T-2 | Execution exceeds timeout | Infinite loop with `gasCeiling` set very high so gas doesn't trigger first | `error: timeout` |
| T-3 | Timeout of 1ms | `maxCpuTimeMs: 1` | Nearly all contracts fail with timeout |
| T-4 | Timeout of 0ms | `maxCpuTimeMs: 0` | Behavior undefined - should fail gracefully, not crash |

### 3.3 Memory Limit

| # | Scenario | Input | Expected Outcome |
|---|---|---|---|
| M-1 | Allocate just under memory limit | Contract builds a string/array approaching 8MB | `success: true` (if gas allows) |
| M-2 | Allocate over memory limit | Memory bomb: exponential string doubling | `error: out_of_memory` |
| M-3 | Memory limit of 1 MB | `maxMemory: 1`, normal contract | Should execute (V8 base footprint may or may not fit) |
| M-4 | Repeated small allocations | Many small allocations summing to > limit | `out_of_memory`, not a crash |

### 3.4 Code Size

| # | Scenario | Input | Expected Outcome |
|---|---|---|---|
| CS-1 | Code at exactly maxCodeSize (65,536 bytes) | Pad with comments to reach exactly 65,536 bytes | Accepted: parses, meters, and executes |
| CS-2 | Code at maxCodeSize + 1 byte | 65,537 bytes | **Gap identified**: `maxCodeSize` is stored in limits but not enforced in `index.js` - verify if the indexer enforces this before calling `vm.execute()`. If not, this is a missing validation. |
| CS-3 | Empty code (0 bytes) | `code: ""` | Should fail at parse/compilation, not crash |
| CS-4 | Code = 1 byte | `code: ";"` | Parses but exports nothing → `error: contract must export a function or object` |
| CS-5 | Code with extremely long single line | 65,536 characters on one line, no newlines | Must not cause parser stack overflow or metering failure |
| CS-6 | Compilation of worst-case metered code | Code that maximizes AST node count within 65KB (many nested ternaries, binary expressions) | Must complete metering within a reasonable time, not block the indexer |

### 3.5 State Management

| # | Scenario | Input | Expected Outcome |
|---|---|---|---|
| S-1 | Set key count to exactly maxStateKeys | Start with 0 keys, set exactly 10,000 | `success: true`, all 10,000 keys in `stateChanges` |
| S-2 | Set key count to maxStateKeys + 1 | Set 10,001st key | `error: contract exceeds max state keys` |
| S-3 | Delete then re-add at limit | At 10,000 keys, delete one, add a new one | `success: true` - `keyCount` decrements on delete, allowing one more |
| S-4 | Value at exactly maxStateValueSize | JSON.stringify of value = exactly 65,536 UTF-8 bytes | `success: true` |
| S-5 | Value at maxStateValueSize + 1 byte | 65,537 bytes after serialization | `error: state value exceeds max size` |
| S-6 | Multi-byte UTF-8 at boundary | String with multi-byte characters where `string.length < 65536` but `Buffer.byteLength > 65536` | Must reject - the check uses `Buffer.byteLength`, not `string.length` |
| S-7 | State value: empty string `""` | `xchain.state.set('key', '')` | Should succeed - empty string is valid, not null |
| S-8 | State value: empty object `{}` | `xchain.state.set('key', {})` | Should succeed - serializes to `"{}"` (2 bytes) |
| S-9 | State value: deeply nested object | Object nested 100+ levels deep | JSON.stringify succeeds but may be large - should be caught by size limit, not crash |
| S-10 | State value: circular reference | Object with circular reference | `JSON.stringify` throws → should produce a clear error |
| S-11 | State key: empty string `""` | `xchain.state.set('', 'value')` | Should succeed (no key validation exists) - verify this is acceptable |
| S-12 | State key: very long string | 100KB key name | No key size limit exists - potential resource concern |
| S-13 | Pre-loaded state at maxStateKeys | `initialState` with 10,000 keys, then try to add one more | `keyCount` initialized from `Object.keys(initialState).length` → should reject new key |
| S-14 | Delete-set-delete cycle | Delete key, set same key, delete again | `keyCount` should be correct; dirty map should show `null` |

### 3.6 Emission Limits

| # | Scenario | Input | Expected Outcome |
|---|---|---|---|
| E-1 | Emit exactly maxEmissions (50) | Contract emits 50 actions | `success: true`, `emittedActions.length === 50` |
| E-2 | Emit maxEmissions + 1 (51) | Contract emits 51st action | `error: emission limit exceeded` |
| E-3 | Emit 0 actions | Contract does computation only | `success: true`, `emittedActions === []` |
| E-4 | Emit with maxEmissions = 0 | Configure `maxEmissions: 0` | First emit fails immediately |
| E-5 | Emit after revert | Emit 50 actions then revert | `success: false`, `emittedActions === []` (atomicity) |
| E-6 | Gas exhaustion during emission burst | Emit actions until gas runs out before hitting emission cap | `out_of_gas`, emissions discarded |
| E-7 | Each of 16 action types at cap | Fill 50 emissions using a mix of all 16 action types | All 50 captured correctly with correct types |

### 3.7 Log Limits

| # | Scenario | Input | Expected Outcome |
|---|---|---|---|
| L-1 | Log exactly 100 entries | Contract calls `xchain.log()` 100 times | All 100 preserved, `isLogFull() === true` |
| L-2 | Log 101 entries | Contract calls `xchain.log()` 101 times | Only first 100 preserved, 101st silently dropped |
| L-3 | Log entry at exactly 1,024 bytes | Single log message of 1,024 chars | Preserved without truncation |
| L-4 | Log entry at 1,025 bytes | Single log message of 1,025 chars | Truncated to 1,024 + `'...(truncated)'` suffix |
| L-5 | Log empty string | `xchain.log('')` | Preserved as empty string |
| L-6 | Logs preserved on failure | Log 50 entries, then revert | `success: false`, `logs.length === 50` |
| L-7 | Multi-byte characters in log | Log entry with emoji/CJK near 1,024 byte boundary | `message.length` vs byte length - **potential issue**: truncation uses `message.substring(0, 1024)` which counts characters, not bytes. A 1,024-character CJK string could be ~3,072 bytes. |

### 3.8 Return Value Truncation

| # | Scenario | Input | Expected Outcome |
|---|---|---|---|
| R-1 | Return value exactly 65,536 bytes serialized | Contract returns a string whose JSON serialization is exactly 65,536 bytes | `returnValue.length === 65536` |
| R-2 | Return value at 65,537 bytes | One byte over | `returnValue.length === 65536` (truncated) |
| R-3 | Return undefined | Contract returns nothing | `returnValue === null` |
| R-4 | Return null | `return null` | `returnValue === null` |
| R-5 | Return non-serializable value | Function reference, symbol, or circular object | `returnValue === null` (caught by JSON.stringify in try/catch at `index.js:348-354`) |

### 3.9 Math Operations

| # | Scenario | Input | Expected Outcome |
|---|---|---|---|
| MA-1 | Division by zero | `xchain.math.divide('100', '0')` | `ContractRevertError: math error: Division by zero` |
| MA-2 | Extremely large numbers | `xchain.math.add('9'.repeat(10000), '1')` | Should succeed - mathjs bignumber has arbitrary precision |
| MA-3 | Extremely small decimal | `xchain.math.divide('1', '3')` → very long result | Should return a fixed-notation string, not scientific notation |
| MA-4 | Negative numbers | `xchain.math.subtract('0', '1')` → `'-1'` | Should handle correctly |
| MA-5 | Non-numeric string input | `xchain.math.add('abc', '1')` | `ContractRevertError: math error: ...` |
| MA-6 | Empty string input | `xchain.math.add('', '1')` | Should throw, not return NaN |
| MA-7 | Scientific notation input | `xchain.math.add('1e18', '1')` | Verify: does mathjs accept this? If yes, does it produce deterministic output? |
| MA-8 | Infinity/NaN string input | `xchain.math.add('Infinity', '1')` | Should throw ContractRevertError |
| MA-9 | isZero edge cases | `xchain.math.isZero('0')`, `'0.0'`, `'-0'`, `'0.00000'` | All should return `true` |
| MA-10 | mod by zero | `xchain.math.mod('10', '0')` | Should throw (mathjs returns NaN for mod by zero) |

### 3.10 Metering & AST Injection

| # | Scenario | Input | Expected Outcome |
|---|---|---|---|
| ME-1 | Binary expression depth exactly 10 | `a + b + c + ... + k` (10 levels) | No extra gas injection at this depth |
| ME-2 | Binary expression depth 11 | 11-level chain | Gas injection inserted at depth 10 - extra gas charged |
| ME-3 | Deeply nested ternaries | 50+ nested `a ? b : c ? d : ...` | Each wraps test with gas - must not stack overflow during metering |
| ME-4 | Contract using `__gas` identifier | `var __gas = 1;` | Rejected at deploy: `syntax.js` reserved identifier check |
| ME-5 | Code that is valid ES2020 but invalid ES2021+ | Optional chaining (`?.`), nullish coalescing (`??`) are ES2020 ✓ - class fields are ES2022 ✗ | ES2022+ syntax should fail at parse |
| ME-6 | Enormous switch statement | Switch with 10,000 cases | Each case gets a gas call - metering output may be very large. Verify metering completes and output is within code size bounds for V8 compilation |
| ME-7 | Arrow function with expression body | `const f = () => heavyExpression` | Body wrapped with `(__gas(1), heavyExpression)` |

### 3.11 Sandbox Escape Boundaries

| # | Scenario | Input | Expected Outcome |
|---|---|---|---|
| SB-1 | Access stripped globals | `typeof process`, `typeof require`, `typeof fetch` | All return `'undefined'` |
| SB-2 | Reconstruct Function from prototype | `(function(){}).constructor('return this')()` | Should fail - sandbox strips `Function` constructor |
| SB-3 | Access `globalThis` properties | Enumerate `Object.getOwnPropertyNames(globalThis)` | Should not include `__state_get`, etc. (cleaned up by harness) |
| SB-4 | Prototype pollution | `Object.prototype.polluted = true` | Succeeds within isolate but must not affect host |
| SB-5 | Eval via indirect means | `var e = eval; e('1+1')` | Should fail - eval is stripped |
| SB-6 | `Date` usage | `new Date()`, `Date.now()` | Should be undefined/throw - stripped by sandbox |
| SB-7 | `Math.random()` | `Math.random()` | Should be undefined - only deterministic Math functions allowed |
| SB-8 | SharedArrayBuffer | `new SharedArrayBuffer(8)` | Should be undefined - stripped |

### 3.12 Gateway Parameter Boundaries

| # | Scenario | Input | Expected Outcome |
|---|---|---|---|
| GW-1 | Empty params array | `opts.params: []`, contract calls `getInputParamCount()` | Returns `0` |
| GW-2 | Very large params array | 10,000 elements in `opts.params` | Should work - no cap on params array. Verify JSON serialization across isolate boundary handles this. |
| GW-3 | Params with special characters | Strings containing `\x00`, `\x01`, `\x02`, `\x03` (protocol control chars used in bridge) | **Critical**: `\x01` is used as JSON return prefix, `\x02` as return value prefix, `\x03` as error type prefix. Params containing these characters could confuse the bridge. |
| GW-4 | Missing blockContext fields | `blockContext: {}` or with null height/timestamp/hash | Should not crash - may return undefined values |
| GW-5 | Null caller address | `caller: null` | Should be accessible as `null` in contract |
| GW-6 | getBalance for nonexistent address | Query balance of address not in `opts.balances` | Should return `undefined` or `null`, not throw |
| GW-7 | getTokenInfo for nonexistent token | Query token not in `opts.tokenInfo` | Should return `undefined` or `null`, not throw |
| GW-8 | Oracle data unavailable | `oracleData: null`, contract calls `oracle.getPrice()` | Should handle gracefully |
| GW-9 | Oracle getSnapshotAge fallback | No snapshot data available | Returns `Number.MAX_SAFE_INTEGER` - verify contract handles this correctly |

### 3.13 Emit Action Field Boundaries

| # | Scenario | Input | Expected Outcome |
|---|---|---|---|
| EA-1 | SEND with quantity = "0" | `emit.send({ destination: 'x', tick: 'T', quantity: '0' })` | Passes gateway validation (no quantity range check in VM - full validation in indexer) |
| EA-2 | SEND with negative quantity | `quantity: '-1'` | Passes gateway validation - **potential gap**: VM only checks presence, not value range |
| EA-3 | SEND with non-string quantity | `quantity: 12345` (number instead of string) | Passes - no type checking on field values |
| EA-4 | ISSUE with tick = "" | `emit.issue({ tick: '' })` | Passes - empty string is not null/undefined |
| EA-5 | DISPENSER with no params | `emit.dispenser({})` | Passes - no required fields for DISPENSER |
| EA-6 | DISPENSER with null params | `emit.dispenser(null)` | `validateRequired` not called, but `params` is null → `{ ...null }` → `{}`. Should work. |
| EA-7 | Emit with extra unknown fields | `emit.send({ destination: 'x', tick: 'T', quantity: '1', evil: 'payload' })` | Extra fields passed through in `{ ...params }` - verify indexer strips unknown fields |
| EA-8 | LINK with very large actionIndex values | `coin1ActionIndex: Number.MAX_SAFE_INTEGER` | Passes VM, may fail in indexer |

---

## 4. Test Design Strategy

### 4.1 Test Structure

Each boundary test should follow this pattern:

```
GIVEN: [specific configuration and pre-conditions]
WHEN:  [exact input at boundary value]
THEN:  [precise expected outcome]
```

Tests should be organized in pairs:
- **At boundary (valid)**: Input exactly at the limit → expected success/acceptance
- **Past boundary (invalid)**: Input one unit past the limit → expected graceful failure

### 4.2 Test Environment Setup

- Use `createVM(overrides)` helper (as in existing `limits.test.js`) to configure precise limits
- Set small limits (e.g., `gasCeiling: 100`, `maxStateKeys: 5`) to make boundary conditions reachable with minimal test contracts
- Use inline contract code for precision - crafting exact gas consumption requires knowing the metering output

### 4.3 Gas Precision Testing Approach

To test gas boundaries precisely:
1. Write a minimal contract (e.g., `module.exports = function(xchain) {};`)
2. Execute it and record `gasUsed` - this is the **base cost**
3. Add one computation step, re-execute, record the delta - this is the **per-step cost**
4. Calculate the exact number of steps needed to hit `gasCeiling`
5. Test at that count (should succeed) and count + 1 (should fail)

### 4.4 State Size Precision Testing

- Use `Buffer.byteLength(JSON.stringify(value), 'utf8')` on the test side to construct values at exact byte boundaries
- Test with ASCII (1 byte/char), BMP characters (2-3 bytes/char), and supplementary plane characters (4 bytes/char) to cover UTF-8 encoding edge cases

### 4.5 Interaction Boundaries (Compound Conditions)

These are the most critical and least obvious:

| Interaction | Risk |
|---|---|
| Gas + Emissions | Contract reaches gas ceiling during an emission - is the emission counted or discarded? |
| Gas + State writes | Contract reaches gas ceiling after a state write - write is charged but result is atomically discarded |
| State keys + deletes | Delete-then-add at exactly the key limit - keyCount tracking must be precise |
| Memory + Gas | V8 may OOM before gas runs out - the VM must classify this correctly |
| Timeout + Gas | Wall-clock timeout fires before gas ceiling - must not produce different errors on different hardware |
| Code size + Metering | Metered code is significantly larger than input code - a 64KB contract may produce 200KB+ metered output. V8 must handle this. |
| Return value + Emissions | Contract returns large value AND emits 50 actions - total result size is large |
| Multiple state writes at value limit | 100 state writes each at 65KB - total dirty state ~6.5MB approaches memory limit |

### 4.6 Determinism Verification

For every boundary test that produces `success: true`, run it twice and assert:
- `gasUsed` is identical
- `stateChanges` are identical
- `emittedActions` are identical
- `returnValue` is identical

Non-deterministic boundary behavior is a consensus-breaking bug.

### 4.7 Priority Order

Tests should be implemented in this order, from highest to lowest risk:

1. **P0 - Consensus-critical**: Gas ceiling precision (G-1, G-2), timeout classification (T-2), determinism of boundary outcomes
2. **P0 - Security**: Sandbox escapes (SB-1 through SB-8), control character injection (GW-3), `__gas` identifier bypass (ME-4)
3. **P1 - Data integrity**: State key/value boundaries (S-1 through S-14), emission atomicity (E-5), return value truncation (R-1, R-2)
4. **P1 - Robustness**: Memory limits (M-1 through M-4), math edge cases (MA-1 through MA-10), metering edge cases (ME-1 through ME-7)
5. **P2 - Completeness**: Log limits (L-1 through L-7), gateway parameter edges (GW-1 through GW-9), emit field validation (EA-1 through EA-8)

---

## 5. Identified Gaps & Risks

### 5.1 Missing Validations (Potential Bugs)

| Gap | Location | Risk | Severity |
|---|---|---|---|
| `maxCodeSize` not enforced in VM | `index.js` - limit is stored but never checked before metering/compilation | Oversized code could slow metering or exhaust memory during AST parsing | Medium |
| No state key size limit | `state.js` - validates value size but not key size | Extremely long keys could bloat state storage | Low |
| Log truncation uses character count, not byte count | `collector.js:23` - `message.substring(0, 1024)` | Multi-byte strings could exceed intended storage limits | Low |
| Emit field values not type-checked | `gateway-emit.js` - only checks presence, not type | Invalid types (numbers for strings, objects for scalars) pass to indexer | Low (indexer validates) |
| Bridge control characters in user data | `index.js:44,182,286,509` - `\x01`, `\x02`, `\x03` used as protocol markers | User strings containing these characters could confuse the bridge deserializer | **High** |
| Negative gas schedule values not rejected | `gas.js` - `charge()` does `this.used += amount` with no sign check | Negative costs could reduce used gas, bypassing the ceiling | **High** |
| `gasCeiling: 0` behavior | `gas.js:19` - check is `this.used > this.ceiling` (strict greater-than) | A contract that uses exactly 0 gas would pass a ceiling of 0 - edge case | Low |
| Oracle snapshot age fallback | `gateway.js:82` - returns `Number.MAX_SAFE_INTEGER` | Contracts comparing snapshot age may misinterpret this sentinel value | Medium |

### 5.2 Compound Risk Scenarios

| Scenario | Risk |
|---|---|
| Metered code explosion | A 64KB contract with dense control flow could produce 500KB+ metered output. V8's compilation of this metered code is not bounded by `maxCodeSize`. |
| Block cache unbounded growth | `_blockCache` (Map) has no size limit. A block with thousands of unique contracts could grow the cache significantly. |
| JSON serialization across isolate boundary | The `bridge()` helper in `index.js:402-420` JSON-serializes arguments and return values. Extremely large state values (at 64KB) serialized and deserialized every call could be slow. |

---

## 6. Coverage Matrix vs. Existing Tests

| Area | Existing Coverage (`limits.test.js`) | Gaps This Plan Addresses |
|---|---|---|
| Gas ceiling | Infinite loop exceeds ceiling | Exact-at-ceiling, ceiling of 0/1, mixed operation totals |
| Memory | Memory bomb exceeds limit | Just-under-limit, minimum memory setting |
| Emissions | Flood exceeds 50 | Exactly 50, `maxEmissions: 0`, emission + revert atomicity |
| State keys | Exceeds 100 (custom limit) | Exactly at limit, delete-then-add cycle, pre-loaded state |
| State value size | Exceeds 100 bytes (custom limit) | Exactly at limit, multi-byte UTF-8, empty/circular values |
| Return value | Not tested | Truncation at 65,536, undefined/null returns |
| Logs | Not tested in limits suite | 100 entries, 1,024-byte truncation, preservation on failure |
| Math | Covered in `math.test.js` | Scientific notation, empty string, Infinity input |
| Sandbox | Covered in `sandbox.test.js` | Prototype pollution, indirect eval, globalThis enumeration |
| Metering | Covered in `metering.test.js` | Depth-10 boundary, enormous switch, arrow expression bodies |
| Code size | Not tested | At 64KB, empty code, worst-case metering expansion |
| Bridge control chars | Not tested | `\x01`/`\x02`/`\x03` in user-supplied strings |
| Timeout | Implicit in limits tests | Explicit at-boundary, `maxCpuTimeMs: 0` |
| Determinism at boundaries | Not tested | Same boundary input → identical results across runs |
