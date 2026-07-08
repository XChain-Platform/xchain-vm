# XChain VM - Mutation Testing Plan

## 1. Objective

Assess the quality and detection power of the existing XChain VM test suite (1,284+ tests across unit, boundary, security, chaos, E2E, and fuzz categories) by systematically introducing small, artificial mutations into the source code and verifying that at least one test fails for each mutation. A high "killed mutation" rate confirms the suite can catch subtle regressions, logic flaws, and security vulnerabilities. A surviving mutation exposes a blind spot.

The VM is the most security-critical component in the XChain Platform. A single undetected logic change in gas metering, sandbox enforcement, or state atomicity could cause consensus divergence, ledger manipulation, or host-process compromise. Code coverage alone cannot prove detection power - mutation testing can.

---

## 2. Target Code Areas

### 2.1 Priority Tiers

Modules are tiered by blast radius - how much platform damage a single undetected mutation could cause.

| Tier | Module | Lines | Why |
|------|--------|-------|-----|
| **Critical** | `metering.js` | 271 | Incomplete gas injection = infinite loops, consensus divergence |
| **Critical** | `index.js` | 615 | Orchestration, error atomicity, result assembly, prefix protocol |
| **Critical** | `sandbox.js` | 146 | Escape = host compromise, non-determinism |
| **Critical** | `gas.js` | 37 | Ceiling bypass = infinite computation |
| **High** | `gateway.js` | 138 | Gas charging on API calls, state ops, revert/require logic |
| **High** | `gateway-emit.js` | 127 | Action validation, required fields, type checks |
| **High** | `state.js` | 94 | Dirty tracking, key limits, NaN/Infinity rejection, atomicity |
| **High** | `math.js` | 72 | Deterministic arithmetic, division-by-zero, input validation |
| **Medium** | `collector.js` | 39 | Emission caps, log caps, prototype pollution prevention |
| **Medium** | `validator.js` | 23 | Action allowlist enforcement |
| **Medium** | `syntax.js` | 80 | Deploy-time validation, `__gas` identifier rejection |
| **Low** | `isolate.js` | 68 | Isolate lifecycle, memory limits |
| **Low** | `errors.js` | 19 | Custom error types |

**Total target:** ~1,729 lines across 13 modules.

### 2.2 Critical Mutation Points (Specific)

These are the highest-value individual code locations where a single mutation could have outsized impact:

#### Error Atomicity (`index.js:589-591`)
```
stateChanges = {};  emittedActions = [];  // on error path
```
Mutating the error-path cleanup to skip clearing `stateChanges` or `emittedActions` simulates a partial-state-leak bug. If no test catches this, contracts can corrupt ledger state on revert.

#### Revert Reason Verification (`index.js:537-542`)
```
if (execContext.reverted) { ... } else { ... }
```
Negating the `reverted` flag check simulates revert spoofing - a contract could trick the host into treating a revert as success or vice versa.

#### Gas Ceiling Check (`gas.js:27-28`)
```
if (this.used > this.ceiling) throw new GasExhaustedError(...)
```
Changing `>` to `>=`, `<`, or removing the check entirely simulates gas exhaustion bypass.

#### Prefix Protocol (`index.js:44-46, 366-368`)
```
\x01  → JSON return value
\x02  → revert marker
\x03  → error marker
```
Swapping, removing, or altering prefix characters simulates protocol corruption - the host misinterprets contract output.

#### `__gas` Protection (`index.js:72-82`)
```
Object.defineProperty(globalThis, '__gas', { ... configurable: false })
```
Removing `configurable: false` or the entire `defineProperty` call allows contracts to override gas metering.

#### Sandbox Global Deletion (`sandbox.js:15-21`)
```
const toDelete = ['Date', 'setTimeout', 'setInterval', 'fetch', ...]
```
Removing any single entry from `toDelete` re-exposes a non-deterministic or dangerous API to contracts.

#### State NaN/Infinity Guard (`state.js:48-49`)
```
if (typeof value === 'number' && !isFinite(value)) throw ...
```
Removing this guard allows NaN/Infinity into state, which corrupts JSON serialization and breaks determinism.

#### Constructor Neutering (`sandbox.js:36-56`)
```
Function.prototype.constructor = undefined
GeneratorFunction.prototype.constructor = undefined
```
Skipping any single constructor neutering reopens sandbox escape via `(function(){}).constructor('return this')()`.

#### Metering Phase Coverage (`metering.js:100-245`)
Each of the three metering phases targets distinct AST constructs. Skipping ForStatement injection (Phase 1), BinaryExpression depth check (Phase 2), or CallExpression wrapping (Phase 3) leaves specific code patterns unmetered.

