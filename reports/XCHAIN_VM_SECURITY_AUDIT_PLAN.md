# XChain VM — Security Audit Plan

**Component:** `xchain-vm`  
**Criticality:** Extremely High — compromised VM security could allow unauthorized state changes, sandbox escape, or platform-wide exploitation.  
**Date:** 2026-04-03  
**Status:** Initial Audit Plan

---

## 1. Audit Scope

This audit covers the security posture of the XChain VM smart contract execution engine across seven areas:

| # | Area | Files Under Review | Priority |
|---|------|--------------------|----------|
| 1 | Sandbox Integrity & Isolation | `sandbox.js`, `isolate.js`, `index.js` (harness/wrapper) | **Critical** |
| 2 | Platform Action Gateway Enforcement | `gateway.js`, `gateway-emit.js`, `validator.js` | **Critical** |
| 3 | Gas Metering & Resource Exhaustion | `metering.js`, `gas.js`, `index.js` (timeout/memory) | **Critical** |
| 4 | Input Validation | `syntax.js`, `state.js`, `gateway-emit.js`, `math.js` | **High** |
| 5 | State Isolation & Data Integrity | `state.js`, `collector.js`, `index.js` (result assembly) | **High** |
| 6 | Information Leakage | `index.js` (`_classifyError`), `errors.js`, all gateway modules | **Medium** |
| 7 | Dependency Security | `isolated-vm`, `mathjs`, `acorn`, `acorn-walk`, `astring` | **Medium** |

### Out of Scope
- Indexer-side validation of emitted actions (handled by `xchain-indexer`).
- Network-layer security (the VM has no network access).
- Deployment infrastructure and container hardening.

---

## 2. Audit Methodology

### 2.1 Static Code Review

For each area, perform line-by-line review of the source modules listed above, tracing data flow from contract input through execution to result output. Focus on:

1. **Boundary trust analysis** — identify every point where data crosses the isolate/host boundary (`ivm.Reference` callbacks, `applySync`, `runSync`). Verify serialization/deserialization is tamper-proof.
2. **Negative-path analysis** — for each validation check, determine what happens if the check is absent or bypassed. Enumerate edge cases the check does not cover.
3. **Control flow tracing** — follow contract code from parsing (acorn) → metering injection → compilation → execution → result collection. Identify any code path that avoids gas metering.

### 2.2 Threat Modeling

Apply the STRIDE framework scoped to VM execution:

| Threat | VM-Specific Concern |
|--------|---------------------|
| **Spoofing** | Contract spoofs error types to manipulate result classification |
| **Tampering** | Contract modifies host-side state or other contracts' state |
| **Repudiation** | Execution produces different results on different nodes (non-determinism) |
| **Information Disclosure** | Error messages reveal host internals |
| **Denial of Service** | Contract exhausts host resources (CPU, memory, disk) |
| **Elevation of Privilege** | Contract escapes sandbox, calls unauthorized functions |

### 2.3 Attack Surface Enumeration

Systematically attempt (conceptually) the following attack vectors against the codebase:

1. Sandbox escape via prototype chain traversal
2. Sandbox escape via constructor access
3. Timing side-channels via unmetered operations
4. Gas metering bypass via AST edge cases
5. Error-type spoofing via `\x03` prefix injection
6. State pollution via prototype injection on state keys/values
7. Emission parameter injection (extra fields, type coercion)
8. Math operation abuse (extreme precision, NaN injection)
9. Compilation bomb / ReDoS via pathological source code
10. Return value smuggling via `\x02` prefix injection

---

## 3. Prioritized Risk Register

### CRITICAL — Sandbox Escape

#### RISK-01: Prototype Chain Traversal to Host Objects

**Threat:** A contract accesses `Object.getPrototypeOf`, `__proto__`, or `constructor` chains on injected objects to reach host-side references or the Function constructor.

**Current Mitigations Observed:**
- `Function` constructor is set to `undefined` on `globalThis` (sandbox.js:31-36).
- `Function.prototype.constructor` is redefined to `undefined` (sandbox.js:36).
- The `xchain` object is `Object.freeze()`'d (harness lines 56, 72, 77, etc.).
- Injected `__*` references are cleaned up from `globalThis` after harness assembly (harness lines 142-147).

