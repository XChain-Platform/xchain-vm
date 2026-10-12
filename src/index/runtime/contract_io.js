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
 * XChain VM: contract source and return value
 *
 * Builds the compiled wrapper source and decodes the contract return value.
 ********************************************************************/
// @ts-nocheck

const { CONTRACT_WRAPPER, CONTRACT_WRAPPER_HARDENED } = require('../contract_wrapper.js');

function buildContractSource(opts, meteredCode, wrapperHardened) {
        // VM_LINT_HARDENING (gated): pass the control bindings as IIFE
        // PARAMETERS so they never enter the global lexical scope where the
        // Function-constructed contract body could read or shadow them
        // (see CONTRACT_WRAPPER_HARDENED). Pre-gate the legacy script-level
        // `let` form compiles byte-identical to the historical source.
        const escapedCode = JSON.stringify(meteredCode);
        const escapedMethod = JSON.stringify(opts.method || 'default');
            return wrapperHardened
            ? CONTRACT_WRAPPER_HARDENED + '(' +
                  escapedCode + ', ' +
                  escapedMethod + ', ' +
                  JSON.stringify(Boolean(opts.isCrossCall)) + ', ' +
                  JSON.stringify(Boolean(opts.readManifest)) + ');\n'
            : 'let __contractCode = ' + escapedCode + ';\n' +
              'let __methodName = ' + escapedMethod + ';\n' +
              'let __isCrossCall = ' + JSON.stringify(Boolean(opts.isCrossCall)) + ';\n' +
              'let __readManifest = ' + JSON.stringify(Boolean(opts.readManifest)) + ';\n' +
              CONTRACT_WRAPPER;
}

function extractReturnValue(rawReturn) {
    let returnValue = null;
        // The contract wrapper JSON-serializes non-null return values
        // with a \x02 prefix inside the isolate
        if (rawReturn !== undefined && rawReturn !== null) {
            if (typeof rawReturn === 'string' && rawReturn.charCodeAt(0) === 0x02) {
                const serialized = rawReturn.substring(1);
                returnValue = serialized.length > 65536 ? serialized.substring(0, 65536) : serialized;
            } else {
                try {
                    const serialized = JSON.stringify(rawReturn);
                    if (serialized !== undefined) {
                        returnValue = serialized.length > 65536 ? serialized.substring(0, 65536) : serialized;
                    }
                } catch (e) {
                    returnValue = null;
                }
            }
        }
    return returnValue;
}

module.exports = { buildContractSource, extractReturnValue };
