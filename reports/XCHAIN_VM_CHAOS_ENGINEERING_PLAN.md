# XChain VM Chaos Engineering Plan

## 1. Objective

Proactively identify weaknesses in the `xchain-vm`'s resilience, fault tolerance, and recovery mechanisms by simulating common failure scenarios during contract execution. The VM is the most security-critical component in the XChain Platform -- failures here can cause incorrect state changes, security breaches, or denial of service. Chaos engineering complements the existing unit, boundary, security, fuzz, and e2e test suites by testing the VM's behavior under conditions that are difficult to reproduce with conventional testing: degraded dependencies, resource pressure, corrupted inputs at system boundaries, and partial failures in the execution pipeline.

---

## 2. Target Failure Points

### 2.1 Contract Execution Environment

| ID | Failure Point | Risk Level | Description |
|----|---------------|------------|-------------|
| CE-1 | Memory pressure near limit | Critical | Contracts that allocate memory just below the 8MB isolate limit, testing whether the VM correctly terminates execution vs. crashing the host process |
| CE-2 | CPU time budget exhaustion | Critical | Contracts that consume wall-clock time through legitimate but expensive operations (deep recursion, large string manipulation) rather than infinite loops |
| CE-3 | Concurrent isolate exhaustion | High | Multiple simultaneous `vm.execute()` calls competing for host process memory and CPU |
| CE-4 | Compilation cache pressure | Medium | Filling the 1,000-entry block cache with unique contracts, then executing additional contracts to verify eviction/rejection behavior |
| CE-5 | V8 isolate creation failure | High | Simulating `isolated-vm` failing to allocate a new isolate (e.g., host under memory pressure) |

### 2.2 Platform Action Gateway

| ID | Failure Point | Risk Level | Description |
|----|---------------|------------|-------------|
| GW-1 | Gateway callback throws | Critical | Host-side `ivm.Reference` callbacks throwing unexpected errors during contract execution |
| GW-2 | Gateway callback hangs | Critical | Host-side callbacks that never resolve (deadlock simulation), testing whether wall-clock timeout still terminates execution |
| GW-3 | Gateway returns corrupted data | High | State reads, oracle queries, or balance lookups returning malformed/unexpected data types |
| GW-4 | Emission validation failure mid-batch | High | First N emissions succeed, then a gateway-side validation error occurs -- verify atomicity (all emissions discarded) |
| GW-5 | Gateway callback latency spike | Medium | Introducing artificial delays (100ms-5s) in state/oracle callbacks to test timeout interaction |

### 2.3 Sandbox Integrity Under Stress

| ID | Failure Point | Risk Level | Description |
|----|---------------|------------|-------------|
| SB-1 | Sandbox setup partial failure | Critical | `stripGlobals()` failing partway through (e.g., a prototype property already frozen by a prior operation), leaving some dangerous APIs accessible |
| SB-2 | Prototype chain pollution under load | Critical | Rapid sequential executions attempting to leak state between isolates through shared native prototype modifications |
| SB-3 | `__gas` callback tampering under race | High | Contracts attempting to redefine `__gas` during the window between harness injection and `Object.defineProperty` lockdown |
| SB-4 | Isolate disposal failure | High | `isolate.dispose()` throwing (e.g., isolate still running), testing whether resources are leaked |

### 2.4 Input Data Corruption

| ID | Failure Point | Risk Level | Description |
|----|---------------|------------|-------------|
| IN-1 | Malformed `execute()` options | Critical | Missing required fields (`code`, `state`, `method`, `blockContext`), wrong types, or excessively large values in the indexer-to-VM interface |
| IN-2 | State object corruption | High | Initial state containing circular references, non-serializable values, prototype pollution payloads, or keys/values exceeding size limits |
| IN-3 | Block context inconsistency | High | Block height/timestamp/hash that are null, negative, non-numeric, or inconsistent (e.g., timestamp decreasing between calls) |
| IN-4 | Contract code mutation | Critical | Code that is valid JavaScript but contains encoding anomalies: BOM markers, null bytes, Unicode RTL override characters, or extreme nesting depth |

