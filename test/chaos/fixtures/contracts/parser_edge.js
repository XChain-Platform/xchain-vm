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

// JS syntax at acorn's parsing boundary for chaos testing.
// Uses ES2020 features that should be supported by both V8 and acorn.
module.exports = {
    optionalChaining: function(xchain) {
        var params = xchain.getInputParams();
        var first = params[0];
        var val = params.length > 1 ? params[1] : null;
        xchain.state.set('chained', val !== null && val !== undefined ? val : 'default');
        return xchain.state.get('chained');
    },
    nullishCoalescing: function(xchain) {
        var a = xchain.getInputParam(0);
        var b = xchain.getInputParam(1);
        var result = a !== null && a !== undefined ? a : (b !== null && b !== undefined ? b : 'fallback');
        return result;
    },
    destructuring: function(xchain) {
        var params = xchain.getInputParams();
        var a = params[0] || '0';
        var b = params[1] || '0';
        var sum = xchain.math.add(a, b);
        xchain.state.set('sum', sum);
        return sum;
    },
    templateLiterals: function(xchain) {
        var name = xchain.getInputParam(0) || 'world';
        var greeting = 'hello ' + name;
        xchain.log(greeting);
        return greeting;
    },
    computedProperty: function(xchain) {
        var key = 'state_' + (xchain.getInputParam(0) || 'default');
        var val = xchain.getInputParam(1) || 'value';
        xchain.state.set(key, val);
        return key;
    }
};
