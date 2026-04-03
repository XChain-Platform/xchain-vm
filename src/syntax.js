/*********************************************************************
 * XChain VM — Syntax Validation
 *
 * Deploy-time validation: V8 syntax check, acorn metering pass,
 * reserved identifier check, and float warnings.
 ********************************************************************/

const ivm   = require('isolated-vm');
const acorn = require('acorn');
const walk  = require('acorn-walk');
const { meterCode, hasGasIdentifier } = require('./metering.js');

/**
 * Validate contract code syntax before deployment.
 * Runs three blocking checks in order:
 * 1. V8 syntax check (compileScriptSync in throwaway isolate)
 * 2. Acorn metering pass (ensures acorn can parse it — supported syntax = min(V8, acorn))
 * 3. Reserved identifier check (__gas)
 *
 * @param {string} code - Contract source code
 * @returns {{ valid: boolean, error?: string }}
 */
function validateSyntax(code) {
    // 1. V8 syntax check
    let testIsolate;
    try {
        testIsolate = new ivm.Isolate({ memoryLimit: 4 });
        testIsolate.compileScriptSync(code);
    } catch (e) {
        return { valid: false, error: 'syntax error: ' + e.message };
    } finally {
        try { if (testIsolate) testIsolate.dispose(); } catch (e) {}
    }

    // 2. Acorn metering pass — if acorn can't parse it, reject
    try {
        meterCode(code);
    } catch (e) {
        return { valid: false, error: 'unsupported syntax (ES2020 maximum): ' + e.message };
    }

    // 3. Reserved identifier check
    if (hasGasIdentifier(code))
        return { valid: false, error: 'reserved identifier: __gas' };

    return { valid: true };
}

/**
 * Scan contract code for patterns suggesting native float arithmetic.
 * Non-blocking warning — does not reject the contract.
 *
 * @param {string} code - Contract source code
 * @returns {string[]} Array of warning messages
 */
function checkFloatWarnings(code) {
    const warnings = [];
    try {
        const ast = acorn.parse(code, {
            ecmaVersion: 2020,
            sourceType: 'script',
            locations: true
        });
        walk.simple(ast, {
            Literal(node) {
                if (typeof node.value === 'number' && !Number.isInteger(node.value)) {
                    const line = node.loc ? node.loc.start.line : '?';
                    warnings.push(
                        'WARNING: decimal number literal (' + node.value +
                        ') detected at line ' + line +
                        ' — use xchain.math for deterministic arithmetic'
                    );
                }
            }
        });
    } catch (e) {
        // Parse failure — validateSyntax would have caught this
    }
    return warnings;
}

module.exports = { validateSyntax, checkFloatWarnings };
