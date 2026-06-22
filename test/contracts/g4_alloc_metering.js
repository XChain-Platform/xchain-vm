// @ts-nocheck
//
// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC -- https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Exercises the G4 syntax-level allocation-metering paths so the golden
// invariant pins their exact gasUsed. Each method is a pure deterministic
// function of its inputs: no wall-clock, no randomness, no I/O.
module.exports = {
    // string_concat: builds a string >256 bytes via +, triggering __concat gas charge.
    // The seed ('x'.repeat(200)) is exactly 200 chars, so each + of two such strings
    // grows by 200 chars (beyond the 200-char largest operand), which is below the
    // 256-byte threshold. Two concatenations of the 200-char string give 400 chars;
    // the second concat (200 + 200 = 400, grew = 400 - 200 = 200) is still under 256.
    // We use a 300-char base so a single concat grew = 300 - 300 = 300 > 256, charging gas.
    string_concat: function(xchain) {
        var base = xchain.getInputParam(0);
        var result = base + base;
        xchain.state.set('len', String(result.length));
        return result.length;
    },

    // arr_spread: spreads two arrays whose combined length exceeds 256 elements,
    // triggering the __arrspread gas charge (charged on total spread element count).
    arr_spread: function(xchain) {
        var sizeStr = xchain.getInputParam(0);
        var size = parseInt(sizeStr, 10);
        var a = [];
        var i;
        for (i = 0; i < size; i++) a.push(i);
        var b = [1, 2, 3];
        var combined = [...a, ...b];
        xchain.state.set('len', String(combined.length));
        return combined.length;
    },

    // obj_spread: merges two objects whose combined key count exceeds 256,
    // triggering the __objspread gas charge (charged on total keys copied from spread sources).
    obj_spread: function(xchain) {
        var sizeStr = xchain.getInputParam(0);
        var size = parseInt(sizeStr, 10);
        var src = {};
        var i;
        for (i = 0; i < size; i++) src['k' + i] = i;
        var extra = { z: 1 };
        var merged = { ...src, ...extra };
        xchain.state.set('keycount', String(Object.keys(merged).length));
        return Object.keys(merged).length;
    }
};
