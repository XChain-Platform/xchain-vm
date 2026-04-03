# XChain VM -- Regression Testing Plan

**Date:** 2026-04-03
**Component:** `xchain-vm`
**Version:** 1.10.0
**Criticality:** Extremely High -- core execution engine, security boundary, and consensus determinism

---

## 1. Objective

Verify that code changes to the `xchain-vm` -- whether new features (enhanced sandboxing, new emit types), bug fixes (execution engine corrections, gas metering patches), refactoring (AST pipeline improvements), or dependency updates (`isolated-vm`, `acorn`, `mathjs`) -- do not break existing stable functionality. The regression suite is the final gate before any VM change reaches the indexer and, by extension, the live ledger.

A regression in the VM is uniquely dangerous because:

- **Consensus divergence**: Non-deterministic behavior causes chain splits across nodes.
- **Ledger corruption**: Faulty state atomicity or emission validation allows invalid token operations.
- **Host compromise**: Sandbox escape exposes the indexer process to arbitrary code execution.
- **Economic damage**: Gas metering bypass enables infinite-computation denial-of-service.

The regression suite must catch all of these failure classes with high confidence and fast feedback.

---

## 2. Scope Definition

The regression suite is a **curated, layered test collection** drawn from across all existing test phases. It is not a separate body of test code -- it is a *selection and execution strategy* over the existing tests (unit, integration, E2E, security, boundary, fuzz, chaos) plus a small set of regression-specific tests for previously fixed bugs.

### 2.1 Suite Composition

| Layer | Source | What It Covers | Approx. Test Count |
|-------|--------|----------------|-------------------|
| **Smoke** | `test/smoke.test.js` | VM instantiation, sandbox creation, basic execution, method dispatch | ~10 |
| **Core Unit** | `test/metering.test.js`, `test/gas.test.js`, `test/sandbox.test.js`, `test/state.test.js`, `test/math.test.js`, `test/collector.test.js`, `test/errors.test.js` | Metering injection, gas ceiling enforcement, sandbox stripping, state CRUD/limits, deterministic math, emission caps | ~90 |
| **Gateway & Validation** | `test/gateway.test.js`, `test/gateway-emit.test.js`, `test/validator.test.js`, `test/syntax.test.js` | All 16 emit types, action validation, deploy-time syntax checks, context accessors | ~60 |
| **Security** | `test/security.test.js` | Sandbox escape attempts, prototype pollution, constructor chains, resource exhaustion, eval/Function blocking | ~80 |
| **Integration** | `test/index.test.js`, `test/isolate.test.js`, `test/determinism.test.js`, `test/limits.test.js`, `test/compilation.test.js` | Full execution pipeline, isolate lifecycle, determinism verification, resource limit enforcement, compilation caching | ~60 |
| **Boundary** | `test/boundary.test.js` | Edge cases at all configured limits (gas ceiling, state keys, value sizes, emission caps, code size, math input length) | ~80 |
| **E2E Critical Path** | `test/e2e/deploy-execute.e2e.test.js`, `test/e2e/state-persistence.e2e.test.js`, `test/e2e/security.e2e.test.js`, `test/e2e/determinism.e2e.test.js` | Full contract lifecycle, state persistence across executions, E2E security constraints, cross-execution determinism | ~40 |
| **Bug Regression** | `test/regression/*.test.js` (new directory) | Tests for specific previously fixed bugs, each tagged with the originating issue/commit | 0+ (grows over time) |

**Total estimated regression suite size:** ~420+ tests

### 2.2 Explicit Inclusions (Non-Negotiable)

These areas MUST always be in the regression suite regardless of execution time pressure:

1. **Gas metering injection completeness** -- every AST node type (loops, conditionals, try/catch, function entry, deep binary expressions, call expressions) must have at least one regression test verifying `__gas()` insertion.
2. **Sandbox global stripping** -- Date, Math.random, setTimeout, fetch, process, require, eval, Proxy, WeakRef, Function.prototype.constructor must each be verified as removed/blocked.
3. **Error atomicity** -- on contract revert or gas exhaustion, `stateChanges` must be empty and `emittedActions` must be empty while `logs` are preserved.
4. **State validation** -- NaN, Infinity, null, undefined rejection; key/value size limits; max key count enforcement.
5. **Emission validation** -- all 16 ACTION types with required field enforcement; emission cap at configured limit.
6. **Determinism** -- identical inputs produce identical outputs across multiple executions (minimum 3 runs).
7. **Resource limits** -- memory (8 MB), CPU timeout (30s), max emissions (50), max state keys (10,000), max code size (64 KB).

### 2.3 Explicit Exclusions

- **Fuzz tests** (`test/fuzz/`): Too slow and non-deterministic for commit-level regression. Run separately on schedule.
- **Chaos tests** (`test/chaos/`): Designed for resilience exploration, not pass/fail regression. Run separately on schedule.
- **Benchmarks** (`bench/`): Performance regression is tracked separately (see Section 4.3).
- **Mutation tests**: Assessment tool for test quality, not a regression gate.

---

## 3. Test Selection Criteria

### 3.1 Inclusion Rules

A test belongs in the regression suite if it meets **any** of these criteria:

| # | Criterion | Rationale |
|---|-----------|-----------|
| R1 | Covers a **Critical-tier** module (`metering.js`, `index.js`, `sandbox.js`, `gas.js`) | Mutations here cause consensus divergence or host compromise |
| R2 | Covers a **High-tier** module (`gateway.js`, `gateway-emit.js`, `state.js`, `math.js`) | Mutations here corrupt ledger state or break contract logic |
| R3 | Tests a **security constraint** (sandbox bypass, resource exhaustion, prototype pollution) | Security regressions are catastrophic and may not be caught by functional tests |
| R4 | Verifies **determinism** (same inputs produce identical outputs) | Non-determinism causes chain splits between nodes |
| R5 | Tests **error atomicity** (state/emission rollback on failure) | Atomicity failure corrupts the indexer database |
| R6 | Was written to **reproduce a specific bug** that was fixed | Bug regression is the primary purpose of this suite |
| R7 | Exercises a **complete execution path** from code input to result output | Integration regressions often manifest at boundaries, not within modules |
| R8 | Validates a **platform ACTION type** end-to-end through the emit pipeline | ACTION changes are frequent and high-impact |

### 3.2 Prioritization Tiers

Tests within the regression suite are assigned priority tiers that determine execution order and which subset runs at each trigger point:

| Tier | Name | Criteria | Target Time |
|------|------|----------|-------------|
| **P0** | Smoke | VM boots, sandbox activates, basic execution works | < 5s |
| **P1** | Core Security | Sandbox escapes, gas bypass, atomicity, determinism | < 30s |
| **P2** | Core Functional | Gas metering, state ops, all 16 emit types, math, validation | < 90s |
| **P3** | Boundary & Integration | Limit enforcement, full pipeline, compilation cache, E2E critical path | < 180s |
| **P4** | Extended Regression | Bug-specific regressions, edge cases, all boundary tests | < 300s |

### 3.3 Tagging Convention

Each regression test should carry metadata (via Mocha `describe`/`it` descriptions or a tag system) indicating:

- **Priority tier** (P0-P4)
- **Module(s) under test** (e.g., `metering`, `sandbox`, `gateway-emit`)
- **Failure class** (consensus, security, data-integrity, functional)
- **Origin** (unit, security, boundary, e2e, bug-fix with issue reference)

Example naming:
```
[P1][sandbox][security] blocks Date constructor access
[P2][gateway-emit][functional] emit.send validates required destination field
[P4][bug-fix:#47][metering] nested ternary in arrow function gets gas injection
```

---

## 4. Execution Strategy

### 4.1 Trigger Points

| Trigger | Suite Subset | Max Time | Rationale |
|---------|-------------|----------|-----------|
| **Every commit** (pre-push hook or CI) | P0 + P1 | < 35s | Fast feedback on fundamental breakage and security regressions |
| **Pull request** (CI pipeline) | P0 + P1 + P2 + P3 | < 5 min | Full functional regression before merge |
| **Nightly build** | P0 through P4 + Fuzz + Chaos Phase 1 | < 30 min | Comprehensive regression including slow/non-deterministic suites |
| **Pre-release** | All tests (P0-P4 + full Fuzz + all Chaos phases + Mutation) | < 2 hours | Maximum confidence before version bump |
| **Dependency update** (`isolated-vm`, `acorn`, `mathjs`) | P0 through P4 + Security suite in full | < 10 min | Native dependencies and math library changes are high-risk |

