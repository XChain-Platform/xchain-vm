# XChain VM - Fuzz Testing Plan

## 1. Objective

Systematically discover crashes, unhandled exceptions, sandbox escapes, resource exhaustion bypasses, incorrect state mutations, and determinism violations in the XChain VM by feeding it adversarial, malformed, and boundary-pushing contract code, arguments, and platform action payloads.

The VM is the most security-critical component in the XChain Platform. A flaw here could allow ledger manipulation, consensus divergence (non-determinism), denial-of-service (resource exhaustion bypass), or host-process compromise (sandbox escape). Fuzz testing targets the gaps that hand-written unit and boundary tests cannot cover.

---

## 2. Target Input Points & Attack Surface

### 2.1 Contract Source Code (`opts.code`)

The code string flows through multiple subsystems, each with distinct failure modes:

| Stage | Module | What can go wrong |
|-------|--------|-------------------|
| Size check | `index.js:255` | Off-by-one in byte-length check; multi-byte UTF-8 edge cases |
| Syntax validation | `syntax.js` → `acorn.parse()` | Parser differential between V8 and acorn (ES2020 cap); crafted code that passes V8 but crashes acorn or vice versa |
| AST metering | `metering.js` → `acorn` + `acorn-walk` | Malformed AST nodes that survive parsing but crash the walker; deeply nested structures that blow the call stack; code that circumvents gas injection (unmetered execution paths) |
| Source regeneration | `metering.js` → `astring.generate()` | Regenerated code that is semantically different from the original (e.g., directive prologues, template literals, optional chaining) |
| Compilation | `isolate.js` → `ivm.compileScriptSync()` | Native crash in V8 on pathological input |
| Execution | `index.js` → `script.runSync()` | Unmetered infinite loops, stack overflow, prototype pollution |

**Key risk**: The metering pipeline (acorn parse → AST walk → astring regenerate) is the most complex transformation. If any code construct survives parsing but doesn't get a `__gas()` call injected, the contract can loop forever without triggering gas exhaustion.

### 2.2 Contract Function Arguments (`opts.params`)

Params are an array of strings passed through `getInputParam(i)` / `getInputParams()`. They cross the isolate boundary via JSON serialization in the `wrap()` harness function (`index.js:39-48`).

| Input vector | Risk |
|---|---|
| Non-string array elements | Type confusion in contracts; unexpected `JSON.stringify` / `JSON.parse` round-trip behavior |
| Strings containing `\x01` or `\x02` control prefixes | Collision with the harness protocol markers - could trick `wrap()` into JSON-parsing a user-supplied string |
| Extremely large param arrays | Memory pressure before gas metering kicks in |
| Params with `__proto__`, `constructor`, `prototype` keys | Prototype pollution if params are spread into objects |

### 2.3 Platform Action Emission (`xchain.emit.*`)

Each of the 16 emit methods (`gateway-emit.js`) validates required fields then queues the action. The `ActionValidator` (`validator.js`) performs a final check before returning results.

| Input vector | Risk |
|---|---|
| Missing required fields | Already validated - but fuzzing can find fields that *should* be required but aren't (e.g., `dispenser`, `file`, `list`, `broadcast` accept anything) |
| Extra unexpected fields | Param spreading (`{ ...params }` in `collector.js:19`) copies all properties - could inject `action` or `__proto__` keys |
| Non-object params | `typeof params !== 'object'` check passes for arrays - arrays are objects |
| Params with circular references | `JSON.stringify` would throw in the harness `wrap()` function |
| Extremely large param objects | Memory exhaustion before emission cap is hit |

### 2.4 State Operations (`xchain.state.*`)

State operations go through `StateManager` (`state.js`) with limits enforcement.

| Input vector | Risk |
|---|---|
| Keys that are not strings | `Buffer.byteLength(key, 'utf8')` would throw on non-string keys |
| Values that fail `JSON.stringify` (functions, symbols, circular refs) | Could bypass the serialization check or crash the state manager |
| Keys named `__proto__`, `constructor`, `hasOwnProperty` | Prototype pollution in the `this.state` plain object |
| Rapid set/delete cycles on the same key | `keyCount` tracking may drift, allowing the key cap to be bypassed |
| Values that are exactly `null` after JSON round-trip | `NaN` → `JSON.stringify` → `"null"` → `JSON.parse` → `null` - the NaN check at `state.js:48` should block this, but fuzzing can verify |

