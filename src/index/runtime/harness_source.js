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
 * XChain VM: harness script
 *
 * Harness script that runs inside the isolate to assemble the xchain
 * object from injected ivm.Reference callbacks. Contract code calls
 * xchain.state.get(key) which calls __state_get.applySync(undefined, [key]).
 ********************************************************************/
// @ts-nocheck

const part1 = require('./harness_part_1.js');
const part2 = require('./harness_part_2.js');
const part3 = require('./harness_part_3.js');
const part4 = require('./harness_part_4.js');
const part5 = require('./harness_part_5.js');

const HARNESS_SOURCE = [part1, part2, part3, part4, part5].join('');

module.exports = { HARNESS_SOURCE };