**Residual Risk:** The `__Function` reference is stored on `globalThis` during harness execution and used in the contract wrapper (index.js:163-164). Although it is `delete`d from `globalThis` at line 163, there is a window between harness execution and contract wrapper execution. If the harness cleanup (lines 142-147) runs before the contract wrapper, `__Function` would already be removed from globals. However, the contract wrapper itself reads `__Function` before deleting it — this is the designed flow. **Verify:** Can a contract observe `__Function` before the wrapper deletes it? The wrapper runs as a single compiled script, so the contract code inside the `new __Fn(...)` call should not have access to `__Function` since it's passed via `module`/`exports`/`xchain` parameters only. **Action:** Confirm with targeted testing.

**Additional Concern:** `Object.getPrototypeOf(xchain)` returns `Object.prototype`. From `Object.prototype`, can the contract reach `Function`? In standard V8: `Object.prototype.constructor` → `Object` → `Object.constructor` → `Function`. But `Function` is set to `undefined` on `globalThis`. **Verify:** Does `Object.constructor` still reference the original `Function` constructor even after `globalThis.Function = undefined`? If so, this is a potential escape vector:
```javascript
Object.constructor('return process')()
```

**Recommendation:**
- Freeze `Object.prototype.constructor` to `undefined` or to a no-op.
- After `globalThis.Function = undefined`, also set `Object.constructor = undefined`.
- Consider using `Object.freeze(Object.prototype)` to prevent all prototype chain manipulation.
- Test: `({}).__proto__.constructor('return this')()` — does it return the global object?

#### RISK-02: `eval` and `Function` via Indirect References

**Threat:** Even with `eval` and `Function` set to `undefined` on `globalThis`, V8 may retain indirect references accessible via:
- `(0, eval)('...')` — indirect eval
- `[].constructor.constructor('return process')()`
- `''.constructor.constructor('return process')()`
- `(async function(){}).constructor('return process')()`
- `(function*(){}).constructor('return process')()`
- `RegExp.prototype.constructor.constructor(...)`

**Current Mitigations Observed:**
- `Function.prototype.constructor` is set to `undefined` (sandbox.js:36).
- `eval` is set to `undefined` (sandbox.js:29).

**Residual Risk:** Setting `Function.prototype.constructor = undefined` via `Object.defineProperty` may not propagate to `GeneratorFunction.prototype.constructor`, `AsyncFunction.prototype.constructor`, or `AsyncGeneratorFunction.prototype.constructor`. These are separate function types in V8 with their own prototype chains.

**Recommendation:**
- Enumerate ALL function-like constructors: `Function`, `GeneratorFunction`, `AsyncFunction`, `AsyncGeneratorFunction`.
- Neuter the `constructor` property on each.
- Test vectors: `(async()=>{}).constructor`, `(function*(){}).constructor`, `(async function*(){}).constructor`.

#### RISK-03: Proxy and Reflect for API Interception

**Threat:** The `Proxy` global is deleted (sandbox.js:20), but `Reflect` is NOT explicitly removed. `Reflect` alone cannot construct arbitrary functions, but its presence should be audited for interaction with remaining constructors.

**Current Mitigations Observed:**
- `Proxy` is deleted from `globalThis` (sandbox.js:20).

**Residual Risk:** Low. `Reflect` without `Proxy` has limited attack surface. However, `Reflect.construct` could potentially be used if any constructor reference is obtainable.

**Recommendation:**
- Remove `Reflect` from `globalThis` unless contracts explicitly need it.
- If kept, test `Reflect.construct(Object, [], function(){})` type chains.

---

### CRITICAL — Error Type Spoofing

#### RISK-04: `\x03`-Prefixed Error Spoofing

**Threat:** A contract throws `new Error('\x03REVERT:...')` or `new Error('\x03GAS:...')` to manipulate error classification and potentially alter the result structure (e.g., fake a revert to hide actual gas exhaustion, or fake gas exhaustion to manipulate gas accounting).

**Current Mitigations Observed (index.js:519-532):**
- `\x03REVERT:` errors are only classified as reverts if `execContext.reverted === true`.
- `\x03GAS:` errors are only classified as gas exhaustion if `gasTracker.used > gasTracker.ceiling`.
- This two-factor verification prevents spoofing.