#### Math Division-by-Zero (`math.js:31-32`)
```
if (math.equal(b, math.bignumber(0))) throw new ContractRevertError(...)
```
Removing this check allows division by zero to produce Infinity, breaking determinism.

---

## 3. Mutation Strategies

### 3.1 Mutation Operators

Operators are ranked by relevance to VM security and correctness.

| Operator | Description | VM Relevance | Example |
|----------|-------------|--------------|---------|
| **Conditional Boundary** | `>` to `>=`, `<` to `<=`, etc. | Gas ceiling, size limits, key counts | `this.used > this.ceiling` → `this.used >= this.ceiling` |
| **Conditional Negation** | Negate boolean conditions | Revert flag, validation checks | `if (reverted)` → `if (!reverted)` |
| **Statement Deletion** | Remove a single statement | Guard removals, missing side effects | Delete `throw new GasExhaustedError(...)` |
| **Arithmetic Operator** | `+` to `-`, `*` to `/`, etc. | Gas accumulation, key counting | `this.used += amount` → `this.used -= amount` |
| **Logical Operator** | `&&` to `\|\|`, `!` removal | Compound validation conditions | `if (a && b)` → `if (a \|\| b)` |
| **Return Value** | Change return values | State queries, validation results | `return true` → `return false` |
| **String Literal** | Alter string constants | Prefix protocol, error messages | `'\x01'` → `'\x02'` |
| **Array Element Deletion** | Remove one element from arrays | Sandbox `toDelete` list, required fields | Remove `'Date'` from toDelete |
| **Method Call Removal** | Remove a function call | Gas charging, validation calls | Remove `gas.charge(100)` |
| **Constant Replacement** | Change numeric constants | Gas costs, size limits, caps | `100` → `0`, `1024` → `2048` |
| **Equality Operator** | `===` to `!==`, `==` to `!=` | Type checks, action validation | `typeof x === 'object'` → `typeof x !== 'object'` |
| **Empty Block** | Replace function body with `{}` | Entire validation functions | `validateRequired()` → `{}` |

### 3.2 VM-Specific Mutation Patterns

Beyond standard operators, these patterns target XChain VM architectural invariants:

**Atomicity Mutations:**
- Remove error-path state/emission clearing (`index.js:589-591`)
- Remove `execContext.reverted` flag assignment (`gateway.js:112`)
- Remove log preservation on error path

**Determinism Mutations:**
- Re-enable a single stripped global (e.g., put `Date` back)
- Replace `SafeMath` with native `Math` object
- Skip `Object.freeze` on SafeMath

**Gas Integrity Mutations:**
- Remove `chargeComputation()` from the `__gas` callback
- Set gas cost to 0 for state/emit operations
- Skip gas ceiling comparison
- Remove `__gas()` injection for a single AST node type (e.g., ForStatement only)

**Sandbox Escape Mutations:**
- Restore a single constructor (`Function.prototype.constructor = Function`)
- Skip `Object.defineProperty` restriction
- Skip `eval` neutering
- Remove one prototype chain closure

**Protocol Integrity Mutations:**
- Swap `\x01` and `\x02` prefix characters
- Remove JSON.parse from return value handling
- Alter the `wrap()` harness function's protocol parsing

### 3.3 Equivalent Mutation Identification

Some mutations produce functionally identical behavior (equivalent mutants). These cannot be killed and inflate the denominator. Known categories for this codebase:

- **Dead code paths**: Code reachable only in configurations not tested (none identified - the VM has a single execution path)
- **Redundant guards**: A mutation that disables a guard already covered by an earlier check (e.g., `gas.js` negative-amount check is also implicitly caught by the ceiling)
- **String-only changes**: Altering error messages when tests check for error type, not message content

The mutation tool configuration should mark known equivalent mutants to avoid false negatives in the score.

---

## 4. Execution & Analysis Process

### 4.1 How Mutation Testing Works

```
For each mutation M in the mutation set:
    1. Apply mutation M to a copy of the source code
    2. Run the full test suite against the mutated code
    3. If any test fails → mutation is "killed" (good)
    4. If all tests pass → mutation "survived" (bad - test gap)
    5. Revert the mutation
```

### 4.2 Test Suite Selection

Different test categories serve different roles in mutation killing:

| Test Category | Files | Tests | Role in Mutation Testing |
|---------------|-------|-------|--------------------------|
| Unit tests | 14 files | ~300+ | Primary killers - fast, targeted, one assertion per behavior |
| Boundary tests | 1 file | 106 | Kill boundary mutations (off-by-one in limits, caps) |
| Security tests | 1 file | 68 | Kill sandbox escape and error spoofing mutations |
| E2E tests | 11 files | ~50+ | Kill integration-level mutations (cross-module data flow) |
| Chaos tests | 3 phases | ~30+ | Kill atomicity and resilience mutations |
| Fuzz tests | 5 files | ~25+ | May kill edge-case mutations missed by deterministic tests |

**Recommended execution order** (for performance): Unit → Boundary → Security → E2E → Chaos. Stop at first failure (early termination) to minimize total test time per mutation.

### 4.3 Definitions

| Term | Definition |
|------|------------|
| **Killed** | At least one test failed when run against the mutated code |
| **Survived** | All tests passed despite the mutation - indicates a test gap |
| **Timed out** | Test suite exceeded the timeout threshold - treated as killed (the mutation likely caused an infinite loop, which is itself a detectable failure) |
| **No coverage** | No test executes the mutated line - treated as survived |
| **Equivalent** | The mutation produces identical behavior - excluded from scoring |
| **Mutation Score** | `killed / (total - equivalent) * 100` |

### 4.4 Target Mutation Scores

| Tier | Target Score | Rationale |
|------|-------------|-----------|
| **Critical** (metering, index, sandbox, gas) | **>95%** | These modules protect consensus and security - virtually every logic path must be test-covered and test-detected |
| **High** (gateway, gateway-emit, state, math) | **>90%** | Core business logic - high detection required but minor edge cases are lower risk |
| **Medium** (collector, validator, syntax) | **>85%** | Supporting modules - important but lower blast radius |
| **Low** (isolate, errors) | **>80%** | Infrastructure - lifecycle and type definitions |
| **Overall** | **>90%** | Aggregate across all modules |

### 4.5 Interpreting Survived Mutations

Each survived mutation requires triage:

1. **Is it equivalent?** If the mutation cannot change observable behavior, mark it as equivalent and exclude from scoring.
2. **Is the test missing?** If no test covers the mutated line, write a new test targeting that specific behavior.
3. **Is the test weak?** If a test covers the line but doesn't assert the right thing (e.g., checks return type but not value), strengthen the assertion.
4. **Is it a real blind spot?** If the mutation represents a plausible bug that no test detects, this is a genuine test gap. Prioritize by tier.

---

## 5. Tooling Recommendations

### 5.1 Primary Tool: Stryker Mutant Framework (`@stryker-mutator/core`)

Stryker is the most mature mutation testing framework for JavaScript/Node.js.

**Why Stryker:**
- Native JavaScript/Node.js support via `@stryker-mutator/javascript-mutator`
- Mocha test runner plugin (`@stryker-mutator/mocha-runner`) - matches the existing test framework
- Supports all standard mutation operators (conditional boundary, arithmetic, logical, statement deletion, etc.)
- Incremental mode - only re-tests mutations in changed files
- HTML reporter with per-file mutation scores and surviving mutation locations
- Configurable mutation scope (target specific files/directories)
- Early termination on first failing test per mutation

**Installation:**
```bash
npm install --save-dev @stryker-mutator/core @stryker-mutator/mocha-runner
```

**Configuration** (`stryker.config.json`):
```json
{
  "mutate": ["src/**/*.js", "!src/errors.js"],
  "testRunner": "mocha",
  "mochaOptions": {
    "spec": ["test/**/*.test.js"],
    "timeout": 30000
  },
  "reporters": ["html", "clear-text", "progress"],
  "htmlReporter": {
    "fileName": "reports/mutation/index.html"
  },
  "thresholds": {
    "high": 95,
    "low": 85,
    "break": 80
  },
  "concurrency": 4,
  "timeoutMS": 60000,
  "timeoutFactor": 2.5
}
```

### 5.2 Supporting Tools

| Tool | Purpose | When to Use |
|------|---------|-------------|
| **`stryker-diff-runner`** (Stryker incremental) | Only mutate lines changed since last run | CI integration - avoid full-suite mutation on every commit |
| **`mutation-testing-elements`** | Interactive HTML dashboard for results | Browsing survived mutations, drilling into specific files |
| **Custom mutation scripts** | Targeted mutations Stryker doesn't support (e.g., array element deletion, string prefix swaps) | VM-specific patterns in Section 3.2 |

### 5.3 Custom Mutator Plugin for VM-Specific Patterns

Stryker's built-in operators cover ~70% of the mutations defined in Section 3.2. The remaining 30% (atomicity, determinism, sandbox escape, protocol prefix) require a custom Stryker plugin:

```
@stryker-mutator/core  →  custom XChainVmMutator plugin
                           ├── ArrayElementDeletion  (sandbox toDelete list)
                           ├── StringPrefixSwap      (\x01/\x02/\x03)
                           ├── PrototypeRestoration   (constructor neutering)
                           └── GuardDeletion          (targeted throw removal)
```

This plugin would implement Stryker's `Mutator` interface and generate AST-level mutations for the patterns described in Section 3.2.

### 5.4 Performance Considerations

The VM test suite has 1,284+ tests with some tests taking 5-30 seconds (chaos, E2E). Full mutation testing of all 13 modules will generate hundreds of mutants.

**Estimated runtime:**

| Scenario | Mutants | Time per mutant | Total |
|----------|---------|-----------------|-------|
| Critical tier only (4 modules) | ~300-400 | ~30s (unit only, early termination) | ~3-4 hours |
| All tiers, unit tests only | ~500-700 | ~15s | ~2-3 hours |
| All tiers, full suite | ~500-700 | ~2-5 min | ~20-50 hours |

**Optimization strategies:**
- Run unit tests first (early kill), then boundary/security, then E2E
- Use Stryker's `--concurrency` flag (4-8 parallel workers)
- Exclude E2E and chaos tests from initial runs (use `--mochaOptions.spec`)
- Use incremental mode in CI (only mutate changed files)

---

## 6. Phased Integration & Reporting

### 6.1 Phase 1: Critical Tier Pilot (Weeks 1-2)

**Scope:** `gas.js`, `sandbox.js`, `metering.js` (smallest critical modules first)

**Steps:**
1. Install Stryker and configure for Mocha
2. Run mutation testing against `gas.js` (37 lines, ~15-20 mutants) as a proof of concept
3. Triage survived mutations - are they equivalent or genuine gaps?
4. Expand to `sandbox.js` (146 lines, ~50-80 mutants)
5. Expand to `metering.js` (271 lines, ~100-150 mutants)

**Success criteria:** All three modules achieve >95% mutation score. Any surviving non-equivalent mutations have corresponding test improvement tickets filed.

**Why start here:** These three modules are small enough for fast iteration, critical enough that gaps matter, and well-tested enough that the initial score should be high - building confidence in the approach.

### 6.2 Phase 2: High Tier + `index.js` (Weeks 3-4)

**Scope:** `index.js`, `gateway.js`, `gateway-emit.js`, `state.js`, `math.js`

**Steps:**
1. Run Stryker against each module
2. Implement the custom mutator plugin for VM-specific patterns (protocol prefixes, atomicity clearing, guard deletion)
3. Triage survived mutations with focus on:
   - Error atomicity path in `index.js`
   - Gas charging completeness in `gateway.js`
   - Required field coverage in `gateway-emit.js`
   - State validation completeness in `state.js`
4. Write new tests or strengthen assertions for genuine gaps

**Success criteria:** High-tier modules achieve >90%. Custom plugin covers all VM-specific mutation patterns from Section 3.2.

### 6.3 Phase 3: Full Coverage + CI Integration (Weeks 5-6)

**Scope:** All remaining modules + CI pipeline

**Steps:**
1. Run Stryker against `collector.js`, `validator.js`, `syntax.js`, `isolate.js`, `errors.js`
2. Configure Stryker incremental mode for CI
3. Add mutation score thresholds to CI - fail the build if score drops below `thresholds.break` (80%)
4. Generate the first full mutation testing report

**Success criteria:** Overall mutation score >90%. CI pipeline blocks PRs that reduce the score below threshold.

### 6.4 Phase 4: Ongoing Maintenance

- **Per-PR:** Incremental mutation testing on changed files (Stryker diff mode)  
- **Weekly:** Full mutation run on critical tier only (~3-4 hours)  
- **Monthly:** Full mutation run on all tiers (~20-50 hours, overnight)  
- **On test changes:** Re-run mutation testing for the affected module to verify the new/changed tests actually kill more mutants

### 6.5 Reporting Format

#### Per-Run Report

Generated automatically by Stryker HTML reporter + supplemented with a summary markdown file:

```
reports/mutation/
  index.html              # Interactive Stryker HTML report
  mutation-score.json     # Machine-readable scores per module
  MUTATION_SUMMARY.md     # Human-readable summary (below)
```

**MUTATION_SUMMARY.md structure:**

