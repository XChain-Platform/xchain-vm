/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 ********************************************************************/

'use strict';

// Strip-script fragment emitted right after the Function-family strip: declares the
// read-back every later neuter loop calls, then checks the Function-family neuters,
// whose own try swallows every define failure.
const stripScriptNeuterChecks = () => `
    // Throw unless a neuter took: an own data property holding undefined, non-writable and
    // non-configurable (a getter has no 'writable' field, so the strict check rejects it).
    function assertNeutered(target, key, label) {
        var d = Object.getOwnPropertyDescriptor(target, key);
        if (!d || d.value !== undefined || d.writable !== false || d.configurable !== false)
            throw new Error(label + ': ' + String(key) + ' was not neutered');
    }
    // Read the Function-family neuters back OUTSIDE their swallowing try; a target that
    // was never resolved throws a TypeError here, which fails setup the same way.
    var fnFamilyTargets = [
        [globalThis.__Function.prototype, 'Function.prototype'],
        [Object.getPrototypeOf(function*(){}), 'GeneratorFunction.prototype'],
        [Object.getPrototypeOf(async function(){}), 'AsyncFunction.prototype'],
        [Object.getPrototypeOf(async function*(){}), 'AsyncGeneratorFunction.prototype'],
        [GeneratorFunction, 'GeneratorFunction'],
        [AsyncFunction, 'AsyncFunction'],
        [AsyncGeneratorFunction, 'AsyncGeneratorFunction']
    ];
    for (var f = 0; f < fnFamilyTargets.length; f++)
        assertNeutered(fnFamilyTargets[f][0], 'constructor', fnFamilyTargets[f][1]);
`;

module.exports = { stripScriptNeuterChecks };