### 2.5 Runtime & Dependency Failures

| ID | Failure Point | Risk Level | Description |
|----|---------------|------------|-------------|
| RT-1 | `isolated-vm` native crash | Critical | Triggering edge cases in the C++ isolated-vm module (e.g., V8 internal errors) that could crash the host Node.js process |
| RT-2 | `mathjs` precision anomaly | High | Inputs to `mathjs` bignumber that trigger unexpected behavior: extremely large numbers (10^1000), numbers with 256-char decimal expansions, edge values like `-0`, `NaN` strings |
| RT-3 | `acorn` parser edge cases | Medium | Valid JavaScript that acorn parses differently than V8, causing metering injection to produce incorrect code |
| RT-4 | Host process memory leak | High | Repeated execute-dispose cycles without block boundaries, checking for monotonic memory growth in the host process |

### 2.6 Multi-Execution & Sequencing Failures

| ID | Failure Point | Risk Level | Description |
|----|---------------|------------|-------------|
| MX-1 | Block boundary violations | High | Calling `vm.execute()` without `beginBlock()`/`endBlock()`, or calling `endBlock()` during execution |
| MX-2 | Interleaved execution results | Critical | If two contracts execute concurrently for the same block, verify that state changes, emissions, and gas tracking are fully isolated |
| MX-3 | Execution after disposal | High | Calling `vm.execute()` on a VM instance that has been partially cleaned up |
| MX-4 | Rapid block transitions | Medium | Rapid `beginBlock()`/`endBlock()` cycling (thousands per second) to stress compilation cache management |

---

## 3. Experiment Designs

### Experiment 1: Memory Cliff (CE-1)

**Hypothesis:** The VM will terminate contract execution with an OOM error and remain stable for subsequent executions when a contract approaches the memory limit.

**Fault Injection:**
- Deploy a contract that incrementally allocates arrays of increasing size (1KB, 10KB, 100KB, 1MB, 4MB, 7MB, 8MB+)
- Execute the contract with the default 8MB memory limit
- Immediately after, execute a simple `state_counter.js` contract to verify VM stability

**Observation:**
- Monitor host process RSS memory before, during, and after execution
- Record the exact allocation size at which the isolate terminates
- Check that `isolate.dispose()` completes without error
- Verify the subsequent simple execution succeeds with correct results

**Expected Outcome:**
- Contract execution terminates with an OOM-classified error
- All state changes from the failed execution are discarded (atomicity)
- Host process memory returns to baseline after disposal
- Subsequent executions succeed normally
- No unhandled exceptions propagate to the host process

**Duration:** Single execution per allocation tier, ~10 total executions

---

### Experiment 2: Gateway Callback Hang (GW-2)

**Hypothesis:** When a gateway callback hangs indefinitely, the wall-clock timeout (`maxCpuTimeMs: 30000`) will still terminate execution, and the VM will recover cleanly.

**Fault Injection:**
- Provide a mock state provider where `state.get()` blocks indefinitely (never resolves the callback)
- Execute a contract that calls `xchain.state.get('key')` early in its execution
- Set `maxCpuTimeMs` to 2000ms (shortened for test efficiency)

**Observation:**
- Wall-clock time from `execute()` call to resolution
- Error classification in the result object
- Whether the isolate is properly disposed despite the hanging callback
- Host process stability (no dangling promises or leaked isolate references)
- Subsequent execution succeeds within normal time bounds

**Expected Outcome:**
- Execution terminates at or near the 2000ms timeout
- Result contains a timeout-classified error
- All state changes and emissions are discarded
- No resource leaks (memory, isolate handles, pending callbacks)

---

### Experiment 3: Gateway Error Mid-Emission (GW-4)

