/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 ********************************************************************/

'use strict';

// ─── Performance: VM sandbox-INDEPENDENT hot paths ────────────────────────────
//
// The VM charges gas on every operation and runs every contract arithmetic op
// through the deterministic mathjs-bignumber API. Both are pure modules (no
// isolated-vm), so this suite runs on any Node. Deliberately, so it never hits
// the Node-22/isolated-vm "silent skip → false green" trap that affects the
// sandbox-execution suites. (Full in-isolate execution throughput belongs in a
// Node-22 perf run; this guards the metering + math hot paths that surround it.)
//
// Bounds are generous (≈40-50× headroom over observed speed) so they never flake
// on a loaded CI but DO catch a catastrophic regression (e.g. per-op allocation
// blow-up, an accidental O(n²), or a precision path that re-parses on every call).

const assert = require('assert');
const GasTracker = require('../../src/gas.js');
const { buildMathAPI } = require('../../src/math.js');

const ITERATIONS = parseInt(process.env.PERF_ITERATIONS, 10) || 50000;

// A complete, valid gas schedule (every canonical key present, cost 1).
const SCHEDULE = {};
for (const k of GasTracker.CANONICAL_GAS_KEYS) SCHEDULE[k] = 1;

function timeMs(fn) {
  const s = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - s) / 1e6;
}

function report(label, n, ms) {
  const ops = Math.round((n / ms) * 1000);
  // eslint-disable-next-line no-console -- perf tests print timing output to stdout
  console.log(`        ${label}: ${n.toLocaleString()} ops in ${ms.toFixed(1)}ms (${ops.toLocaleString()} ops/s)`);
}

describe('Performance: VM gas metering throughput', function () {
  this.timeout(60000);

  it(`charges gas ${ITERATIONS} times under the regression ceiling`, function () {
    // High ceiling so the run never trips GasExhaustedError.
    const tracker = new GasTracker(SCHEDULE, ITERATIONS * 10 + 1000);
    const ms = timeMs(() => {
      for (let i = 0; i < ITERATIONS; i++) tracker.chargeComputation();
    });
    report('gas charge', ITERATIONS, ms);
    assert.strictEqual(tracker.getUsed(), ITERATIONS, 'gas accounting drifted');
    assert.ok(ms < 2000 * (ITERATIONS / 50000), `gas metering too slow: ${ms.toFixed(1)}ms`);
  });

  it(`constructs ${Math.floor(ITERATIONS / 10)} GasTrackers (schedule validation) under ceiling`, function () {
    const n = Math.floor(ITERATIONS / 10);
    const ms = timeMs(() => {
      for (let i = 0; i < n; i++) new GasTracker(SCHEDULE, 1000);
    });
    report('GasTracker construct', n, ms);
    assert.ok(ms < 2000 * (n / 5000), `construction too slow: ${ms.toFixed(1)}ms`);
  });
});

describe('Performance: VM deterministic math throughput', function () {
  this.timeout(60000);

  it(`runs ${ITERATIONS} basic math ops (add/sub/mul/div/cmp) under ceiling`, function () {
    const math = buildMathAPI();
    const ms = timeMs(() => {
      for (let i = 0; i < ITERATIONS; i++) {
        const a = String((i % 9999) + 1) + '.123456789';
        const b = String((i % 777) + 1) + '.987654321';
        math.add(a, b);
        math.subtract(a, b);
        math.multiply(a, b);
        math.divide(a, b);
        math.compare(a, b);
      }
    });
    report('math basic (×5/iter)', ITERATIONS * 5, ms);
    // 5 bignumber ops/iter; generous ceiling vs observed.
    assert.ok(ms < 9000 * (ITERATIONS / 50000), `basic math too slow: ${ms.toFixed(1)}ms`);
  });

  it('transcendental ops (sqrt/pow/log) complete a bounded batch under ceiling', function () {
    const math = buildMathAPI();
    const n = Math.min(ITERATIONS, 5000); // transcendentals are heavier; cap the batch
    const ms = timeMs(() => {
      for (let i = 0; i < n; i++) {
        const a = String((i % 1000) + 1);
        math.sqrt(a);
        math.pow(a, '2');
        math.log(a);
      }
    });
    report('math transcendental (×3/iter)', n * 3, ms);
    assert.ok(ms < 20000 * (n / 5000), `transcendental math too slow: ${ms.toFixed(1)}ms`);
  });

  it('math API throughput does not degrade across repeated rebuilds', function () {
    // buildMathAPI() is called per execution context; rebuilding must stay cheap
    // (no growing closure/state). Compare first vs last batch of rebuild+use.
    const batch = 2000;
    function timeBatch() {
      return timeMs(() => {
        for (let i = 0; i < batch; i++) {
          const m = buildMathAPI();
          m.add('1.5', '2.5');
        }
      });
    }
    const first = timeBatch();
    for (let i = 0; i < 3; i++) timeBatch();
    const last = timeBatch();
    assert.ok(last < first * 5 + 50, `math rebuild degraded: first=${first.toFixed(1)}ms last=${last.toFixed(1)}ms`);
  });
});
