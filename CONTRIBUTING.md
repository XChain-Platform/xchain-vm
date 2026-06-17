# Contributing to XChain VM

Thanks for considering a contribution. `xchain-vm` runs untrusted smart-contract code inside V8 sandboxed isolates and must produce byte-identical results on every validator in the fleet. Correctness, determinism, and sandbox integrity take priority over every other concern.

If you're reporting a security issue, **stop here** and read [`SECURITY.md`](./SECURITY.md) instead. Security reports go through a private channel.

---

## Quick links

- Project overview: [`README.md`](./README.md)
- Full component docs: the [`xchain-documentation`](https://github.com/XChain-platform/xchain-documentation) repository (VM architecture, contract model, gas schedule, protocol actions)
- Disclosure policy: [`SECURITY.md`](./SECURITY.md)
- Code of Conduct: [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md)
- License: [`LICENSE.md`](./LICENSE.md) + [`NOTICE.md`](./NOTICE.md) (GNU Affero General Public License v3.0, dual-licensed)

---

## Repo layout in 30 seconds

```
xchain-vm/
├── bin/                  xchain-lint CLI entry point
├── src/                  VM core: isolate, sandbox, gateway, metering, gas, math, state, ...
├── test/                 layered suites (unit, security, boundary, determinism, e2e, fuzz, chaos, regression)
├── bench/                benchmark scenarios and harness
├── CHANGELOG.md          authoritative version history
├── SECURITY.md           private vulnerability disclosure
└── package.json          scripts + dependencies
```

---

## Setting up

### Prerequisites

- **Node.js 22 exactly.** The platform pins Node 22 fleet-wide: the `mariadb` driver (used by the indexer that embeds this library) is ESM-only and fails on Node 18 with `ERR_REQUIRE_ESM`; Node 24 cannot build the `isolated-vm` native binding against its V8 ABI. Use Node 22. A `.nvmrc` is provided.
- **`isolated-vm` is a native C++ module** whose binding is V8-ABI-specific. After switching Node versions (including a minor bump), you must rebuild it:

  ```bash
  npm rebuild isolated-vm --build-from-source
  ```

  On Ubuntu/Debian, install build dependencies first:

  ```bash
  sudo apt-get install -y build-essential python3 libnghttp2-dev libicu-dev libbrotli-dev libc-ares-dev
  ```

  On macOS, Xcode command-line tools are sufficient (`xcode-select --install`).

### First-time install

```bash
git clone https://github.com/XChain-platform/xchain-vm.git
cd xchain-vm
npm install
```

No database or external service is required for the unit, security, boundary, determinism, regression, fuzz, or chaos tiers.

---

## Running it

`xchain-vm` is a library, not a standalone server. It is consumed by `xchain-indexer`. For ad-hoc experiments, require it directly:

```bash
node -e "const XChainVM = require('.'); console.log(new XChainVM({ gasSchedule: {}, gasCeiling: 1000 }));"
```

The `xchain-lint` CLI runs deploy-time syntax and float-detection checks:

```bash
npm run lint              # runs bin/lint.js (xchain-lint)
```

---

## Tests

The VM runs a deep, layered suite. Pick the tier that matches your change:

| Tier | Command | Needs external services |
|---|---|---|
| Smoke | `npm run smoke` | No |
| Unit | `npm test` | No |
| Security | `npm run test:security` | No |
| Boundary | `npm run test:boundary` | No |
| Determinism | `npm run test:determinism` | No |
| CI gate | `npm run ci` | No |
| Integration | `npm run test:integration` | No |
| End-to-end | `npm run test:e2e` | No |
| Fuzz | `npm run test:fuzz` | No |
| Chaos | `npm run test:chaos` | No |
| Regression (P0 smoke) | `npm run test:regression:smoke` | No |
| Regression (P0+P1) | `npm run test:regression:core` | No |
| Regression (full) | `npm run test:regression:full` | No |

Run at minimum `npm run ci` before every commit; it covers unit, smoke, security, boundary, determinism, and the P0/P1 regression tiers without external dependencies. New sandbox, metering, or gas logic should include `test:security` and `test:fuzz` coverage, since every contract payload is attacker-controlled. New execution paths should include `test:determinism` coverage, since every validator must produce identical output.

`test/preflight.test.js` is included automatically in most commands; it checks that `isolated-vm` compiled correctly for the running Node version and fails fast if the native binding is stale.

---

## Coding style

- **Plain JavaScript**, no TypeScript. No ORM.
- **No linter is configured.** Match the style of the surrounding file: naming, structure, and comment density.
- **Comments are rare on purpose.** Don't restate what well-named code already says. Do comment a *why* that isn't obvious: a hidden invariant, a consensus-relevant constraint, a workaround with a reference.
- **Never use the em-dash character** in code, comments, or docs. Rewrite the sentence (a comma, colon, or parentheses) instead.
- **Two trailing spaces** on consecutive bold-label markdown lines so CommonMark renders the line break instead of collapsing them.
- **Determinism is non-negotiable.** The VM must produce byte-identical results on every validator. Do not introduce wall-clock time, `Math.random`, locale-dependent formatting, iteration order assumptions, or any other nondeterminism in `src/`. The `check:consensus-time` guard (and the `test:determinism` suite) exist to catch this; make sure your change passes both.

---

## Commit messages

Match the existing log style: a concise subject line, then a short body explaining what changed and why.

- Branch off `master` and keep history linear (rebase, don't merge).
- One logical change per commit; don't batch unrelated work.
- **No `Co-Authored-By` trailers.** This is a project policy.
- **Never `--no-verify`.** If a hook fails, fix the cause; don't bypass it.

---

## Pull requests

CI is the smoke + unit gate. Before opening a PR:

1. Run the no-external-services tiers (`npm run ci`, `npm run test:security`, `npm run test:determinism`) and confirm they pass.
2. Update `CHANGELOG.md` with a terse entry for your change.
3. Make sure `git status` is clean apart from intended changes (no `node_modules/`, no editor leftovers, no `.env`).
4. Open the PR with a clear title and a description of what changed and why.

For non-security bugs, open an issue at <https://github.com/XChain-platform/xchain-vm/issues/new>. For security bugs, see [`SECURITY.md`](./SECURITY.md).

---

## Code of Conduct

We follow our [Code of Conduct](./CODE_OF_CONDUCT.md), adapted from the Contributor Covenant 2.1. Be kind, assume good faith, and disagree without being a jerk.

---

Last reviewed: 2026-06-16.