```markdown
# Mutation Testing Report - [date]

## Overall Score: XX.X% (XXX killed / XXX total, XX equivalent excluded)

## Per-Module Scores

| Module | Mutants | Killed | Survived | Equivalent | Score | Target | Status |
|--------|---------|--------|----------|------------|-------|--------|--------|
| gas.js | 18 | 17 | 0 | 1 | 100% | >95% | PASS |
| sandbox.js | 72 | 68 | 2 | 2 | 97.1% | >95% | PASS |
| ... | ... | ... | ... | ... | ... | ... | ... |

## Survived Mutations (Action Required)

### [module.js:line] - Mutation Operator: [type]
- **Original:** `code`  
- **Mutated:** `mutated code`  
- **Impact:** [what this mutation simulates]  
- **Recommendation:** [specific test to write or assertion to strengthen]  
- **Priority:** [Critical / High / Medium / Low]
```

#### Triage Workflow for Survived Mutations

```
Survived mutation
    ├── Is it equivalent? → Mark as equivalent, exclude from score
    ├── No test covers the line? → Write new test
    ├── Test covers line but assertion is weak? → Strengthen assertion
    └── Genuine blind spot? → File ticket, prioritize by tier
```

---

## 7. Value Proposition

### 7.1 What Mutation Testing Reveals That Coverage Cannot

Code coverage measures **whether code was executed**, not **whether tests would detect a change**. A line can have 100% coverage but 0% mutation detection if the test never asserts on its output.

**Concrete XChain VM example:**

A test that executes `gas.charge(100)` and only asserts that no exception is thrown would give 100% line coverage on `gas.js:26-28`. But it would *not* detect a mutation that changes `this.used += amount` to `this.used -= amount` - the charge call succeeds either way. Only an assertion on `gas.getUsed()` returning the expected value would kill that mutation.

### 7.2 Security Implications

For a VM that executes untrusted contract code, mutation testing directly answers: "If an attacker found a subtle one-character bug in our security enforcement, would our tests catch it?"

| Area | What mutation testing validates |
|------|-------------------------------|
| **Sandbox isolation** | Every stripped global and neutered constructor is individually verified by at least one test |
| **Gas metering** | Every AST node type that should receive `__gas()` injection is tested in isolation |
| **Error atomicity** | The error-path state/emission clearing is not just executed but asserted |
| **Input validation** | Every validation check, if removed, causes at least one test to fail |
| **Determinism** | The SafeMath replacement and Math.random removal are individually tested |

### 7.3 Expected Outcomes

Based on the current test suite composition (1,284+ tests including boundary, security, chaos, and fuzz):

- **gas.js:** Expected >98% - 15 focused unit tests directly target ceiling enforcement and accumulation  
- **sandbox.js:** Expected >90% - 27 unit tests + 68 security tests cover most escape vectors, but individual `toDelete` entries may not all be individually tested  
- **metering.js:** Expected >85% - 40 unit tests cover most AST node types, but some edge cases (Phase 2 binary depth, Phase 3 SequenceExpression) may have gaps  
- **state.js:** Expected >95% - 34 unit tests with explicit validation checks for each guard  
- **index.js:** Expected >80% - 57 unit tests cover the main paths, but the error classification logic and prefix protocol have many branches

The highest value will come from identifying the **10-15% of mutations that survive** - these represent the specific logic paths where a subtle bug could go undetected by the current suite.

---

## 8. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Long runtime** | Full mutation run takes 20-50 hours | Phase by tier; use incremental mode in CI; full runs overnight |
| **Equivalent mutants inflate denominator** | Score appears lower than actual detection power | Manually review survived mutations; mark equivalents; Stryker supports `// Stryker disable` comments |
| **Flaky tests cause false kills** | A mutation appears killed but the test was just flaky | Stryker reruns failed tests - configure `--tempDirName` and review flaky kills |
| **`isolated-vm` native module** | Stryker may have issues with native V8 bindings | Test the pilot phase with `gas.js` (pure JS, no native deps) first |
| **Custom plugin maintenance** | VM-specific mutator plugin needs updating as code evolves | Keep the plugin scoped to the 4-5 patterns in Section 3.2; review on major refactors |

---

## 9. Summary

Mutation testing is the next logical step in the XChain VM's testing maturity. The existing suite is comprehensive in breadth (unit, boundary, security, chaos, E2E, fuzz) but mutation testing will reveal whether each individual test is *strong enough* to catch a one-line regression in the code it covers.

**Key actions:**
1. Install Stryker with Mocha runner
2. Pilot on `gas.js` → `sandbox.js` → `metering.js` (Critical tier)
3. Build custom mutator plugin for VM-specific patterns
4. Expand to all modules over 6 weeks
5. Integrate incremental mutation testing into CI
6. Target >90% overall mutation score, >95% for critical tier

The result: quantified confidence that the test suite will detect subtle logic flaws in the most security-critical component of the XChain Platform.