**Hypothesis:** If the gateway throws an error during emission N (where N > 1), all prior emissions and state changes are atomically discarded.

**Fault Injection:**
- Provide a mock emission collector that throws an error on the 3rd emission call
- Execute a contract that performs 2 state writes and 5 sequential `xchain.emit.send()` calls
- The first 2 state writes and first 2 emissions should succeed; the 3rd emission triggers the fault

**Observation:**
- `result.success` should be `false`
- `result.stateChanges` should be empty (not just the first 2 writes)
- `result.emittedActions` should be empty (not the first 2 emissions)
- `result.logs` should be preserved for debugging
- Error type should be identifiable (not a generic "unknown error")

**Expected Outcome:**
- Full atomicity: zero state changes, zero emissions returned
- Logs preserved up to the failure point
- Gas usage reflects actual consumption (charges for the 2 successful emissions + the failed one)
- VM remains operational for subsequent executions

---

### Experiment 4: Sandbox Setup Partial Failure (SB-1)

**Hypothesis:** If `stripGlobals()` encounters an error midway through removing dangerous APIs, the VM should abort execution entirely rather than run in a partially-sandboxed environment.

**Fault Injection:**
- Monkey-patch the isolate context so that deleting one of the mid-list globals (e.g., `Proxy`) throws a `TypeError`
- Attempt to execute a contract

**Observation:**
- Whether execution proceeds with a partially-stripped sandbox
- If the contract can access APIs that should have been removed (e.g., `setTimeout`, `fetch` if they exist in V8)
- Error classification and messaging

**Expected Outcome:**
- Execution fails before any contract code runs
- Error clearly indicates sandbox initialization failure
- No state changes or emissions
- Contract code never has access to a partial sandbox

---

### Experiment 5: Concurrent Isolate Exhaustion (CE-3)

**Hypothesis:** Under concurrent execution load, the VM handles isolate allocation failures gracefully without crashing the host process.

**Fault Injection:**
- Create 50 concurrent `vm.execute()` calls, each running a contract that holds its isolate for ~1 second (via legitimate computation)
- Monitor host process memory approaching the system limit
- Gradually increase concurrency until isolate creation fails

**Observation:**
- Host process RSS memory trajectory
- Number of successful vs. failed executions
- Error classification for failed executions (should be isolate-creation/OOM, not unhandled crash)
- Whether successful executions produce correct results despite concurrent pressure
- Host process survival (no SIGKILL from kernel OOM killer)

**Expected Outcome:**
- Executions that get an isolate succeed with correct results
- Executions that fail to get an isolate return a clear error (not a crash)
- After all concurrent executions complete, the VM is healthy for new work
- No isolate leaks (disposed count == created count)

---

### Experiment 6: Corrupted State Object (IN-2)

**Hypothesis:** The VM rejects or safely handles corrupted initial state without crashing or producing incorrect results.

**Fault Injection:** Execute contracts with progressively more adversarial state objects:
1. State with a key containing null bytes: `{ "key\x00evil": "value" }`
2. State with a value that is a nested object 100 levels deep
3. State with a value containing a `__proto__` key (prototype pollution)
4. State with 10,001 keys (exceeding `maxStateKeys`)
5. State with a value that is exactly 65,536 bytes (at the limit)
6. State with a circular reference (if not pre-serialized)

**Observation:**
- Which corrupted states are rejected at input validation vs. during execution
- Whether prototype pollution payloads affect the gateway or host
- Exact error messages and classifications
- State consistency: no partial writes from any failed execution

**Expected Outcome:**
- Cases 1-3: Execute successfully (keys are opaque strings; values are JSON) OR reject with clear validation error
- Case 4: Rejected with state key limit error before execution
- Case 5: Accepted (at limit, not over)
- Case 6: Rejected with serialization error
- No prototype pollution reaches the host environment

---

### Experiment 7: `acorn` / V8 Parser Divergence (RT-3)