**Residual Risk:** Low but nonzero.
- If a contract calls `xchain.revert()` (setting `execContext.reverted = true`) and then catches the resulting error within a try/catch, `execContext.reverted` remains `true`. A subsequent `throw new Error('\x03REVERT:custom message')` would pass the verification check, allowing the contract to spoof the revert reason.
- **Verify:** Can contract code catch a `ContractRevertError` thrown by `xchain.revert()`? The error crosses the isolate boundary — it's thrown on the host side inside the `bridge()` wrapper. The `ivm.Reference.applySync()` call would propagate the error into the isolate. If the contract wraps `xchain.revert()` in a try/catch, it might intercept the error, leaving `execContext.reverted = true` but allowing execution to continue with a spoofed throw.

**Recommendation:**
- Reset `execContext.reverted = false` on every gateway call entry, or make `revert()` throw an error that cannot be caught inside the isolate.
- Consider: after `revert()` is called, immediately terminate execution rather than throwing a catchable error.

---

### CRITICAL — Gas Metering Bypass

#### RISK-05: Unmetered Code Paths via AST Gaps

**Threat:** The AST-based gas injection (metering.js) only instruments specific node types. Code patterns that do not match any instrumented node type execute without gas charges.

**Current Injection Points:**
- Function bodies (FunctionDeclaration, FunctionExpression, ArrowFunctionExpression)
- Loops (for, while, do-while, for-in, for-of)
- Conditionals (if, switch-case, ternary)
- Try/catch/finally blocks
- Deeply nested BinaryExpressions (depth > 10)
- CallExpressions (all except `__gas` calls)

**Gaps Identified:**
1. **Property access chains** — `a.b.c.d.e.f.g.h.i.j.k.l.m.n.o.p` — arbitrarily long property access chains with no gas cost. A contract could construct a deep object graph and traverse it in computationally expensive ways without triggering gas charges.
2. **Array/object literals** — `[[[[[[[...n deep...]]]]]]]` or `{a:{b:{c:...}}}` — constructing massive nested structures without gas charges for each level.
3. **Template literals** — `` `${a}${b}${c}...${z}` `` with many interpolations — string concatenation without gas charges per interpolation.
4. **Destructuring** — `const {a,b,c,...z} = obj` — complex destructuring with no gas cost.
5. **Spread operator** — `[...a, ...b, ...c, ...d]` — spreading large arrays.
6. **Getter/setter abuse** — A contract can define getters on objects that perform expensive computation. Property access triggers the getter, which is not metered.
7. **`toString`/`valueOf` override** — Objects with custom `toString` that perform computation are invoked during string concatenation and comparison without gas metering.
8. **RegExp backtracking** — While `Function` and `eval` are blocked, `RegExp` is available. Catastrophic backtracking: `/^(a+)+$/` on a long string could consume unbounded CPU.

**Recommendation:**  
- **RegExp:** Either remove `RegExp` from the sandbox or meter regex operations. At minimum, test catastrophic backtracking patterns and verify the wall-clock timeout catches them.  
- **Property access chains:** Consider instrumenting MemberExpression nodes, or at least deeply nested chains.  
- **Getter/setter traps:** Freeze `Object.defineProperty` and `Object.defineProperties` inside the isolate to prevent runtime getter/setter creation. (Static getters in contract source would still be a risk — meter property access or limit object depth.)  
- **toString/valueOf:** Freeze `Object.prototype.toString` and `Object.prototype.valueOf`, or meter implicit coercions at string concatenation points.  
- **Wall-clock timeout:** The 30-second timeout is the backstop. Verify it always fires even under extreme CPU pressure (e.g., tight regex backtracking or CPU-bound property access loops). Note: the timeout is labeled a "consensus risk" in the code — different nodes may time out at different wall-clock times, producing different execution results.

#### RISK-06: `__gas` Identifier Collision

**Threat:** A contract defines a variable or function named `__gas` that shadows the metering callback, effectively disabling gas metering.

**Current Mitigations Observed:**
- `syntax.js` uses `hasGasIdentifier()` to reject code containing `__gas` at deploy time (syntax.js:43-44).
- `hasGasIdentifier()` walks the full AST looking for `Identifier` nodes named `__gas` (metering.js:255-271).

