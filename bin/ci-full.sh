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
run_tier() {
  local name="$1"; shift
  echo; echo "ci:full ===== $name ====="
  if "$@"; then
    echo "ci:full ----- $name PASS"
  else
    FAILED="$FAILED [$name]"
    echo "ci:full ----- $name FAIL"
  fi
}
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

# --- job: coverage (coverage:check, needs: ci) ------------------------------
# Coverage ratchet: re-runs the unit suite under c8 and fails if line,
# statement, branch, or function coverage drops below this repo's floor. The
# workflow re-checks the same .ci-siblings roster out fresh for this job (the
# ratchet reruns the unit suite, which needs them too); on this venue the
# already-present sibling pair from the tier above is that same checkout.
# GitHub does not set XCHAIN_REQUIRE_SIBLINGS for this job, so neither does
# this tier.
run_tier "coverage ratchet (coverage:check)" npm run coverage:check

echo
if [ -n "$FAILED" ]; then
  echo "ci:full: RED tiers:$FAILED"
  exit 1
fi
echo "ci:full: all tiers green (same set GitHub CI runs)"
