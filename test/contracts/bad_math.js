// @ts-nocheck
// 
// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Demonstrates why xchain.math is needed
module.exports = function(xchain) {
    // Native floating-point — non-deterministic across V8 versions
    var nativeResult = 0.1 + 0.2;
    xchain.log('native 0.1 + 0.2 =', String(nativeResult));

    // xchain.math — deterministic everywhere
    var safeResult = xchain.math.add('0.1', '0.2');
    xchain.log('xchain.math 0.1 + 0.2 =', safeResult);

    return { native: String(nativeResult), safe: safeResult };
};
