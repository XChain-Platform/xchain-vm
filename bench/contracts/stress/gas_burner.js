// @ts-nocheck
// 
// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

// Stress benchmark: tight loop burning gas toward the ceiling.
// Tests gas exhaustion detection latency and resource cleanup.
module.exports = function(xchain) {
    var sum = '0';
    for (var i = 0; i < 1000000; i++) {
        sum = xchain.math.add(sum, '1');
    }
    return sum;
};
