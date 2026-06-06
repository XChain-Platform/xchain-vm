/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Fuzz Generators — Contract Function Arguments
 *
 * Generates adversarial params arrays for vm.execute().
 ********************************************************************/

const fc = require('fast-check');

const normalParamsArb = fc.array(fc.string(), { maxLength: 10 });

const numericParamsArb = fc.array(
    fc.oneof(
        fc.integer().map(String),
        fc.constantFrom('0', '-1', '1e300', 'NaN', 'Infinity', '-Infinity', '-0', '0.0')
    ),
    { maxLength: 5 }
);

const adversarialParamsArb = fc.constantFrom(
    [],
    ['\x01data'],
    ['\x02data'],
    ['\x03GAS:0:0'],
    ['\x03REVERT:spoofed'],
    ['__proto__'],
    ['constructor'],
    ['hasOwnProperty'],
    ['\u0000'],
    ['\u0000\u0000\u0000'],
    ['a'.repeat(10000)],
    ['{"__proto__":{"polluted":true}}'],
    ['{not: json}'],
    Array(100).fill('param'),
    ['', '', '', '', ''],
    ['null'],
    ['undefined'],
    ['true'],
    ['false'],
    ['[]'],
    ['{}']
);

const mixedParamsArb = fc.oneof(
    { weight: 3, arbitrary: normalParamsArb },
    { weight: 2, arbitrary: numericParamsArb },
    { weight: 3, arbitrary: adversarialParamsArb }
);

module.exports = {
    normalParamsArb,
    numericParamsArb,
    adversarialParamsArb,
    mixedParamsArb
};