### 4.2 npm Script Integration

Add the following scripts to `package.json` to formalize regression tiers:

```json
{
  "test:regression:smoke": "mocha --timeout 10000 'test/smoke.test.js'",
  "test:regression:core": "mocha --timeout 30000 'test/smoke.test.js' 'test/security.test.js' 'test/sandbox.test.js' 'test/gas.test.js' 'test/determinism.test.js'",
  "test:regression:full": "mocha --timeout 60000 'test/*.test.js' 'test/e2e/deploy-execute.e2e.test.js' 'test/e2e/state-persistence.e2e.test.js' 'test/e2e/security.e2e.test.js' 'test/e2e/determinism.e2e.test.js'",
  "test:regression:nightly": "mocha --timeout 120000 'test/**/*.test.js' 'test/e2e/**/*.e2e.test.js' 'test/fuzz/**/*.fuzz.test.js' 'test/chaos/phase1/**/*.chaos.test.js'",
  "test:regression:release": "npm run test:all && npm run test:fuzz && npm run test:chaos && npm run mutation:critical",
  "test:regression:bugfix": "mocha --timeout 30000 'test/regression/**/*.test.js'"
}
```

### 4.3 Performance Regression Tracking

While benchmarks are excluded from the functional regression suite, performance regressions in the VM are also critical (a 2x slowdown in metering injection affects every block). The strategy:

1. **Baseline benchmarks** recorded at each release via `npm run bench:full`, stored in `bench/baselines/`.
2. **Nightly comparison** runs `bench:quick` and compares against the current baseline.
3. **Threshold alerts**: Flag if any scenario degrades by more than 15% from baseline.
4. **Soak test** (`bench:soak`) run pre-release to detect memory leaks over sustained execution.

### 4.4 Parallel Execution

Mocha's `--parallel` flag can be used for test files that do not share state. The following groups are safe to parallelize:

| Group | Files | Shared State? |
|-------|-------|---------------|
| Pure unit tests | `gas.test.js`, `math.test.js`, `collector.test.js`, `errors.test.js`, `validator.test.js`, `syntax.test.js` | None -- pure functions |
| Sandbox/metering | `sandbox.test.js`, `metering.test.js` | None -- create fresh isolates |
| Stateful integration | `state.test.js`, `gateway.test.js`, `gateway-emit.test.js` | Creates VM instances but no cross-test leakage |
| Full pipeline | `index.test.js`, `determinism.test.js`, `limits.test.js`, `compilation.test.js` | Creates VM instances; safe to parallelize if each creates its own |
| Security | `security.test.js`, `boundary.test.js` | Heavy isolate usage -- may benefit from dedicated worker |
| E2E | `test/e2e/*.e2e.test.js` | Each test manages its own VM lifecycle |

**Recommendation:** Run pure unit tests in parallel (Group 1-3), then heavier integration/security tests sequentially to avoid `isolated-vm` memory pressure. Target: ~40% wall-clock reduction for the full P0-P3 suite.

### 4.5 Environment Considerations

- **isolated-vm availability**: All VM tests gracefully skip if the native module is not compiled. The regression suite runner must **fail loudly** (not skip) if `isolated-vm` is unavailable -- silent skips in regression are dangerous.
- **Node.js version**: Pin the CI Node.js version to match production. `isolated-vm` behavior can vary across V8 versions.
- **OS consistency**: V8 isolate memory accounting differs across Linux/macOS. CI must run on the same OS as production (Linux).

---

## 5. Maintenance & Management

### 5.1 Adding Tests to the Regression Suite