### 2.5 Math Operations (`xchain.math.*`)

All 15 math methods wrap `mathjs` bignumber with string I/O.

| Input vector | Risk |
|---|---|
| Non-string arguments | `mathjs.bignumber()` behavior with numbers, booleans, objects |
| Strings that aren't valid numbers | `'NaN'`, `'Infinity'`, `''`, `'0x1'`, scientific notation |
| Extremely large number strings | Memory/CPU exhaustion in mathjs bignumber |
| Division by zero, mod by zero | Should throw but must not crash the host |

### 2.6 VM Environment / Block Context (`opts.blockContext`)

| Input vector | Risk |
|---|---|
| Missing or null `blockContext` fields | `gateway.js:29-31` accesses `.height`, `.timestamp`, `.hash` directly - null deref |
| Non-numeric height/timestamp | Type confusion in contracts; determinism violations |
| Extremely large height values | Overflow in arithmetic |

### 2.7 Serialization Boundary (Isolate ↔ Host)

The harness uses `\x01` and `\x02` as protocol markers for return value and gateway response serialization.

| Input vector | Risk |
|---|---|
| Contract returning strings starting with `\x02` | Misinterpreted as JSON-serialized return value (`index.js:353`) |
| Gateway functions returning strings starting with `\x01` | Already handled by always prepending `\x01` in `bridge()` - but fuzzing should verify edge cases |
| `JSON.parse` failures on malformed strings | Unhandled exception crossing the boundary |

---

## 3. Fuzzing Strategies

### 3.1 Code Fuzzing (AST Mutation)

**Strategy**: Start from valid contract fixtures (`test/contracts/`), parse them with acorn, then apply random AST mutations before regenerating source.

**Mutations**:
- **Node deletion**: Remove random statements from block bodies
- **Node duplication**: Duplicate loop bodies, function declarations
- **Type swapping**: Replace `ForStatement` with `WhileStatement`, `IfStatement` with `SwitchStatement`
- **Expression injection**: Insert random expressions (member access chains, template literals, optional chaining, nullish coalescing)
- **Identifier mangling**: Rename identifiers to reserved names (`__gas`, `__proto__`, `constructor`, `xchain`, `globalThis`)
- **Literal fuzzing**: Replace literals with boundary values (`Number.MAX_SAFE_INTEGER`, `''`, `null`, `undefined`, very long strings)
- **Nesting amplification**: Deeply nest binary expressions (>100 levels), ternaries, function calls
- **Control flow bombs**: Generate `for(;;){}`, recursive calls, `try/catch` chains thousands of levels deep