**Hypothesis:** If acorn and V8 parse the same source code differently, the metering pass will produce code that either fails to compile or behaves incorrectly, but will not bypass gas metering.

**Fault Injection:** Execute contracts using JavaScript features at the edge of acorn's support:
1. Optional chaining (`a?.b?.c`) with side effects
2. Nullish coalescing in complex expressions
3. Destructuring with default values containing function calls
4. Template literals with deeply nested expressions
5. Computed property names with side effects
6. Arrow functions in unusual positions (inside ternaries, default params)

**Observation:**
- Whether the metering pass (`acorn.parse` + AST walk + `astring.generate`) preserves semantic equivalence
- Whether any construct causes metering injection to produce syntactically invalid code
- Whether any construct allows a gas-free code path (metering bypass)
- Comparison of gas charged vs. expected gas for each construct

**Expected Outcome:**
- Syntax validation catches any unsupported constructs before execution
- Metered code is semantically equivalent to original for all supported constructs
- No gas-free code paths exist
- If a divergence is found, it manifests as a compilation error (safe failure), not a metering bypass (unsafe)

---

### Experiment 8: Host Process Memory Leak (RT-4)

**Hypothesis:** Repeated execute-dispose cycles do not leak memory in the host Node.js process.

**Fault Injection:**
- Execute 10,000 sequential contract runs (alternating between `simple_send.js` and `state_counter.js`)
- Group into blocks of 100 with proper `beginBlock()`/`endBlock()` boundaries
- Force garbage collection (`global.gc()`) every 1,000 executions
- Record heap snapshots at intervals

**Observation:**
- Host process heap used (via `process.memoryUsage()`) at each 1,000-execution interval
- Whether heap usage grows monotonically (leak) or stabilizes (healthy)
- External memory (C++ isolate allocations) at each interval
- ArrayBuffer allocation counts

**Expected Outcome:**
- Heap usage stabilizes within 2x of baseline after the first 1,000 executions
- No monotonic growth trend over 10,000 executions
- External memory returns to baseline after each `endBlock()` cycle
- If a leak is detected, identify whether it's in JS heap, C++ external memory, or both

---

### Experiment 9: Rapid Block Cycling (MX-4)

**Hypothesis:** Rapid `beginBlock()`/`endBlock()` transitions with executions in each block correctly manage the compilation cache without memory leaks or stale cache hits.

**Fault Injection:**
- Execute 1,000 blocks, each containing 5 contract executions (mix of cached and unique contracts)
- Cycle blocks as fast as possible (no artificial delays)
- Include contracts that produce different results based on block context (to detect stale cache)

**Observation:**
- Compilation cache hit/miss rates
- Memory consumption trajectory
- Result correctness: contracts that depend on block height must produce results consistent with the current block, not a cached prior block
- Cache size never exceeds 1,000 entries

**Expected Outcome:**
- Cache correctly invalidated at each `endBlock()`
- No stale results from cached compilations
- Memory stable across all 1,000 blocks
- Throughput remains consistent (no degradation over time)

---

### Experiment 10: mathjs Precision Boundary (RT-2)

**Hypothesis:** The VM's math gateway correctly handles extreme numeric inputs without hanging, crashing, or producing silently incorrect results.

**Fault Injection:** Execute contracts that perform math operations with:
1. Numbers with exactly 256 characters (at `maxMathInputLength`)
2. Numbers with 257 characters (over limit)
3. `"0"` divided by `"0"`
4. Two numbers whose product exceeds 10^1000
5. Repeated operations (1000 sequential adds) accumulating precision
6. Strings that look numeric but contain Unicode digits (e.g., `"\uFF11\uFF12\uFF13"`)

**Observation:**
- Whether input length validation fires correctly
- Whether division by zero is caught and classified
- Whether extreme results are representable and consistent
- Whether accumulated operations maintain precision
- Whether Unicode digit strings are rejected or parsed