| Event | Action |
|-------|--------|
| **Bug fix merged** | Write a minimal reproducer test in `test/regression/` named `{issue-number}-{short-description}.test.js`. Tag with P4 priority. This test MUST fail on the pre-fix code and pass on the post-fix code. |
| **New feature stabilized** | Identify the feature's unit and integration tests. Tag the critical subset for regression inclusion. Add them to the appropriate `test:regression:*` script glob if not already covered. |
| **New ACTION type added** | Add emit validation test (required fields, gas charging) to gateway-emit regression. Add E2E test exercising the full emit-through-collection path. |
| **Security fix merged** | Add to `test/security.test.js` or `test/regression/` with P1 priority. Security regressions must be caught at the commit level. |
| **Dependency updated** | Run full P0-P4 suite. If new edge cases are discovered, add targeted tests. For `isolated-vm` updates specifically, re-run sandbox escape tests and memory limit tests. |

### 5.2 Removing or Updating Tests

| Event | Action |
|-------|--------|
| **Feature removed** | Remove associated regression tests. Document removal in the test's commit message with rationale. |
| **API signature changed** | Update test inputs/assertions to match new signatures. Do NOT simply delete the test -- the underlying behavior it validates likely still needs coverage. |
| **Test consistently flaky** | Investigate root cause (timing dependency, resource contention, non-deterministic isolate behavior). Fix the test, do not remove it. If unfixable, quarantine to a `test/quarantine/` directory with a tracking issue. |
| **Redundant with newer test** | Remove the older, narrower test only if the newer test provably covers the same failure mode. Document the replacement. |

### 5.3 Regression Test Review Checklist

Every PR that modifies `xchain-vm/src/` should include a review step:

- [ ] All existing regression tests pass (CI enforced)
- [ ] If fixing a bug: regression test added in `test/regression/`
- [ ] If changing security-critical code (`sandbox.js`, `metering.js`, `gas.js`, `index.js` error paths): security regression tests reviewed for coverage gaps
- [ ] If adding/modifying an ACTION emit type: gateway-emit regression tests updated
- [ ] If changing gas costs or limits: boundary tests updated to reflect new values
- [ ] No tests were deleted without documented rationale

### 5.4 Tracking & Reporting

**CI Dashboard Metrics:**

| Metric | Target | Alert Threshold |
|--------|--------|-----------------|
| Regression pass rate | 100% | Any failure blocks merge |
| P0+P1 execution time | < 35s | > 60s triggers investigation |
| Full regression execution time | < 5 min | > 8 min triggers optimization review |
| Bug regression test count | Monotonically increasing | Decrease without documented removal triggers review |
| Flaky test rate | 0% | Any flake triggers immediate investigation |

**Failure Management Process:**

1. **Regression failure on PR**: PR is blocked. Author investigates. If the failure is a true regression, the PR must fix it before merge. If the failure is a test bug, the test is fixed in the same PR.
2. **Regression failure on nightly**: Filed as a P1 issue. Assigned to the author of the most recent commit touching the failing module. Must be resolved within 24 hours.
3. **Regression failure on release gate**: Release is blocked until resolved. No exceptions.

### 5.5 Ownership

- **Suite curator**: The developer who owns the `xchain-vm` module is responsible for regression suite health.
- **Contributors**: Any developer modifying VM source code is responsible for ensuring regression tests pass and adding bug-fix regressions.
- **Quarterly review**: Every quarter, review the regression suite for:
  - Tests that no longer exercise relevant code paths (dead tests)
  - Missing coverage for features that have stabilized since last review
  - Execution time trends and optimization opportunities
  - Flaky test patterns

---

## 6. Relationship to Other Test Phases

The regression suite does not duplicate other test phases -- it **curates from them**. Each phase contributes tests to the regression suite based on the selection criteria in Section 3.

### 6.1 Integration Map

```
                        REGRESSION SUITE
                    (curated selection gate)
                              |
        +---------+-----------+-----------+-----------+
        |         |           |           |           |
      Smoke    Unit      Integration   Security    E2E
      tests    tests       tests       tests      tests
   (all P0)  (core P2)  (critical   (all P1)  (critical
              (medium     P3)                   path P3)
               P2)

                    Run on schedule only:
              +----------+-----------+----------+
              |          |           |          |
            Fuzz      Chaos      Boundary   Mutation
           (nightly) (nightly)   (PR+)     (release)
```

