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
 **********************************************************************
 * Regression: Deterministic Math Golden Values
 *
 * The contract math API (xchain.math.*) is the consensus-critical
 * arithmetic surface: every validator must compute bit-identical
 * results or state hashes diverge and the chain forks. The engine is
 * mathjs bignumber → decimal.js (pure-software decimal arithmetic,
 * architecture-independent (which is WHY native Math.sqrt/pow/log are
 * stripped from the sandbox, see src/sandbox.js).
 *
 * Architecture independence is guaranteed by decimal.js being pure JS.
 * The residual risk is VERSION drift: a different mathjs/decimal.js
 * build could round transcendentals differently. mathjs declares
 * decimal.js as `^10.4.3`, and the indexer (prod) lockfile and this
 * repo's lockfile have at times resolved to DIFFERENT patch versions
 * (10.4.3 vs 10.6.0) and currently agree bit-for-bit, but nothing
 * enforced it. This test is that enforcement: it freezes the exact
 * contract-facing output of every math op. If a dependency bump ever
 * changes a single digit, this fails loudly instead of silently
 * forking a live network.
 *
 * Values were captured at decimal.js 10.4.3/10.6.0 (verified identical)
 * via buildMathAPI(). Do NOT "fix" a failure by editing the expected
 * strings. A change here means the arithmetic engine changed, which is
 * a consensus event that must be reviewed deliberately.
 *
 * No isolate required: buildMathAPI() is pure host-side, so this runs
 * on any Node version.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const { buildMathAPI } = require('../../src/math.js');

describe('Regression: deterministic math golden values @regression @determinism', function() {
    const m = buildMathAPI();

    // [method, argA, argB|null, exactExpectedString]
    const GOLDEN = [
        ['sqrt',     '2',   null,  '1.414213562373095048801688724209698078569671875376948073176679738'],
        ['sqrt',     '3',   null,  '1.732050807568877293527446341505872366942805253810380628055806979'],
        ['pow',      '2',   '0.5', '1.414213562373095048801688724209698078569671875376948073176679738'],
        ['pow',      '10',  '3.5', '3162.277660168379331998893544432718533719555139325216826857504853'],
        ['log',      '2',   null,  '0.6931471805599453094172321214581765680755001343602552541206800095'],
        ['log',      '10',  null,  '2.302585092994045684017991454684364207601101488628772976033327901'],
        ['log2',     '1000',null,  '9.965784284662087043610958288468170527594494179073741836164269187'],
        ['log10',    '123456789', null, '8.091514977169270447518333623059547258515073338944666430292352231'],
        ['divide',   '1',   '3',   '0.3333333333333333333333333333333333333333333333333333333333333333'],
        ['divide',   '22',  '7',   '3.142857142857142857142857142857142857142857142857142857142857143'],
        // Decimal (not IEEE-754 float) arithmetic: proves no binary-float drift:
        ['multiply', '0.1', '0.2', '0.02'],
        ['add',      '0.1', '0.2', '0.3'],
    ];

    for (const [op, a, b, expected] of GOLDEN) {
        const label = `${op}(${a}${b !== null ? ', ' + b : ''})`;
        it(`${label} === golden`, function() {
            const actual = b !== null ? m[op](a, b) : m[op](a);
            assert.strictEqual(actual, expected,
                `Arithmetic engine output changed for ${label}. This is a consensus event, ` +
                `NOT a test to update. Check the mathjs/decimal.js version.`);
        });
    }

    it('repeated evaluation is stable within the same process', function() {
        for (let i = 0; i < 3; i++) {
            assert.strictEqual(m.divide('1', '3'),
                '0.3333333333333333333333333333333333333333333333333333333333333333');
        }
    });
});