**Residual Risk:** Low. The check is comprehensive (walks ALL nodes including nested identifiers). However:
- `metering.js:267-269`: If acorn parsing fails, `hasGasIdentifier` returns `false` (no `__gas` found). This is acceptable because `validateSyntax` calls V8 compile first, then metering, then `hasGasIdentifier` — if acorn can't parse it, `meterCode()` would have already failed at step 2.
- **Verify:** Could a contract use computed property names like `globalThis['__' + 'gas'] = null` to overwrite the gas callback after deployment? The injected `__gas` is a `globalThis` property — after the harness cleanup (lines 142-147), `__gas` is explicitly kept (`names[i] !== '__gas'`). A contract could potentially do `globalThis.__gas = function(){}` to neuter metering.

**Recommendation:**
- Make `__gas` non-configurable and non-writable on `globalThis` via `Object.defineProperty(globalThis, '__gas', { value: gasRef, writable: false, configurable: false })`.
- Alternatively, inject `__gas` as a `const` declaration in the harness scope rather than a global property.

---

### CRITICAL — Resource Exhaustion / Denial of Service

#### RISK-07: Wall-Clock Timeout Non-Determinism

**Threat:** The wall-clock timeout (`limits.maxCpuTimeMs`, default 30s) is the final safety net for resource exhaustion. However, wall-clock time is inherently non-deterministic — the same contract may time out on a slow node but succeed on a fast node, producing divergent consensus results.

**Current Mitigations Observed:**
- The code logs at ERROR level when timeout fires and explicitly labels it a "consensus risk" (index.js:536-537).
- Gas metering is intended to halt execution before the timeout fires.

**Residual Risk:** High for unmetered code paths (see RISK-05). If a contract can consume significant CPU without triggering gas charges, the only protection is the wall-clock timeout, which is non-deterministic.

**Recommendation:**
- Close gas metering gaps (RISK-05) so the wall-clock timeout is truly a last resort, never triggered under normal operation.
- Consider implementing a CPU instruction counter (V8 `--max-count` flag or similar) as a deterministic alternative to wall-clock timeout.
- Define consensus rules for timeout handling: should a timeout be treated as a revert with full gas charged? Current behavior charges only the gas accumulated before timeout.

#### RISK-08: Memory Exhaustion on Host Process

**Threat:** Each isolate has an 8MB memory limit. If many contracts execute concurrently (or a single contract triggers many isolate creations), the host process could exhaust memory.

**Current Mitigations Observed:**
- Isolates are created per-execution and disposed in `finally` (index.js:400-401).
- Only one isolate exists per `execute()` call (synchronous execution model).

**Residual Risk:** Low for single-threaded indexer. Higher if the VM is used in concurrent/parallel contexts. Each isolate allocates native memory that is not tracked by Node.js heap limits.

**Recommendation:**
- Add a configurable limit on concurrent active isolates.
- Monitor host process RSS during extended block processing.

#### RISK-09: Compilation Bomb via Pathological Source

**Threat:** A contract with deeply nested expressions or extremely large ASTs could consume excessive memory or CPU during the acorn parse → metering → astring generate pipeline, before the isolate is even created.

**Current Mitigations Observed:**
- Code size limit of 65536 bytes (index.js:255).
- Compilation benchmark test exists (compilation.test.js).

**Residual Risk:** Medium. 64KB of source code can produce very large ASTs (e.g., deeply nested ternary expressions). The acorn/astring pipeline runs on the host process without a timeout.

**Recommendation:**
- Add a timeout or depth limit on acorn parsing.
- Add a maximum AST node count check.
- Consider metering the compilation step itself.

---

### HIGH — Input Validation Gaps

#### RISK-10: Emit Parameter Injection

**Threat:** Emit methods accept arbitrary objects as `params`. Only a few required fields are validated (gateway-emit.js). A contract can inject arbitrary extra fields that pass through to the indexer.

**Current Mitigations Observed:**
- `validateRequired()` checks presence of required fields (gateway-emit.js:8-15).
- `EmissionCollector.add()` shallow-copies params via `{ ...params }` (collector.js:18).
- `ActionValidator.validate()` checks action name is in allowlist and params is an object (validator.js:15-20).

