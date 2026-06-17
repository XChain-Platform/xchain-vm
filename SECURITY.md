# Security Policy

`xchain-vm` is the deterministic smart-contract execution engine for the XChain Platform. It runs untrusted contract code inside V8 sandboxed isolates (via `isolated-vm`). This is the highest-severity surface in the platform: a sandbox escape, a determinism break, or a gas-metering bypass would affect every validator and every contract execution across the fleet. We treat reports here with maximum urgency.

If you've found a security issue, please **do not open a public issue or pull request**. Use the private channels below.

---

## How to report

### Preferred: GitHub Private Vulnerability Reporting

Open a draft advisory at:

<https://github.com/XChain-platform/xchain-vm/security/advisories/new>

This is the fastest path. The advisory is private until we publish it.

### Alternative: Email

Email **security@dankest.llc** with:

- A description of the issue and the threat it poses.
- Reproduction steps or a proof-of-concept (a contract payload, isolate invocation, or gas-metering bypass that triggers the bug).
- The affected version (see `CHANGELOG.md` and the version badge in `README.md`) and the environment you tested against (Node.js version, platform, regtest/testnet/mainnet if applicable).
- Any patches or mitigations you'd like considered.

For sensitive reports, encrypt the email body to our PGP key. The fingerprint will be published alongside the first signed release artifact; until then, the email channel is acceptable for first contact and we will coordinate an encrypted exchange before you share proof-of-concept details.

We do not currently offer a paid bug bounty. We do offer public credit in release notes and the advisory itself, unless you prefer to remain anonymous.

---

## Response timeline

| Stage | Target |
|---|---|
| Initial acknowledgement | within 72 hours |
| Triage + severity assignment | within 7 days |
| Fix or mitigation in master | within 30 days for high/critical, 90 days for lower severities |
| Coordinated public disclosure | up to 90 days from initial report, or sooner if a fix has shipped and operators are protected |

If we cannot meet a timeline, we will tell you why and propose a new one. We will not silently let a report age.

---

## Scope

### In scope

- **Sandbox escape** (the crown-jewel target): any path by which untrusted contract code reaches host process state, the filesystem, the network, or any object outside the isolate.
- **Determinism breaks**: nondeterminism in the execution pipeline (`src/metering.js`, `src/sandbox.js`, `src/gateway.js`, `src/gateway-emit.js`, `src/math.js`, `src/state.js`) that would cause two correct validator nodes to compute different state from identical input.
- **Gas-metering bypass**: any contract construct that executes unbounded computation without charging gas, allowing infinite loops, CPU exhaustion, or denial-of-service against the indexer.
- **Resource-limit bypasses**: memory exhaustion, emission-count bypass, state-key-count bypass, code-size bypass, or wall-clock timeout bypass from within the isolate.
- **The contract gateway and emit surface** (`src/gateway.js`, `src/gateway-emit.js`): any path where a contract can emit an action it should not be able to emit, or manipulate host-side emission state.
- **Cross-contract call surface** (`emit.execute`): depth-limit bypass, gas-accounting errors, or state-isolation failures between caller and callee.
- **The `xchain-lint` binary** (`bin/lint.js`): any path by which linting untrusted contract code leads to code execution on the linting host.
- **Information leakage**: any path where contract code reads host-process memory, environment variables, or state belonging to another contract's isolate.

### Out of scope

- Bugs in individual user contracts (that is the contract author's issue, not a VM vulnerability) unless the VM failed to contain them.
- Indexer logic that calls the VM (report against `xchain-indexer` unless the root cause is inside the VM itself).
- Vulnerabilities in the upstream `isolated-vm` native module; report those to the `isolated-vm` maintainers, though we still want to hear about them so we can track mitigations.
- Misconfiguration of the operator's host (memory limits, ulimits, Docker isolation) rather than a flaw in this codebase.
- Attacks that require the operator's shell access to the indexer host.

If you are unsure, send the report anyway and we will tell you whether it falls in scope.

---

## What we ask

- Give us a reasonable window to fix before disclosing publicly. The 90-day ceiling is firm; earlier is fine once a fix has shipped and operators are protected.
- Test against `regtest` where possible. For sandbox-escape or determinism proofs, a self-contained contract payload and Node.js reproduction script is sufficient and preferred.
- Do not run automated scanners against shared XChain infrastructure in a way that would impact availability for other operators.
- Do not access data, or attempt to access data, beyond what is needed to demonstrate the issue.

---

## What we will do

- Confirm receipt within the SLA above.
- Keep you informed as triage and remediation proceed.
- Credit you in the advisory and `CHANGELOG.md` entry, on request.
- Coordinate a CVE assignment when the severity warrants it.
- Publish a post-fix advisory describing the issue, the fix, and the affected version range.

---

## Versions covered

We ship security fixes against the latest release on `master`. Older releases are unsupported. The current version is recorded in `CHANGELOG.md` and the badge in `README.md`.

---

Last reviewed: 2026-06-16.
