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
 * Armed harness rule for the resource fault signal
 ********************************************************************/
// @ts-nocheck
'use strict';

// Used when the resource fault signal activation is armed
// (../resource_fault_signal_heights.js). The stack guard's fault constructor calls
// the host reference __stackFault before it builds the error, so the classifier can
// tell a real depth trip from a contract that throws the same text. The reference is
// captured on the same line, before the cleanup pass strips __-prefixed globals, and
// isolate_globals.js injects it only while the activation is armed.

const LABEL = 'resource fault signal';

const EDITS = [
    ["    var __stackError = function() { return new Error('maximum call stack depth exceeded'); };",
     '    var __stackFaultRef = globalThis.__stackFault; var __stackError = function() { ' +
        "if (__stackFaultRef) __stackFaultRef.applySync(undefined, []); return new Error('maximum call stack depth exceeded'); };"],
];

const HELPERS = '';

module.exports = { LABEL, EDITS, HELPERS };
