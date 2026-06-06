// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

// All known sandbox escape attempts — every one must fail
module.exports = function(xchain) {
    var results = [];

    // 1: process access
    try { results.push('process:' + (typeof process)); }
    catch(e) { results.push('process:blocked'); }

    // 2: require
    try { results.push('require:' + (typeof require)); }
    catch(e) { results.push('require:blocked'); }

    // 3: constructor escape
    try {
        var fn = this.constructor.constructor('return process')();
        results.push('constructor:' + (typeof fn));
    } catch(e) { results.push('constructor:blocked'); }

    // 4: eval
    try { results.push('eval:' + (typeof eval)); }
    catch(e) { results.push('eval:blocked'); }

    // 5: Function constructor
    try { results.push('Function:' + (typeof Function)); }
    catch(e) { results.push('Function:blocked'); }

    // 6: Date
    try { results.push('Date:' + (typeof Date)); }
    catch(e) { results.push('Date:blocked'); }

    // 7: Math.random
    try { results.push('Math.random:' + (typeof Math.random)); }
    catch(e) { results.push('Math.random:blocked'); }

    // 8: setTimeout
    try { results.push('setTimeout:' + (typeof setTimeout)); }
    catch(e) { results.push('setTimeout:blocked'); }

    // 9: fetch
    try { results.push('fetch:' + (typeof fetch)); }
    catch(e) { results.push('fetch:blocked'); }

    // 10: Proxy
    try { results.push('Proxy:' + (typeof Proxy)); }
    catch(e) { results.push('Proxy:blocked'); }

    // 11: WeakRef
    try { results.push('WeakRef:' + (typeof WeakRef)); }
    catch(e) { results.push('WeakRef:blocked'); }

    // 12: SharedArrayBuffer
    try { results.push('SharedArrayBuffer:' + (typeof SharedArrayBuffer)); }
    catch(e) { results.push('SharedArrayBuffer:blocked'); }

    for (var i = 0; i < results.length; i++) {
        xchain.log(results[i]);
    }

    return results;
};
