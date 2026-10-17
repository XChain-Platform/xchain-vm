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
 * Armed harness rule for the host error stack strip
 ********************************************************************/
// @ts-nocheck
'use strict';

// Used when the host error stack strip activation is armed
// (../host_error_stack_strip_heights.js). wrap() hands every host reference to
// __wrapArmed, whose function rethrows an error the host threw as a fresh in-isolate
// error of the same constructor and message, so its stack is "" like every
// in-isolate error instead of isolated-vm's boundary frame and harness position.
// The dispatch is appended to wrap()'s first line, so no harness line moves.

const LABEL = 'host error stack strip';

const EDITS = [
    ['    function wrap(ref) {',
     '    function wrap(ref) { return __wrapArmed(ref);'],
];

// The argument line of __wrapArmed, matching wrap()'s own; the host-call bounds rule
// rewrites it here too when both are armed (select.js).
const ARGUMENT_LINE = '            var jsonArgs = JSON.stringify(Array.prototype.slice.call(arguments));\n';

const HELPERS = `
    // ----- Host-thrown error rethrow (host error stack strip activation) -----
    // An error a gateway function throws on the host reaches wrap() as an error
    // isolated-vm built, whose own stack is isolated-vm's boundary frame plus the
    // position of wrap()'s applySync call. A contract could store that text and
    // tie hashed state to these harness bytes and to isolated-vm's frame format.
    // In this harness wrap() hands every reference to __wrapArmed, whose function
    // rethrows such an error as a fresh in-isolate error of the same constructor
    // and message (and the own name isolated-vm gives a custom error class), so
    // its stack is "" like every in-isolate error. The rethrow runs in unmetered
    // harness code.
    function __wrapArmed(ref) {
        return function() {
${ARGUMENT_LINE}            var jsonResult;
            try { jsonResult = ref.applySync(undefined, [jsonArgs]); } catch (e) { throw __freshHostError(e); }
            if (jsonResult === undefined || jsonResult === null) return jsonResult;
            if (typeof jsonResult === 'string' && jsonResult.charAt(0) === '\x01') {
                return JSON.parse(jsonResult.substring(1));
            }
            return jsonResult;
        };
    }
    var __hostErrorCtors = [Error, RangeError, ReferenceError, SyntaxError, TypeError];
    function __freshHostError(e) {
        if (!__hostErrorCtors || e === null || typeof e !== 'object') return e;
        var proto = __getProto(e);
        for (var i = 0; i < __hostErrorCtors.length; i++) {
            if (__hostErrorCtors[i].prototype !== proto) continue;
            var fresh = new __hostErrorCtors[i](e.message);
            var nameDesc = __getOwnDesc(e, 'name');
            if (nameDesc) __defProp(fresh, 'name', nameDesc);
            return fresh;
        }
        return e;
    }
`;

module.exports = { LABEL, EDITS, HELPERS, ARGUMENT_LINE };