**Residual Risk:** Medium. No validation of:
- Field types (e.g., `quantity` should be a numeric string, not an object or array).
- Field value ranges (e.g., negative quantities, zero-length ticks).
- Extra fields that the indexer might inadvertently process.
- Prototype pollution via `__proto__` or `constructor` keys in params.

**Recommendation:**
- Implement strict allowlists of permitted fields per action type.
- Validate field types and value ranges.
- Use `Object.create(null)` instead of `{ ...params }` to prevent prototype pollution.
- Strip `__proto__` and `constructor` keys from emitted params.

#### RISK-11: State Key Prototype Pollution

**Threat:** A contract sets state keys like `__proto__`, `constructor`, `toString`, or `hasOwnProperty` that could interfere with JavaScript object operations on the state object.

**Current Mitigations Observed:**
- `StateManager` uses `key in this.state` (state.js:33) and `this.state[key]` (state.js:28) — both are vulnerable to prototype key collisions.
- The `has()` method uses `key in this.state` which checks the prototype chain.

**Residual Risk:** Medium. Setting `key = '__proto__'` or `key = 'constructor'` could cause unexpected behavior in state operations or downstream consumers.

**Recommendation:**
- Use `Object.create(null)` for the state store instead of `{}` (state.js:12).
- Use `Object.prototype.hasOwnProperty.call(this.state, key)` instead of `key in this.state`.
- Blacklist reserved JavaScript property names as state keys, or prefix all keys.

#### RISK-12: Math Input Parsing Abuse

**Threat:** The `mathjs` `bignumber()` function accepts various input formats beyond simple numeric strings. Malicious inputs could cause unexpected behavior.

**Current Mitigations Observed:**
- `safeMath()` wrapper catches errors and converts to `ContractRevertError` (math.js:29-37).
- All results pass through `toFixed()` for consistent output format (math.js:13-15).

**Residual Risk:** Low. `mathjs` bignumber is well-tested. However:
- Does `bignumber('1e999999999')` allocate excessive memory?
- Does `bignumber('0.1' + '0'.repeat(100000))` cause performance issues?
- The 64KB code size limit caps string literal size, but params could be longer.

**Recommendation:**
- Add input length validation on math inputs before passing to `bignumber()`.
- Test with extreme-precision inputs and very large exponents.

---

### HIGH — State Isolation

#### RISK-13: Cross-Execution State Leakage

**Threat:** State or execution context from one `execute()` call leaks into a subsequent call.

**Current Mitigations Observed:**
- Each `execute()` creates new `GasTracker`, `StateManager`, `EmissionCollector`, and `execContext` instances (index.js:247-250).
- Each `execute()` creates a new V8 isolate (index.js:263-264) and disposes it in `finally` (index.js:400-401).
- No global mutable state in the `XChainVM` class except `_blockCache` (Map of cached compilation data).

**Residual Risk:** Low. The compilation cache (`_blockCache`) stores V8 cached data keyed by `contractIndex:codeHash`. If two different contracts produce the same hash, they would share cached compilation data. **Verify:** Is `codeHash` computed on the original code or the metered code? It's computed on the original code (index.js:315). Could a contract with different metering produce the same original code hash? No — same code means same hash means same metering.

**Recommendation:**
- Verify that `_blockCache` entries cannot be poisoned (e.g., by storing malicious cached data).
- Consider using the metered code hash instead of the original code hash for additional safety.

#### RISK-14: Emission Collector Shared Reference

**Threat:** The `EmissionCollector` stores emitted action params via shallow copy (`{ ...params }`). If a contract retains a reference to nested objects within params and mutates them after emission, the emitted action could be corrupted.

**Current Mitigations Observed:**
- Params are shallow-copied via spread (collector.js:18).
- Params cross the isolate boundary via JSON serialization, which creates a deep copy.

**Residual Risk:** Very low. The JSON serialization in the bridge layer (index.js:414-419) means objects are deep-copied when crossing the boundary. The shallow copy in the collector is a defense-in-depth measure.

**Recommendation:** No action needed — the JSON boundary serialization provides effective deep-copy isolation.

---

### MEDIUM — Information Leakage

#### RISK-15: Error Message Verbosity

**Threat:** Error messages returned to contract callers or logged may reveal internal VM implementation details.

**Current Mitigations Observed:**
- Error classification in `_classifyError` (index.js:510-546) produces structured error strings.
- Contract reverts only include the user-supplied reason.
- Gas errors include used/ceiling values (expected, needed for accounting).
- Generic errors include the raw error message (index.js:545).