**Expected Outcome:**
- Case 1: Accepted, produces correct result
- Case 2: Rejected with clear error (input too long)
- Case 3: Caught as division-by-zero error
- Case 4: Produces correct result (mathjs bignumber handles arbitrary precision)
- Case 5: No precision loss after 1000 operations
- Case 6: Rejected as invalid numeric input (not silently misinterpreted)

---

## 4. Tools & Approach

### 4.1 Fault Injection Methods

| Method | Target Experiments | Description |
|--------|--------------------|-------------|
| **Mock providers with programmable behavior** | GW-1 through GW-5 | Replace state, oracle, balance, and cross-chain providers with mock objects that can be programmed to throw, hang, return bad data, or inject latency on specific call counts |
| **VM configuration overrides** | CE-1, CE-2, CE-3 | Use the existing `limits` and `gasSchedule` configuration to set aggressive thresholds (low memory, short timeouts, low gas ceilings) |
| **Adversarial contract fixtures** | CE-1, CE-2, SB-2, SB-3, RT-3 | Purpose-built contracts in `test/contracts/chaos/` that exercise specific failure modes (memory cliff, parser divergence, prototype probing) |
| **Monkey-patching internals** | SB-1, RT-1 | For sandbox partial-failure simulation, temporarily patch `sandbox.js` exports or isolate context methods to throw at controlled points. **Use sparingly and only in test environments** |
| **Concurrency harness** | CE-3, MX-2 | Node.js `Promise.all()` with controlled concurrency via a semaphore, driving multiple `vm.execute()` calls simultaneously |
| **Memory tracking wrapper** | RT-4, MX-4 | Wrapper around `vm.execute()` that records `process.memoryUsage()` (heapUsed, external, rss) before and after each call, with periodic `global.gc()` |
| **Input generators** | IN-1 through IN-4 | Extend existing fuzz generators (`test/fuzz/generators/`) with chaos-specific payloads (null bytes, circular refs, extreme sizes) |

### 4.2 Monitoring & Observability

| What to Monitor | How | Threshold |
|-----------------|-----|-----------|
| Host process survival | Process exit code, uncaughtException handler | Any crash = critical finding |
| Memory trajectory | `process.memoryUsage()` sampled every N executions | >2x baseline after stabilization = leak |
| Execution timing | `process.hrtime.bigint()` around `vm.execute()` | >2x `maxCpuTimeMs` = timeout mechanism failure |
| Result correctness | Assert `success`, `stateChanges`, `emittedActions`, `gasUsed` against expectations | Any unexpected result = finding |
| Atomicity verification | Check that failed executions return empty `stateChanges` and `emittedActions` | Any non-empty result on failure = critical finding |
| Error classification | Check `result.error` type matches the injected fault | Misclassification = medium finding |
| Isolate lifecycle | Count `new ivm.Isolate()` vs. `isolate.dispose()` calls | Mismatch after test = leak |
| Gas metering accuracy | Compare `result.gasUsed` against hand-calculated expected values | Deviation > 5% = metering finding |

### 4.3 Test Environment Configuration

- **Node.js flags:** Run chaos tests with `--expose-gc` (for forced GC in leak tests) and `--max-old-space-size=256` (to surface host memory pressure faster)  
- **Isolation:** Each chaos experiment should run in a fresh VM instance to prevent cross-experiment contamination  
- **Timeouts:** Use shortened timeouts (1-5s instead of 30s) for most experiments to keep suite runtime reasonable  
- **Reporting:** Each experiment outputs a structured JSON result: `{ experiment, hypothesis, injectedFault, observations, outcome, findings }`

---

## 5. Prioritized Roadmap

### Phase 1: Critical Security & Correctness (Week 1-2)

These experiments directly test whether the VM's core safety guarantees hold under stress:

| Priority | Experiment | Rationale |
|----------|------------|-----------|
| P0 | Exp 4: Sandbox Setup Partial Failure (SB-1) | A partial sandbox is the worst-case scenario -- contract code running with access to forbidden APIs |
| P0 | Exp 3: Gateway Error Mid-Emission (GW-4) | Atomicity is a core invariant; if it breaks under gateway failure, state corruption follows |
| P0 | Exp 1: Memory Cliff (CE-1) | OOM handling must not crash the host; incorrect handling is a denial-of-service vector |
| P1 | Exp 2: Gateway Callback Hang (GW-2) | Deadlocked callbacks could stall the indexer's block processing pipeline |
| P1 | Exp 6: Corrupted State Object (IN-2) | State is the primary input from the indexer; corruption here affects every subsequent operation |

### Phase 2: Resilience Under Load (Week 3-4)

These experiments test operational stability under sustained or concurrent workloads:

| Priority | Experiment | Rationale |
|----------|------------|-----------|
| P1 | Exp 5: Concurrent Isolate Exhaustion (CE-3) | Block processing may trigger many contract executions; resource contention must not crash the host |
| P1 | Exp 8: Host Process Memory Leak (RT-4) | Memory leaks are silent killers; the indexer runs continuously and any leak will eventually cause OOM |
| P2 | Exp 9: Rapid Block Cycling (MX-4) | Tests cache management under realistic block processing patterns |

### Phase 3: Edge Cases & Dependency Resilience (Week 5-6)

These experiments harden the VM against subtle failure modes:

| Priority | Experiment | Rationale |
|----------|------------|-----------|
| P2 | Exp 7: acorn/V8 Parser Divergence (RT-3) | A metering bypass would allow gas-free computation -- critical but lower probability |
| P2 | Exp 10: mathjs Precision Boundary (RT-2) | Financial calculations require absolute precision; edge cases could cause incorrect balances |

### Phase 4: Expansion (Ongoing)

After the initial experiments are established:

- **Compound experiments:** Combine faults (e.g., memory pressure + gateway latency + corrupted state simultaneously)  
- **Chaos in e2e:** Inject faults during full-stack `xchain-e2e-test` runs with real decoder/indexer/explorer  
- **Regression chaos:** When a bug is found and fixed, add a targeted chaos experiment as a regression guard  
- **Game Day exercises:** Scheduled sessions where multiple random faults are injected simultaneously to test overall system resilience

---

## 6. Integration Strategy

### 6.1 Development Workflow Integration

```
Feature branch development
    |
    v
Unit + Boundary + Security tests (existing)  -- every commit
    |
    v
Chaos Phase 1 experiments (P0/P1)            -- every PR that touches VM core
    |
    v
Full chaos suite (Phase 1-3)                 -- before merging to main
    |
    v
Extended chaos (compound + soak)             -- weekly scheduled run
    |
    v
Game Day                                     -- monthly, before releases
```

### 6.2 npm Scripts

Add to `xchain-vm/package.json`:

```
"test:chaos": "mocha test/chaos/**/*.test.js --timeout 120000 --expose-gc"
"test:chaos:quick": "mocha test/chaos/phase1/**/*.test.js --timeout 60000 --expose-gc"
"test:chaos:soak": "mocha test/chaos/soak/**/*.test.js --timeout 600000 --expose-gc"
```

### 6.3 Test File Organization

```
xchain-vm/test/chaos/
    phase1/
        sandbox-partial-failure.chaos.test.js
        gateway-error-atomicity.chaos.test.js
        memory-cliff.chaos.test.js
        gateway-hang.chaos.test.js
        corrupted-state.chaos.test.js
    phase2/
        concurrent-exhaustion.chaos.test.js
        memory-leak.chaos.test.js
        rapid-block-cycling.chaos.test.js
    phase3/
        parser-divergence.chaos.test.js
        math-precision.chaos.test.js
    soak/
        compound-faults.chaos.test.js
    contracts/
        memory_cliff.js
        parser_edge.js
        math_extreme.js
    helpers/
        programmable-mock.js    -- mock providers with fault injection
        memory-tracker.js       -- heap/external memory sampling
        chaos-reporter.js       -- structured JSON result output
```

