#!/usr/bin/env bash
#*********************************************************************
#
# Copyright © 2025-2026 Dankest, LLC
# Based on XChain Platform by Dankest, LLC - https://dankest.llc
#
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# This file is part of XChain Platform. Licensed under the GNU Affero
# General Public License v3.0 or later; see LICENSE.md. A commercial
# license (without AGPL source-disclosure terms) is available -
# contact legal@dankest.llc.
#
#*********************************************************************

#
# bin/ci-full.sh: run EVERY tier this repo's GitHub CI runs, in one process.
#
# .github/workflows/ci.yml fans this repo out as two jobs (ci, coverage). The
# ci job calls the shared XChain-Platform/.github ci-reusable.yml workflow
# (checks out this repo's .ci-siblings, then `npm run ci`); the coverage job
# (needs: ci) checks out the same siblings again and re-runs the unit suite
# under c8 against the floor in bin/coverage-thresholds.json. The pre-push
# venue gate used to run only `npm run ci`, so a push could gate green locally
# and then go red on GitHub on the coverage ratchet the gate never ran. This
# script IS the local twin of the workflow: every job's run-steps,
# transcribed, in job order. When ci.yml gains or changes a job, change this
# script in the same commit.
#
# Layout: siblings resolve at ../<repo>, which is both the platform monorepo
# layout and the venue gate's work/ layout (.ci-siblings ships them there). A
# sibling a GitHub job checks out is REQUIRED here: missing means fail loud,
# never skip, because GitHub will run the step this gate would be skipping.
#
# No database: this repo's suites (isolated-vm sandbox, gas metering,
# determinism, lint parity) are pure JS/JS-in-a-V8-isolate; neither ci.yml job
# wires a DB service container, so this script sets none.
#
# All tiers run even after one fails (GitHub reports every red job, so this
# reports every red tier); the exit code is red if any tier was.
#
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
SELF="$(pwd)"
SIB="$(cd .. && pwd)"

FAILED=""
# >>> ci-tier (generated block; re-run the tier wirer to update) >>>
# Tier classes. A push grades the FAST tier only: the unit job, the pin and
# drift guards, and the structure and hygiene checks the hook runs before it
# dispatches. The tiers named below (coverage re-runs, perf scenarios) are
# skipped when the gate sets CI_TIER=fast, and each skip is recorded so the
# closing verdict can never claim a green it did not earn. Nothing stops
# being graded: a scheduled sweep re-runs this same script with CI_TIER=full
# on every repo every three hours and before any release or deploy, and a
# red there is tracked down and fixed first. CI_TIER is unset for a hand
# run, so a bare `npm run ci:full` still runs every tier as it always did.
CI_TIER_FULL_ONLY=(
  "coverage ratchet (coverage:check)"
  "subprocess coverage (coverage:subprocess)"
)
DEFERRED=""
ci_tier_deferred() {
  [ "${CI_TIER:-full}" = "fast" ] || return 1
  local t
  for t in ${CI_TIER_FULL_ONLY[@]+"${CI_TIER_FULL_ONLY[@]}"}; do
    if [ "$t" = "$1" ]; then
      DEFERRED="$DEFERRED [$1]"
      echo; echo "ci:full ===== $1 DEFERRED (CI_TIER=fast, runs in the full sweep) ====="
      return 0
    fi
  done
  return 1
}
# <<< ci-tier <<<
# >>> ci-tier timer (generated block; re-run the tier wirer to update) >>>
run_tier() {
  ci_tier_deferred "$1" && return 0  # ci-tier guard (generated)
  local name="$1"; shift
  local __ci_tier_t0=$SECONDS
  echo; echo "ci:full ===== $name ====="
  if "$@"; then
    echo "ci:full ----- $name PASS ($(( SECONDS - __ci_tier_t0 ))s)"
  else
    FAILED="$FAILED [$name]"
    echo "ci:full ----- $name FAIL ($(( SECONDS - __ci_tier_t0 ))s)"
  fi
}
# <<< ci-tier timer <<<
need_sib() {
  local s
  for s in "$@"; do
    if [ ! -d "$SIB/$s" ]; then
      echo "ci:full: MISSING SIBLING $SIB/$s" >&2
      echo "ci:full: GitHub CI checks this sibling out and runs steps against it," >&2
      echo "ci:full: so skipping here would gate green on a subset. Declare it in" >&2
      echo "ci:full: .ci-siblings (venue) or clone it beside this repo (hand run)." >&2
      exit 1
    fi
  done
}

need_sib xchain-documentation xchain-indexer xchain-sdk xchain-contracts

# --- job: ci (XChain-Platform/.github ci-reusable.yml -> npm run ci) -------
# The reusable workflow's `test` job checks out every sibling this repo's
# .ci-siblings declares and, once it has, runs the gate with
# XCHAIN_REQUIRE_SIBLINGS=1 so a guard that would otherwise silently skip on a
# missing sibling (xcall-constants-cross-repo, lint-parity, sibling-coverage)
# fails loud instead. need_sib above already guarantees the siblings are
# present, so this env var is what turns that presence into strict enforcement
# the same way GitHub's run does.
run_tier "ci" env XCHAIN_REQUIRE_SIBLINGS=1 npm run ci

# --- identity pin (this gate only; no ci.yml job runs it) --------------------
# bin/pins/identity.json holds the sha256 of the lint trio the sdk vendors.
# bin/pin_identity.js re-hashes the tree against it and refuses a moved byte, a
# dead path, or an entry dropped from or added to the set it declares. A
# missing pin or tool fails the tier by name instead of reading as a pass.
identity_pin_check() {
  local f
  for f in bin/pins/identity.json bin/pin_identity.js; do
    if [ ! -f "$f" ]; then echo "ci:full: identity pin tier: $f is missing" >&2; return 1; fi
  done
  node bin/pin_identity.js --compare bin/pins/identity.json
}
run_tier "identity pin (vendored lint trio)" identity_pin_check

# --- job: coverage (coverage:check, needs: ci) ------------------------------
# Coverage ratchet: re-runs the unit suite under c8 and fails if line,
# statement, branch, or function coverage drops below this repo's floor. The
# workflow re-checks the same .ci-siblings roster out fresh for this job (the
# ratchet reruns the unit suite, which needs them too); on this venue the
# already-present sibling pair from the tier above is that same checkout.
# GitHub does not set XCHAIN_REQUIRE_SIBLINGS for this job, so neither does
# this tier.
run_tier "coverage ratchet (coverage:check)" npm run coverage:check
run_tier "subprocess coverage (coverage:subprocess)" npm run coverage:subprocess

echo
# >>> ci-tier summary (generated) >>>
echo "ci:full: tier class ${CI_TIER:-full}"
if [ -n "${DEFERRED:-}" ]; then
  echo "ci:full: DEFERRED to the full sweep:$DEFERRED"
fi
# <<< ci-tier summary <<<
if [ -n "$FAILED" ]; then
  echo "ci:full: RED tiers:$FAILED"
  exit 1
fi
# >>> ci-tier verdict (generated) >>>
if [ "${CI_TIER:-full}" = "fast" ]; then
  echo "ci:full: all FAST tiers green; the DEFERRED tiers above were NOT graded here"
else
  echo "ci:full: all tiers green (same set GitHub CI runs)"
fi
# <<< ci-tier verdict <<<
