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
 * Syntax-depth determinism: with the activation on, the deploy verdict and the execute
 * outcome (gasUsed included) for the same source are the same cold and warm and at a
 * 400 KB and a 2000 KB V8 stack. Each reading is a fresh process so cold is cold.
 ********************************************************************/
'use strict';

const assert = require('assert');
const path = require('path');
const { execFileSync } = require('child_process');
const { measureSyntaxDepth, MAX_SYNTAX_DEPTH } = require('../../src/lint-core.js');
const { SHAPES, wrap } = require('./helpers/syntax_depth_shapes.js');

const PROBE = path.join(__dirname, 'helpers', 'syntax_depth_probe.js');

function reading(stackKb, shape, n) {
    const out = execFileSync(process.execPath, ['--stack-size=' + stackKb, PROBE, shape, String(n)],
        { encoding: 'utf8', env: process.env, maxBuffer: 1 << 20 });
    return JSON.parse(out.trim().split('\n').pop());
}

// The largest N a source of this shape can have and still be accepted.
function lastAcceptedN(shape) {
    let n = 1;
    while (measureSyntaxDepth(wrap(SHAPES[shape](n + 1))) <= MAX_SYNTAX_DEPTH) n++;
    return n;
}

// The stack_flip cases (refused far over the bound), and the deepest accepted source per shape.
const CASES = [['not', 1500], ['not', 2000], ['assign', 2000], ['ternary', 2000], ['plus', 2000],
    ['elseif', 2000], ['brackets', 700], ['arrow', 2000], ['calls', 2000]]
    .concat(Object.keys(SHAPES).map((shape) => [shape, lastAcceptedN(shape)]));

describe('syntax-depth verdicts do not depend on JIT warm-up or stack size', function () {
    this.timeout(600000);

    for (const [shape, n] of CASES) {
        it(shape + ' x' + n + ' reads the same cold, warm, at 400 KB and at 2000 KB', function () {
            const small = reading(400, shape, n);
            const large = reading(2000, shape, n);
            for (const r of [small, large]) {
                assert.strictEqual(r.deployWarm, r.deployCold, JSON.stringify(r));
                assert.deepStrictEqual(r.execWarm, r.execCold, JSON.stringify(r));
            }
            assert.deepStrictEqual(large, small);
            assert.doesNotMatch(JSON.stringify(small), /call stack|host fault/i);
            const accepted = measureSyntaxDepth(wrap(SHAPES[shape](n))) <= MAX_SYNTAX_DEPTH;
            assert.strictEqual(small.deployCold === 'valid', accepted, JSON.stringify(small));
        });
    }
});