**Residual Risk:** Medium. The generic error path (`'error: ' + msg`) passes through the raw V8 error message, which could include:
- Stack traces with internal file paths.
- V8 internal error details.
- Host-side function names visible in stack frames.

**Recommendation:**
- Sanitize generic error messages: strip stack traces and file paths.
- Return only the first line of the error message for generic errors.
- Log full error details server-side at DEBUG level, but return sanitized messages to callers.

#### RISK-16: Log Message Information Leakage

**Threat:** Contract logs (via `xchain.log()`) are preserved even on failure and returned to callers. A contract could use logging to probe the VM environment.

**Current Mitigations Observed:**
- Logs are capped at 100 entries, 1KB each (collector.js:22-28).
- Log content is converted via `String()` coercion (gateway.js:121).

**Residual Risk:** Low. Logs are useful for debugging and the contract can only log its own data. No host information is accessible via the logging API.

**Recommendation:** No action needed.

---

### MEDIUM — Dependency Security

#### RISK-17: `isolated-vm` Native Module Vulnerabilities

**Threat:** `isolated-vm` is a native C++ module wrapping V8. Bugs in `isolated-vm` or V8 itself could allow sandbox escape.

**Current Version:** `isolated-vm` v5.0.4

**Residual Risk:** Medium. This is the most critical dependency — it IS the sandbox. Any vulnerability in `isolated-vm` directly compromises VM security.

**Recommendation:**
- Subscribe to `isolated-vm` security advisories and GitHub releases.
- Pin to specific versions and audit changelogs before upgrading.
- Run `npm audit` regularly.
- Consider whether `isolated-vm` is the best sandbox option for a consensus-critical system, or whether alternatives (e.g., WebAssembly, custom V8 embedder) would provide stronger guarantees.
- Monitor CVE databases for V8 vulnerabilities that could affect isolate boundaries.

#### RISK-18: `mathjs` Precision and DoS

**Threat:** `mathjs` bignumber handles arbitrary-precision arithmetic. Extreme inputs could consume excessive memory or CPU.

**Current Version:** `mathjs` v13.2.3

**Residual Risk:** Low-medium. `mathjs` is mature and widely used. However, no input size limits are enforced before calling `bignumber()`.

**Recommendation:**
- Test with inputs like `bignumber('1e' + '9'.repeat(1000))` and `bignumber('0.' + '0'.repeat(100000) + '1')`.
- Add max-length checks on math API inputs (e.g., reject strings longer than 256 characters).

#### RISK-19: `acorn` / `astring` Parsing and Generation

**Threat:** Pathological source code could exploit bugs in acorn parsing or astring code generation, producing incorrect metered output.

**Residual Risk:** Low. Both are mature, well-tested packages. The generated code is functionally equivalent to the input with `__gas(1)` calls inserted.

**Recommendation:**
- Verify that astring output is semantically identical to acorn input for edge cases (e.g., Unicode identifiers, template literals with complex expressions, optional chaining).
- Fuzz the acorn → metering → astring pipeline with random valid JavaScript.

---

## 4. Detailed Attack Vectors

### 4.1 Sandbox Escape Vectors to Test

| # | Vector | Expected Result | Priority |
|---|--------|-----------------|----------|
| 1 | `({}).__proto__.constructor('return process')()` | Throw or undefined | Critical |
| 2 | `[].constructor.constructor('return process')()` | Throw or undefined | Critical |
| 3 | `''.constructor.constructor('return process')()` | Throw or undefined | Critical |
| 4 | `(async function(){}).constructor('return process')()` | Throw or undefined | Critical |
| 5 | `(function*(){}).constructor('return process')()` | Throw or undefined | Critical |
| 6 | `(async function*(){}).constructor('return process')()` | Throw or undefined | Critical |
| 7 | `Reflect.construct(Object, [])` | Should work (no escape) | Medium |
| 8 | `Object.getOwnPropertyDescriptor(Object.prototype, 'constructor')` | Should return undefined descriptor | Medium |
| 9 | `RegExp.$_` / `RegExp.input` | Should not leak host data | Low |
| 10 | `Error().stack` | May reveal file paths | Medium |
| 11 | `new Error().stack` | May reveal file paths | Medium |
| 12 | `Symbol.for('nodejs.util.inspect.custom')` | Should not provide host access | Low |

