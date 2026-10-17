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
 * Legacy String and Number alias behavior below the receiver meter gate.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const { createVM, execute, XChainVM } = require('../../fuzz/helpers/harness.js');

const LENGTH = 120000;
const WALL_MS = 30000;
const MAINNET = {
    method: 'default',
    network: 'mainnet',
    blockContext: { height: 100, timestamp: 4000000000, hash: 'abc123' },
};
const BUILD = `var s=String(5).repeat(${LENGTH});`;
const wrap = (body) => `module.exports=function(){${BUILD}${body};return 1;};`;

(XChainVM ? describe : describe.skip)('String and Number aliases below the receiver meter gate', function () {
    this.timeout(60000);

    let vm;
    beforeEach(function () {
        vm = createVM({ gasCeiling: 10000000, maxCpuTimeMs: WALL_MS });
        vm.beginBlock();
    });
    afterEach(function () { if (vm && vm.endBlock) vm.endBlock(); });

    const run = (body) => execute(vm, wrap(body), MAINNET);

    for (const [alias, metered] of [
        ['s.trimLeft()', 's.trimStart()'],
        ['s.trimRight()', 's.trimEnd()'],
        ['Number.parseInt(s,10)', 'parseInt(s,10)'],
        ['Number.parseFloat(s)', 'parseFloat(s)'],
    ]) {
        it(`${alias} keeps the legacy flat charge on mainnet`, async function () {
            const aliasResult = await run(alias);
            const meteredResult = await run(metered);
            assert.strictEqual(aliasResult.success, true, aliasResult.error);
            assert.strictEqual(meteredResult.success, true, meteredResult.error);
            assert.ok(meteredResult.gasUsed - aliasResult.gasUsed >= LENGTH / 2,
                `${alias}: ${aliasResult.gasUsed} vs ${metered}: ${meteredResult.gasUsed}`);
        });
    }

    it('keeps the legacy aliases distinct from their metered wrappers', async function () {
        const result = await run(`if(
            String.prototype.trimLeft===String.prototype.trimStart||
            String.prototype.trimRight===String.prototype.trimEnd||
            Number.parseInt===parseInt||Number.parseFloat===parseFloat
        )throw new Error('alias identity');`);
        assert.strictEqual(result.success, true, result.error);
    });
});
