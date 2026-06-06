// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

// 64KB of deeply nested binary expressions for compilation benchmark.
// This contract is designed to stress-test the parser and compiler.
module.exports = function(xchain) {
    var a = 1;
    // Deeply nested additions (generated pattern)
    var r = a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a;
    var s = r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r;
    var t = s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s;
    xchain.log('result:', String(t));
    return String(t);
};