### 6.2 Phase-by-Phase Relationship

#### Unit Tests (ref: XCHAIN_VM_UNIT_TESTING_PLAN.md)
- **Contribution to regression**: Core unit tests for all 13 source modules are included at P2 priority. Pure-function tests (gas, math, collector, errors) are lightweight and always included.
- **Shared infrastructure**: Same Mocha framework, same assertion patterns, same test contract fixtures in `test/contracts/`.
- **Distinction**: The unit test plan covers exhaustive input/output combinations. The regression suite selects the critical subset that guards against the most impactful breakage.

#### Integration Tests (ref: test/index.test.js, test/isolate.test.js)
- **Contribution to regression**: Full-pipeline tests (code -> metering -> isolate -> execution -> result) are included at P3 priority. These catch regressions at module boundaries that unit tests miss.
- **Shared infrastructure**: Reuses the `XChainVM` instantiation patterns and test contract fixtures.
- **Distinction**: Integration tests explore many code-path combinations. The regression suite focuses on the happy path and the most critical error paths (gas exhaustion, revert atomicity, sandbox violation).

#### E2E Tests (ref: XCHAIN_VM_E2E_TESTING_PLAN.md)
- **Contribution to regression**: Four critical-path E2E tests included at P3 priority: deploy-execute lifecycle, state persistence, security constraints, and determinism verification.
- **Shared infrastructure**: Same E2E test helpers, same contract deployment patterns, same state simulation approach.
- **Distinction**: The full E2E suite (10 files) includes exploratory scenarios (complex workflows, oracle interactions, gas fee edge cases) that are valuable but too slow for commit-level regression. These run nightly.

#### Security Tests (ref: XCHAIN_VM_SECURITY_AUDIT_PLAN.md)
- **Contribution to regression**: ALL security tests are included at P1 priority. Security is non-negotiable in the regression suite.
- **Shared infrastructure**: Same sandbox escape contracts (`test/contracts/sandbox_escape.js`), same resource exhaustion fixtures.
- **Distinction**: The security audit plan includes manual review procedures and threat modeling. The regression suite automates the verifiable subset.

#### Boundary Tests (ref: XCHAIN_VM_BOUNDARY_TESTING_PLAN.md)
- **Contribution to regression**: Included at P3 priority for PR-level regression. Tests exercise every configured limit at its exact boundary value.
- **Shared infrastructure**: Same limit constants derived from VM configuration, same assertion patterns.
- **Distinction**: Boundary tests are comprehensive but slow due to large-state and large-code scenarios. The regression suite includes them at PR level but not at commit level.

#### Smoke Tests (ref: XCHAIN_VM_SMOKE_TESTING_PLAN.md)
- **Contribution to regression**: ALL smoke tests are included at P0 priority. They are the first gate.
- **Shared infrastructure**: Smoke tests are a strict subset of the regression suite.
- **Distinction**: None -- smoke tests exist specifically to be the regression suite's first tier.

#### Fuzz Tests (ref: XCHAIN_VM_FUZZ_TESTING_PLAN.md)
- **Contribution to regression**: Excluded from commit/PR regression due to non-determinism and execution time. Included in nightly regression runs.
- **Shared infrastructure**: Fuzz harness (`test/fuzz/harness.js`), invariant checks (`test/fuzz/invariants.js`), and generators (`test/fuzz/generators/`) are reusable for creating targeted regression tests when fuzz runs discover bugs.
- **Distinction**: Fuzz testing explores unknown failure modes. When a fuzz run finds a bug, the minimal reproducer becomes a regression test (deterministic, fast, added to `test/regression/`).

#### Chaos Tests (ref: XCHAIN_VM_CHAOS_ENGINEERING_PLAN.md)
- **Contribution to regression**: Phase 1 (basic failure injection) included in nightly regression. Phases 2-3 are pre-release only.
- **Shared infrastructure**: Chaos test helpers and failure injection patterns can inform regression test design for error handling paths.
- **Distinction**: Chaos tests explore system resilience under abnormal conditions. Regression tests verify correct behavior under normal and previously-observed abnormal conditions.