### 4.2 Gas Metering Bypass Vectors

| # | Vector | Expected Result | Priority |
|---|--------|-----------------|----------|
| 1 | `globalThis.__gas = () => {}` then infinite loop | Should halt (gas or timeout) | Critical |
| 2 | `delete globalThis.__gas` then computation | Should throw on first `__gas()` call | Critical |
| 3 | `/^(a+)+$/.test('a'.repeat(30) + 'b')` (ReDoS) | Should timeout | High |
| 4 | Getter trap: `Object.defineProperty(obj, 'x', { get(){ /* expensive */ } })` | Unmetered CPU | High |
| 5 | Deep property chain: `a.b.c.d....` (1000 levels) | Unmetered CPU | Medium |
| 6 | `'x'.repeat(1e8)` | Should hit memory limit | Medium |
| 7 | Massive array spread: `[...[...[...[...arr]]]]` | Should hit memory limit | Medium |

### 4.3 Error Spoofing Vectors

| # | Vector | Expected Result | Priority |
|---|--------|-----------------|----------|
| 1 | `throw new Error('\x03REVERT:fake')` | Should classify as generic error (execContext.reverted === false) | High |
| 2 | `try{xchain.revert('real')}catch(e){} throw new Error('\x03REVERT:fake')` | Verify: does execContext.reverted stay true? | High |
| 3 | `throw new Error('\x03GAS:999999:1000000')` | Should classify as generic error (gas not actually exhausted) | High |
| 4 | Return value: `return '\x02' + '{"spoofed":true}'` | Verify: does double-encoding prevent return value spoofing? | Medium |

---

## 5. Mitigation Recommendations Summary

### Immediate (Pre-Launch)

| # | Mitigation | Addresses |
|---|-----------|-----------|
| M-01 | Neuter ALL function-type constructors: `Function`, `GeneratorFunction`, `AsyncFunction`, `AsyncGeneratorFunction` | RISK-01, RISK-02 |
| M-02 | Make `__gas` non-writable, non-configurable on `globalThis` | RISK-06 |
| M-03 | Remove `Reflect` from the sandbox | RISK-03 |
| M-04 | Freeze `Object.prototype` or at minimum neuter `Object.prototype.constructor` | RISK-01 |
| M-05 | Use `Object.create(null)` for state store and emission params | RISK-10, RISK-11 |
| M-06 | Reset `execContext.reverted` on every gateway call entry | RISK-04 |
| M-07 | Remove or meter `RegExp` to prevent ReDoS | RISK-05 |
| M-08 | Sanitize generic error messages (strip stack traces, paths) | RISK-15 |

### Short-Term (Post-Launch Hardening)

| # | Mitigation | Addresses |
|---|-----------|-----------|
| M-09 | Add MemberExpression gas injection for deep property chains | RISK-05 |
| M-10 | Freeze `Object.defineProperty` inside the sandbox to prevent getter/setter traps | RISK-05 |
| M-11 | Add input length limits on math API inputs | RISK-12, RISK-18 |
| M-12 | Add AST node count limit during metering | RISK-09 |
| M-13 | Implement strict field allowlists per emit action type | RISK-10 |
| M-14 | Add concurrent isolate limit | RISK-08 |

### Long-Term (Architecture)

| # | Mitigation | Addresses |
|---|-----------|-----------|
| M-15 | Investigate deterministic CPU metering (V8 instruction counter) to replace wall-clock timeout | RISK-07 |
| M-16 | Evaluate alternative sandbox technologies (Wasm, custom V8 embedder) for stronger isolation guarantees | RISK-17 |
| M-17 | Implement formal verification of gas metering coverage (prove all computational paths are metered) | RISK-05 |

---

## 6. Audit Checklist

### Pre-Audit Preparation
- [ ] Set up isolated test environment with `isolated-vm` compiled
- [ ] Review all existing test suites (81+ unit, 9 E2E, 10+ fuzz tests)
- [ ] Document current test coverage gaps