### 6.4 CI/CD Gates

| Gate | Chaos Tests Required | Blocking? |
|------|----------------------|-----------|
| PR to main (VM core changes) | Phase 1 (P0 + P1) | Yes |
| PR to main (non-core changes) | Phase 1 P0 only | Yes |
| Pre-release | Full suite (Phase 1-3) | Yes |
| Weekly scheduled | Full suite + soak | No (report only) |
| Monthly Game Day | Compound faults | No (report only) |

### 6.5 When to Run Chaos Tests

- **Always run** after changes to: `src/sandbox.js`, `src/metering.js`, `src/gateway.js`, `src/index.js`, `src/gas.js`, `src/state.js`
- **Run Phase 2** after dependency updates (`isolated-vm`, `mathjs`, `acorn`)
- **Run soak tests** after any change to isolate lifecycle management or compilation cache

---

## 7. Reporting & Communication

### 7.1 Experiment Result Format

Each chaos experiment produces a structured report:

```json
{
    "experiment": "memory-cliff",
    "timestamp": "2026-04-03T12:00:00Z",
    "hypothesis": "VM terminates contract execution with OOM and remains stable",
    "injectedFault": {
        "type": "resource-exhaustion",
        "target": "isolate-memory",
        "parameters": { "allocationSize": "7MB", "memoryLimit": "8MB" }
    },
    "observations": {
        "executionTerminated": true,
        "errorClassification": "OOM",
        "hostProcessSurvived": true,
        "subsequentExecutionSucceeded": true,
        "memoryReturnedToBaseline": true,
        "atomicityMaintained": true
    },
    "outcome": "PASS",
    "findings": [],
    "duration_ms": 1523
}
```

### 7.2 Finding Classification

| Severity | Definition | Example |
|----------|------------|---------|
| **Critical** | Core safety invariant violated | Sandbox escape, atomicity failure, host crash |
| **High** | Resilience mechanism failed but no safety breach | Memory leak, timeout mechanism failure, incorrect error classification |
| **Medium** | Unexpected behavior with no immediate safety impact | Stale cache hit, gas metering deviation >5% |
| **Low** | Cosmetic or minor operational issue | Missing log entry, unclear error message |

### 7.3 Documentation

- **Per-experiment reports:** Saved as JSON in `xchain-vm/test/chaos/results/` after each run  
- **Aggregate dashboard:** Summary of all experiments (pass/fail/findings) generated after each full suite run  
- **Finding tickets:** Critical and High findings documented as GitHub issues with reproduction steps, observed vs. expected behavior, and affected code paths  
- **Retrospective:** After each Game Day, document: what failed, why, what was fixed, what new experiments to add

---

## 8. Success Criteria

The chaos engineering program is considered successful when:

1. **All P0 experiments pass consistently** -- sandbox integrity, atomicity, and resource limits hold under fault injection
2. **No critical findings remain open** from any phase
3. **Memory leak tests show no monotonic growth** over 10,000+ executions
4. **Concurrent execution** does not crash the host process under any tested load
5. **Gateway failures** are always classified correctly and never break atomicity
6. **The test suite runs in CI** and has caught at least one real issue before it reached production

---

## 9. Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Chaos tests themselves crash the host, blocking CI | Run chaos tests in a separate CI job with `continue-on-error`; host crash is itself a critical finding |
| Monkey-patching internals makes tests fragile | Minimize internal patching; prefer fault injection through the public API (mock providers, config overrides) |
| Tests pass today but drift as code evolves | Tie chaos tests to specific files via CI gate rules (Section 6.4); review chaos coverage during code review |
| False positives from environmental variance (CI host load) | Use generous thresholds for timing-sensitive assertions; retry flaky results once before reporting |
| Experiments take too long for developer workflow | Maintain a `test:chaos:quick` target (~60s) for local development; full suite runs in CI only |