#### Mutation Tests (ref: XCHAIN_VM_MUTATION_TESTING_PLAN.md)
- **Contribution to regression**: Not part of the regression suite itself. Instead, mutation testing is used to **validate the regression suite's effectiveness**. A surviving mutation in a Critical-tier module indicates a regression suite gap that must be filled.
- **Shared infrastructure**: Same test suite is the system under test.
- **Distinction**: Mutation testing is a meta-test -- it tests the tests. Run on release schedule to ensure regression suite quality remains high.

### 6.3 Feedback Loop

```
Fuzz/Chaos discovers bug
        |
        v
Minimal reproducer extracted
        |
        v
Bug fixed, reproducer added to test/regression/
        |
        v
Regression suite grows
        |
        v
Mutation testing validates coverage
        |
        v
Surviving mutations identify gaps
        |
        v
New targeted tests written
        |
        v
Regression suite strengthened
```

This virtuous cycle ensures the regression suite continuously improves as the VM evolves.

---

## 7. Implementation Roadmap

### Phase 1: Foundation (Immediate)

1. Create `test/regression/` directory for bug-fix regression tests.
2. Add `test:regression:*` npm scripts to `package.json` (see Section 4.2).
3. Tag existing tests with priority tiers (P0-P4) using naming conventions.
4. Verify that all smoke + security tests pass as the initial P0+P1 regression baseline.
5. Document the isolated-vm availability check to fail loudly (not skip) in regression mode.

### Phase 2: CI Integration (Week 1-2)

1. Add P0+P1 regression as a required CI check on all PRs touching `xchain-vm/src/`.
2. Add full regression (P0-P3) as a required CI check before merge.
3. Configure nightly CI job running P0-P4 + fuzz + chaos phase 1.
4. Set up regression pass rate and execution time dashboards.

### Phase 3: Process & Culture (Week 2-4)

1. Add regression test review checklist to PR template (Section 5.3).
2. Establish the bug-fix regression test requirement as a merge policy.
3. Run initial mutation testing pass against the regression suite to identify coverage gaps.
4. Fill identified gaps with targeted regression tests.

### Phase 4: Optimization & Maturity (Ongoing)

1. Profile and optimize slow regression tests to meet time targets.
2. Implement parallel execution for compatible test groups.
3. Establish quarterly regression suite review cadence.
4. Record performance baselines and add performance regression tracking.

---

## 8. Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| Regression suite becomes too slow, developers bypass it | Regressions reach main branch | Strict time budgets per tier; parallel execution; CI enforcement (cannot bypass) |
| Flaky tests erode trust in the suite | Developers ignore failures | Zero-flake policy; immediate investigation; quarantine with tracking issue |
| Bug-fix regressions not written | Same bugs reappear | Merge policy requires regression test for every bug fix; PR checklist enforced |
| Regression suite grows stale (tests for removed features) | False confidence, wasted time | Quarterly review; test-to-source traceability via tags |
| isolated-vm silent skip in CI | Entire VM test suite appears to pass with zero coverage | Fail-loudly check at suite entry; CI environment verification |
| Security regression missed | Host compromise or consensus break | All security tests at P1 (commit-level); security fixes require P1 regression test |
| Non-determinism in test environment | False failures or false passes | Pin Node.js version; pin OS; no time-dependent assertions; determinism verification tests |

---

## 9. Success Criteria

The regression testing strategy is successful when:

1. **Zero regressions escape to release** -- no bug that was previously fixed reappears in a release.
2. **100% regression pass rate on main branch** -- the suite never has persistent failures.
3. **< 35 second commit-level feedback** -- developers get P0+P1 results before context-switching.
4. **< 5 minute PR-level feedback** -- full regression completes within a reasonable review cycle.
5. **Monotonically growing bug-fix regression count** -- every fixed bug adds a permanent guard.
6. **> 95% mutation kill rate** on Critical-tier modules when validated by mutation testing.
7. **Zero flaky tests** -- the suite is deterministic and trustworthy.