### Sandbox Integrity
- [ ] Test all 12 sandbox escape vectors (Section 4.1)
- [ ] Verify all function-type constructors are neutered
- [ ] Verify `Object.prototype` chain cannot reach usable constructors
- [ ] Verify `Reflect` and `Symbol` cannot be used for privilege escalation
- [ ] Verify `Error.stack` does not leak host file paths
- [ ] Verify harness cleanup removes all `__*` globals except `__gas`
- [ ] Verify `__Function` cannot be observed by contract code

### Gas Metering
- [ ] Test all 7 gas metering bypass vectors (Section 4.2)
- [ ] Verify `__gas` cannot be overwritten by contract code
- [ ] Measure gas cost of property access chains (1000 levels)
- [ ] Measure gas cost of getter/setter traps
- [ ] Test ReDoS patterns and verify timeout fires
- [ ] Verify acorn handles all ES2020 syntax correctly for metering

### Error Handling
- [ ] Test all 4 error spoofing vectors (Section 4.3)
- [ ] Verify `execContext.reverted` cannot be manipulated by contracts
- [ ] Verify error messages do not leak internal details
- [ ] Verify return value `\x02` prefix cannot be spoofed

### Input Validation
- [ ] Test emit params with prototype pollution keys (`__proto__`, `constructor`)
- [ ] Test state keys with reserved names (`__proto__`, `hasOwnProperty`)
- [ ] Test math inputs with extreme values
- [ ] Test code at exactly 65536 bytes
- [ ] Test state values at exactly size limits

### Determinism
- [ ] Verify identical results across 10 consecutive runs for all test contracts
- [ ] Verify no observable non-deterministic globals survive sandbox stripping
- [ ] Verify math operations produce identical results across Node.js versions

---

## 7. Risk Heat Map

```
                        Low Impact    Medium Impact    High Impact    Critical Impact
                       ┌─────────────┬────────────────┬──────────────┬────────────────┐
Highly Likely          │             │                │ RISK-05      │                │
                       │             │                │ (gas gaps)   │                │
                       ├─────────────┼────────────────┼──────────────┼────────────────┤
Likely                 │             │ RISK-15        │ RISK-10      │ RISK-06        │
                       │             │ (info leak)    │ RISK-11      │ (gas override) │
                       │             │                │ (validation) │ RISK-04        │
                       │             │                │              │ (err spoof)    │
                       ├─────────────┼────────────────┼──────────────┼────────────────┤
Possible               │ RISK-16     │ RISK-09        │ RISK-07      │ RISK-01        │
                       │ (log leak)  │ RISK-12        │ (timeout)    │ RISK-02        │
                       │             │ RISK-18        │ RISK-08      │ (sandbox esc.) │
                       ├─────────────┼────────────────┼──────────────┼────────────────┤
Unlikely               │             │ RISK-19        │ RISK-13      │ RISK-17        │
                       │             │ (acorn bugs)   │ (state leak) │ (ivm CVE)      │
                       │             │ RISK-03        │ RISK-14      │                │
                       │             │ (Reflect)      │              │                │
                       └─────────────┴────────────────┴──────────────┴────────────────┘
```

---

## 8. Conclusion

The XChain VM demonstrates a well-engineered security architecture with multiple layers of defense:

1. **Strong sandbox** via `isolated-vm` V8 isolates with comprehensive API stripping.
2. **Anti-spoofing** via two-factor error verification (`\x03` prefix + context/tracker state).
3. **Atomic rollback** on all error paths.
4. **Comprehensive resource limits** across gas, memory, time, state, and emissions.
5. **Extensive test coverage** including sandbox escape, resource exhaustion, and fuzz tests.

However, several areas require attention before production deployment:

- **Critical:** Prototype chain traversal to function constructors (RISK-01, RISK-02) — if `Object.constructor` still resolves to `Function`, the sandbox can be escaped.  
- **Critical:** Gas metering gaps for unmetered operations (RISK-05) — property access, getters, RegExp backtracking.  
- **Critical:** `__gas` callback overwritability (RISK-06) — contracts may be able to neuter metering.  
- **High:** Error spoofing via caught reverts (RISK-04) — `execContext.reverted` flag manipulation.  
- **High:** Input validation gaps in emit parameters and state keys (RISK-10, RISK-11).

The recommended audit sequence is: **sandbox escape testing → gas metering verification → error spoofing testing → input validation review → determinism verification → dependency audit**.