**Generation-based fuzzing** (no seed code):
- Randomly generate syntactically valid JavaScript from a grammar (using acorn's token types as building blocks)
- Bias toward constructs the metering engine must handle: loops, conditionals, function declarations/expressions, arrow functions, try/catch

### 3.2 Argument Fuzzing (Property-Based)

**Strategy**: Use property-based testing to generate random `params` arrays.

**Generators**:
- Random strings (ASCII, UTF-8, binary, null bytes, control characters)
- Random JSON values (nested objects, arrays, numbers, booleans, null)
- Protocol marker strings (`\x01...`, `\x02...`, `\x03REVERT:...`, `\x03GAS:...`)
- Boundary numbers as strings (`"0"`, `"-1"`, `"99999999999999999999999999"`)
- Empty arrays, single-element arrays, arrays with 10,000+ elements
- Prototype pollution payloads (`{"__proto__": {"polluted": true}}`)

### 3.3 Emission Fuzzing (Structure-Based)

**Strategy**: For each of the 16 emit methods, generate fuzzed param objects.

**Per-method approach**:
1. Start from the known required fields for each action type
2. Randomly omit required fields, add extra fields, corrupt field values
3. Generate params that are: arrays, strings, numbers, `null`, deeply nested objects
4. Inject special property names: `action`, `__proto__`, `constructor`, `toString`, `valueOf`

### 3.4 Resource Exhaustion Fuzzing

**Strategy**: Generate contracts specifically designed to exhaust resources, targeting the gaps between gas metering and actual resource consumption.

**Vectors**:
- **CPU without gas**: Code patterns that might evade metering (expression-heavy code with no control flow points, getter/setter chains, `Symbol.toPrimitive` overrides)
- **Memory without gas**: String concatenation in expressions (not statements), array spreading, `Array(2**30)`
- **Stack depth**: Deep recursion, mutual recursion between object methods
- **State flooding**: Rapid state writes at the key/value size boundary
- **Emission flooding**: Emit 50 actions each with maximum-size params
- **Log flooding**: 100 log entries each at 1024 bytes
- **Compilation bombs**: Code that is small in source but expensive to parse/compile (deeply nested expressions, regex literals)

### 3.5 Sandbox Escape Fuzzing

**Strategy**: Generate code that attempts to reach host-side objects through indirect means.

**Vectors**:
- Prototype chain walking: `({}).__proto__.__proto__.constructor.constructor('return process')()`
- `arguments.callee.caller` chains
- `Error().stack` parsing for host information leakage
- `Symbol.hasInstance`, `Symbol.toPrimitive`, `Symbol.species` overrides
- `Object.getOwnPropertyNames(globalThis)` enumeration after sandbox stripping
- `Reflect` API (if not stripped) to inspect the gateway object
- Overriding `JSON.stringify` / `JSON.parse` to intercept boundary serialization
- Getter/setter traps on objects passed to gateway methods
- `toString` / `valueOf` overrides on objects passed as state values or emit params

### 3.6 Determinism Fuzzing

**Strategy**: Execute the same fuzzed contract twice with identical inputs and assert byte-identical results.

This catches non-determinism introduced by:
- Unstripped APIs that leaked through (e.g., `Date`, `Math.random`)
- Object key ordering differences
- Map/Set iteration order
- `WeakRef` / `FinalizationRegistry` if not fully stripped

---

## 4. Failure Detection

### 4.1 Crash Detection

| Signal | Detection method |
|--------|-----------------|
| Node.js process crash (segfault in `isolated-vm`) | Process-level monitoring; run fuzzer as child process, detect non-zero exit |
| Unhandled exception in host | Wrap `vm.execute()` in try/catch at the fuzzer level; any exception that isn't a clean `{ success, error }` result is a bug |
| V8 isolate crash | `isolated-vm` throws; `_classifyError` should catch - if it doesn't, that's a bug |
| Infinite hang (bypass of wall-clock timeout) | Fuzzer-level timeout (e.g., 60s) wrapping each `vm.execute()` call |

### 4.2 Security Violation Detection

| Violation | Detection |
|-----------|-----------|
| Sandbox escape | Instrument the host environment: set sentinel values on `process.env`, `global`, `require` - if any contract can read them, flag immediately |
| Prototype pollution | Before/after each execution, snapshot `Object.prototype`, `Array.prototype`, `Function.prototype` - any new properties indicate pollution |
| Error type spoofing | The `_classifyError` method already guards against `\x03` prefix spoofing by checking `execContext.reverted` and `gasTracker.used > gasTracker.ceiling` - fuzzing should verify contracts cannot produce false `revert` or `out_of_gas` classifications |

### 4.3 Incorrect State Detection

| Invariant | Assertion |
|-----------|-----------|
| Atomicity on error | If `result.success === false`, then `result.stateChanges`, `result.stateDeletes`, and `result.emittedActions` must all be empty arrays |
| State key count integrity | After execution, count live keys (initial - deleted + added) - must match `StateManager.keyCount` |
| State value round-trip | All values in `result.stateChanges` must survive `JSON.parse(JSON.stringify(value))` unchanged |
| Emission validity | Every action in `result.emittedActions` must have `action` in the 16 allowed types and `params` as a non-null object |

### 4.4 Resource Exhaustion Detection

| Limit | Detection |
|-------|-----------|
| Gas ceiling bypass | If `result.gasUsed > gasCeiling` without an `out_of_gas` error, flag |
| Memory limit bypass | Monitor isolate heap usage via `isolate.getHeapStatisticsSync()` if available; also monitor Node.js process RSS |
| Wall-clock timeout bypass | Fuzzer-level timeout as backup (must be > `maxCpuTimeMs`) |
| Emission cap bypass | If `result.emittedActions.length > maxEmissions`, flag |
| State key cap bypass | If total live state keys after execution exceeds `maxStateKeys`, flag |
| State value size bypass | If any value in `stateChanges` exceeds `maxStateValueSize` bytes when serialized, flag |

### 4.5 Determinism Violation Detection

- Execute every fuzzed input twice with identical parameters
- Compare results byte-for-byte: `JSON.stringify(result1) === JSON.stringify(result2)`
- Any difference is a critical bug (consensus risk)

---

## 5. Tooling Recommendations

### 5.1 Primary: Custom Script-Based Fuzzer

Given the VM's unique architecture (AST-metered JavaScript in V8 isolates), off-the-shelf fuzzers won't understand the input format well enough. The recommended approach is a **custom fuzzing harness** built on:

| Library | Purpose |
|---------|---------|
| `fast-check` | Property-based testing framework for Node.js. Excellent arbitrary generators for strings, objects, arrays, numbers. Automatic shrinking finds minimal failing inputs. |
| `acorn` + `astring` | Already dependencies - use them for AST-level code mutation and regeneration |
| `acorn-walk` | Already a dependency - use for targeted AST node selection for mutation |

### 5.2 Secondary: Coverage-Guided Fuzzing

| Tool | Use case |
|------|----------|
| `jsfuzz` | Coverage-guided fuzzer for JavaScript. Instruments code for branch coverage and evolves inputs toward new coverage. Best for finding crashes in the metering pipeline and parser edge cases. |
| `istanbul` / `c8` | Code coverage instrumentation. Run alongside the fuzzer to measure which branches in `metering.js`, `sandbox.js`, `state.js`, `gas.js` have never been reached. |

### 5.3 Supporting Tools

| Tool | Purpose |
|------|---------|
| `esfuzz` | Random JavaScript program generator. Can produce syntactically valid programs for code fuzzing seeds. |
| `crosshatch` | Grammar-based fuzzer - define a JavaScript subset grammar and generate programs from it. |
| `clinic.js` / `0x` | Profiling tools to detect CPU/memory anomalies during fuzz runs. |

### 5.4 Test Harness Architecture

```
┌─────────────────────────────────────────────────┐
│                  Fuzz Runner                     │
│  (orchestrates iterations, manages corpus)       │
├─────────────────────────────────────────────────┤
│  Input Generator                                 │
│  ├── Code Mutator (AST-based)                   │
│  ├── Argument Generator (fast-check arbitraries) │
│  ├── Emission Payload Generator                  │
│  └── Environment Generator                       │
├─────────────────────────────────────────────────┤
│  Execution Wrapper                               │
│  ├── vm.execute() with timeout guard             │
│  ├── Dual execution for determinism check        │
│  └── Host environment sentinels                  │
├─────────────────────────────────────────────────┤
│  Failure Detectors                               │
│  ├── Crash detector (process-level)              │
│  ├── Invariant checker (atomicity, limits, etc.) │
│  ├── Security sentinel checker                   │
│  ├── Determinism comparator                      │
│  └── Coverage tracker                            │
├─────────────────────────────────────────────────┤
│  Reporter                                        │
│  ├── Failing input corpus (saved to disk)        │
│  ├── Minimal reproducer (via fast-check shrink)  │
│  └── Summary report (counts by failure category) │
└─────────────────────────────────────────────────┘
```

The harness instantiates `XChainVM` with a known gas schedule and runs each fuzzed input through `vm.execute()`, checking all invariants after each run. The runner operates in a child process with a hard kill timeout to survive native crashes.

---

## 6. Prioritization

### Tier 1 - Critical (implement first)

These areas have the highest blast radius if a bug is found:

1. **Metering bypass fuzzing** - Can a contract execute unbounded computation?
   - Target: `metering.js` AST injection completeness
   - Method: Generate code with unusual control flow constructs and verify every execution terminates within the gas ceiling
   - Why first: A metering bypass is a consensus-level DoS vulnerability - any node running this contract would hang

2. **Sandbox escape fuzzing** - Can a contract access the host process?
   - Target: `sandbox.js` global stripping, isolate boundary
   - Method: Generate code that walks prototype chains, overrides builtins, probes for leaked references
   - Why first: A sandbox escape could compromise every node running the indexer

3. **Serialization boundary fuzzing** - Can a contract confuse the `\x01`/`\x02`/`\x03` protocol markers?
   - Target: `index.js` harness `wrap()` function, `bridge()` function, `_classifyError()`
   - Method: Generate contracts that return or throw strings with control prefixes
   - Why first: Error type spoofing could cause incorrect gas accounting or hide reverts

### Tier 2 - High (implement second)

4. **State manager fuzzing** - Can a contract corrupt state or bypass limits?
   - Target: `state.js` key/value validation, `keyCount` tracking
   - Method: Property-based testing with `fast-check` on state CRUD sequences
   
5. **Emission validation fuzzing** - Can a contract emit invalid actions that survive validation?
   - Target: `gateway-emit.js`, `validator.js`, `collector.js`
   - Method: Generate all combinations of valid/invalid params for each of 16 action types

6. **Math operation fuzzing** - Can malformed inputs crash or produce non-deterministic results?
   - Target: `math.js` wrapping of `mathjs`
   - Method: Random string inputs, boundary values, non-string types

### Tier 3 - Medium (implement third)

7. **Compilation bomb fuzzing** - Can a small contract cause excessive compilation time/memory?
   - Target: `isolate.js`, `metering.js` (acorn parse + astring generate)
   - Method: Generate small-source-but-complex-AST patterns

8. **Determinism fuzzing** - Does the VM produce identical results for identical inputs across runs?
   - Target: Full pipeline
   - Method: Execute every Tier 1/2 fuzz input twice and compare

9. **Block context and environment fuzzing** - Can malformed environment data crash the VM?
   - Target: `gateway.js` context accessors, `index.js` opts handling
   - Method: Generate opts objects with missing/null/wrong-type fields

---

## 7. Integration Strategy

### 7.1 Development Workflow

| Integration point | Approach |
|-------------------|----------|
| **Pre-commit** | Run a quick fuzz pass (1,000 iterations, ~30 seconds) on any changes to `src/` files. Focus on the changed module's fuzzing category. |
| **CI pipeline** | Run a medium fuzz pass (10,000 iterations, ~5 minutes) on every PR that touches `xchain-vm`. Gate merge on zero new failures. |
| **Nightly / scheduled** | Run an extended fuzz pass (100,000+ iterations, ~1 hour) across all categories. Email/alert on new failures. |
| **Release gate** | Full fuzz campaign (1M+ iterations, multi-hour) before any version bump. |

### 7.2 Corpus Management

- **Seed corpus**: Start from existing `test/contracts/` fixtures (13 contracts covering AMM swap, vesting, sandbox escape, resource exhaustion, etc.)
- **Growing corpus**: Save every input that reaches new code coverage. Store as JSON files in `test/fuzz-corpus/` (gitignored for size, backed up separately)
- **Regression corpus**: Every input that triggered a failure becomes a permanent regression test in `test/fuzz-regression/` (committed to git). These run as part of the normal `npm test` suite
- **Minimization**: Use `fast-check`'s built-in shrinking to reduce failing inputs to the smallest reproducing case before saving

### 7.3 Reporting

**Per-run output** (stdout / log file):
```
[FUZZ] 10000 iterations in 47.2s (211 iter/s)
[FUZZ] Coverage: 94.2% lines, 87.1% branches in src/
[FUZZ] Failures: 2 new, 0 regressions
  - CRASH metering.js: stack overflow on 847-deep nested ternary (input saved: fuzz-corpus/crash-001.json)
  - INVARIANT state.js: keyCount drift after 500 set/delete cycles (input saved: fuzz-corpus/invariant-001.json)
[FUZZ] Categories tested: code(4000) args(2000) emit(2000) state(1000) math(500) sandbox(500)
```

**Per-failure output** (saved as JSON):
```json
{
  "id": "crash-001",
  "category": "code_fuzzing",
  "failure_type": "crash",
  "module": "metering.js",
  "description": "stack overflow during AST walk on deeply nested ternary",
  "input": {
    "code": "module.exports = function(x) { return a ? b ? c ? ... }",
    "method": "default",
    "params": [],
    "blockContext": { "height": 1, "timestamp": 1700000000, "hash": "abc" }
  },
  "error": "RangeError: Maximum call stack size exceeded",
  "gasUsed": 0,
  "timestamp": "2026-04-03T12:00:00Z"
}
```

**Summary report** (generated after extended runs):
- Failure counts by category (crash, security, invariant, determinism, resource)
- Failure counts by module
- Coverage delta from previous run
- List of all unique failures with reproducer paths
- Recommendations for code fixes or additional hardening

---

## 8. Specific Hypotheses to Test

These are concrete scenarios the fuzzer should be designed to probe, derived from the source code analysis:

| # | Hypothesis | Target code | How to fuzz |
|---|-----------|-------------|-------------|
| H1 | A `ConditionalExpression` nested >1000 levels deep will overflow the acorn walker's stack during metering | `metering.js:181-187` | Generate deeply nested ternaries |
| H2 | A contract can define a `__gas` property on an object (not as an identifier) and interfere with metering | `metering.js:255-271` | Code like `var o = {__gas: function(){}}; o.__gas()` |
| H3 | `Object.getOwnPropertyNames(globalThis)` after sandbox stripping leaks internal references | `sandbox.js`, `index.js:142-147` | Enumerate globals and probe each one |
| H4 | A contract returning exactly `'\x02' + validJSON` will be misinterpreted | `index.js:353` | Contract: `module.exports = () => '\x02{"evil":true}'` |
| H5 | Passing an array as emit params passes the `typeof params !== 'object'` check | `gateway-emit.js:9` | `xchain.emit.send([1,2,3])` |
| H6 | Setting a state key named `hasOwnProperty` corrupts the `this.state` object | `state.js:28` | `xchain.state.set('hasOwnProperty', 'x')` |
| H7 | Rapid set/delete cycles on the same key cause `keyCount` to go negative | `state.js:60-66, 73-79` | 1000x `set('k','v')` then `delete('k')` alternating |
| H8 | `xchain.math.divide('1', '0')` crashes the host process | `math.js` | Division by zero with various representations of zero |
| H9 | A contract overriding `JSON.stringify` can intercept all gateway return values | harness `wrap()` function | `JSON.stringify = () => 'hacked'` before any gateway call |
| H10 | Getter traps on objects passed to `xchain.state.set()` execute unmetered code | `state.js:51` (`JSON.stringify(value)`) | `xchain.state.set('k', {get x() { while(true){} }})` - but this runs on the host side via the bridge, so the getter runs in the isolate before serialization |

---

## 9. Success Criteria

The fuzz testing campaign is considered successful when:

1. **Coverage threshold**: Fuzzing achieves ≥90% branch coverage across all `src/` modules
2. **Iteration threshold**: At least 1M total iterations across all categories with zero unresolved critical (crash/security) failures
3. **Regression suite**: All discovered failures have corresponding regression tests in `test/fuzz-regression/`
4. **Determinism guarantee**: 100,000 dual-execution runs with zero determinism violations
5. **No known bypass**: Every resource limit (gas, memory, timeout, emissions, state keys, value size, code size) has been fuzz-tested with at least 10,000 iterations targeting that specific limit

---

*Generated: 2026-04-03 | Component: xchain-vm | Type: Fuzz Testing Plan*
