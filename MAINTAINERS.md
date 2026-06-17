# Maintainers

This file lists the people responsible for `xchain-vm`, what each of them owns, and how to escalate issues that need a human's attention beyond what `CONTRIBUTING.md` and `SECURITY.md` cover.

The XChain Platform is in pre-launch development and ships under a single primary maintainer today. As contributors take on durable responsibility for areas of the codebase, they will be added here. This is a conventional MAINTAINERS file (an open-source norm used by distros and downstream packagers), not an aspirational org chart.

---

## Primary maintainer

| Role | Name | GitHub | Areas |
|---|---|---|---|
| Lead | J-Dog | [@J-Dog](https://github.com/J-Dog) | Everything: the V8 isolate sandbox, gas metering, the contract gateway, determinism, the lint tool, releases |

Contact:

- General and non-sensitive: open an issue at <https://github.com/XChain-platform/xchain-vm/issues>.
- Code of Conduct: `conduct@dankest.llc` (per `CODE_OF_CONDUCT.md`).
- Security disclosures: GitHub Private Vulnerability Reporting, or `security@dankest.llc` (per `SECURITY.md`).

---

## Areas of responsibility

Until additional maintainers join, the lead owns every area below. The table is here so a future contributor (or downstream packager) can see what each area entails when scoping a contribution.

| Area | What it covers |
|---|---|
| V8 isolate sandbox | `isolate.js`, `sandbox.js`, `vm-worker.js`, `process-executor.js`: isolate lifecycle, non-deterministic API stripping, cross-process execution |
| Gas metering | `gas.js`, `metering.js`: AST injection of `__gas()` calls via acorn/astring, ceiling enforcement, computation charges |
| Contract gateway | `gateway.js`, `gateway-emit.js`, `validator.js`, `readonly-accessors.js`: the `xchain` object exposed inside isolates, emit API (17 action types including cross-contract `emit.execute`), action validation |
| Determinism and runtime | `index.js`, `consensus-runtime.js`: the `XChainVM` class, per-block compilation cache, determinism guarantees across indexer nodes |
| State management | `state.js`: key-value state, dirty tracking, key count and value size limits |
| Math | `math.js`: deterministic bignumber arithmetic wrapping mathjs, string I/O |
| Deploy-time lint and syntax | `syntax.js`, `lint.js`, `lint-core.js`: syntax checking, reserved identifier detection, float usage warnings |
| Errors | `errors.js`: `ContractRevertError`, `GasExhaustedError` |
| Tests | The layered suites under `test/` (unit, e2e, fuzz, chaos, regression, security, boundary) and fixture contracts in `test/contracts/` |
| Documentation | `README`, `SECURITY`, `CODE_OF_CONDUCT`, `CONTRIBUTING`, `MAINTAINERS`, `CHANGELOG` |

---

## Adding a maintainer

A contributor becomes a maintainer when they have:

1. Sustained contribution in a specific area for at least one release cycle (typically 2 to 3 weeks of active work).
2. Reviewed and merged at least three PRs from outside contributors.
3. Demonstrated awareness of the project's conventions: Node 22 is mandatory (isolated-vm is a native C++ module and must be rebuilt after any Node version change via `npm rebuild isolated-vm --build-from-source`; the sandbox and security test suites silently skip on other versions), all execution paths must be deterministic (no wall-clock time, no `Math.random`, no non-deterministic globals inside contract context), and mocha preflight must pass before submitting a change to the sandbox or metering layers.

Open a PR adding the new maintainer to the table above with their GitHub handle and area(s) of responsibility. The lead approves and merges.

## Removing a maintainer

A maintainer steps down by opening a PR removing their row. The lead also removes a maintainer who has been inactive for six months or who violates the Code of Conduct, after a written notice period.

---

## Escalation paths

If you cannot reach the relevant area maintainer within a reasonable window:

| Situation | Escalate to |
|---|---|
| Active security incident | `security@dankest.llc` (per `SECURITY.md`) |
| A sandbox escape, a determinism break, or a gas-metering bypass | Open a public issue tagged `security` AND email `security@dankest.llc` |
| Code-of-conduct concern | `conduct@dankest.llc` (per `CODE_OF_CONDUCT.md`) |
| PR has been open without review for 14+ days | Comment `@J-Dog` on the PR; if no response within 7 more days, open an issue tagged `governance` with the PR link |

Sandbox escape is the highest-severity class of defect in this repository. Any finding that allows contract code to reach the host process, the filesystem, the network, or other isolates must be treated as a critical security incident and reported privately before any public disclosure.

---

## Decision-making

The lead makes final calls on:

- The sandbox security model and any change to the isolate boundary.
- Gas metering correctness and the gas model.
- Determinism guarantees: any new API or behavior exposed to contracts must be proven deterministic before merging.
- Release timing and version policy.
- Adopting a new heavy dependency.
- Code-of-conduct enforcement, and maintainer additions or removals.

Smaller calls (bug fixes, additions within an existing area, documentation, dependency bumps inside an existing minor) go through PR review by the area maintainer.

---

## Cross-project relationships

| Project | Relationship |
|---|---|
| [`xchain-indexer`](https://github.com/XChain-platform/xchain-indexer) | Invokes the VM for every DEPLOY and EXECUTE action; the indexer instantiates `XChainVM` and calls `vm.execute()` and `vm.validateSyntax()` |
| [`xchain-contracts`](https://github.com/XChain-platform/xchain-contracts) | Authors contract templates that run inside this VM; template correctness depends on the gateway surface and gas model exposed here |
| [`xchain-documentation`](https://github.com/XChain-platform/xchain-documentation) | Protocol spec: VM architecture, gas schedule, emittable action definitions, determinism requirements |

The VM maintainer is not automatically a maintainer of those sibling projects. Cross-project changes go through each project's own review process.
