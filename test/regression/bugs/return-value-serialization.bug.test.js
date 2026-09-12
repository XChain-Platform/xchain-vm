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
 * [BUG] null, object and array return values did not cross the isolate
 *
 * Return values were handed across the isolate boundary unserialised,
 * so anything that was not a primitive was lost or threw. Two related
 * defects rode along: a contract string could collide with the internal
 * protocol marker, and the marker itself was trusted for error
 * classification. All three were fixed by JSON-encoding the bridged
 * value.
 *
 * Witness: every JSON-representable return shape round-trips, and a
 * contract string that looks like an internal marker comes back as
 * data rather than changing the result's verdict.
 *
 * Run: npm run test:regression:bugfix
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const { createVM, execute } = require('../helpers.js');

describe('[BUG] contract return values are JSON-bridged', function() {

    let vm;
    before(function() { vm = createVM(); });

    const shapes = [
        ['null',            'null',                      null],
        ['an object',       '({ a: 1, b: "two" })',      { a: 1, b: 'two' }],
        ['a nested object', '({ a: { b: [1, 2] } })',    { a: { b: [1, 2] } }],
        ['an array',        '[1, "two", null]',          [1, 'two', null]],
        ['an empty array',  '[]',                        []],
        ['a boolean',       'false',                     false],
        ['zero',            '0',                         0],
        ['an empty string', '""',                        '']
    ];

    for (const [label, expression, expected] of shapes) {
        it(`round-trips ${label}`, async function() {
            this.timeout(30000);
            const r = await execute(vm,
                `module.exports = function(xchain) { return ${expression}; };`);
            assert.strictEqual(r.success, true, r.error);
            assert.deepStrictEqual(JSON.parse(r.returnValue), expected);
        });
    }

    it('returns a marker-shaped string as data, not as a verdict', async function() {
        this.timeout(30000);
        const marker = '__XCHAIN_REVERT__: not a real revert';
        const r = await execute(vm,
            `module.exports = function(xchain) { return ${JSON.stringify(marker)}; };`);
        assert.strictEqual(r.success, true,
            'a contract string that mimics an internal marker must not be read as a revert');
        assert.strictEqual(JSON.parse(r.returnValue), marker);
        assert.strictEqual(r.error, null);
    });
});
