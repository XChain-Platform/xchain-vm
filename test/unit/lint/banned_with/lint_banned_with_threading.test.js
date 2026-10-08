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
 ********************************************************************/
'use strict';

const assert = require('assert');
const XChainVM = require('../../../../src/index.js');
const gateWarnings = require('../../../../src/toolkit/simulator/gate_warnings.js');

const GAS_SCHEDULE = {
    VM_COMPUTATION: 1, VM_STATE_READ: 100, VM_STATE_WRITE: 200, VM_STATE_DELETE: 100,
    VM_ORACLE_READ: 100, VM_CROSSCHAIN_READ: 100, VM_ATTEST_REQUEST: 5000, VM_EMISSION: 500,
    VM_XCALL_REQUEST: 2000, VM_XCALL_CALLBACK: 20000
};

function newVm() {
    return new XChainVM({
        gasSchedule: GAS_SCHEDULE,
        gasCeiling: 1000000,
        execution: 'in-process'
    });
}

function withSyntaxSpy(fn) {
    const syntaxPath = require.resolve('../../../../src/syntax.js');
    const lintPath = require.resolve('../../../../src/index/lint_and_metering.js');
    const realSyntax = require.cache[syntaxPath];
    const realLint = require.cache[lintPath];
    const calls = [];

    require.cache[syntaxPath] = {
        id: syntaxPath,
        filename: syntaxPath,
        loaded: true,
        exports: {
            validateSyntax: (code, opts) => {
                calls.push({ code, opts });
                return { valid: true };
            },
            checkFloatWarnings: () => []
        }
    };
    delete require.cache[lintPath];

    try {
        return fn(require(lintPath).getLintVerdict, calls);
    } finally {
        if (realSyntax) require.cache[syntaxPath] = realSyntax;
        else delete require.cache[syntaxPath];
        if (realLint) require.cache[lintPath] = realLint;
        else delete require.cache[lintPath];
    }
}

describe('banned-with execute-time lint threading', function () {
    it('partitions the verdict cache and forwards the exact boolean', function () {
        const vm = newVm();
        const code = 'module.exports = function(){ return 1; };';

        withSyntaxSpy((getLintVerdict, calls) => {
            getLintVerdict.call(vm, code, false, false, false, false, false, false, undefined, true);
            getLintVerdict.call(vm, code, false, false, false, false, false, false, undefined, false);

            assert.strictEqual(Reflect.get(vm, '_lintVerdictCache').size, 2);
            assert.strictEqual(calls.length, 2);
            assert.strictEqual(calls[0].opts.enforceBannedWith, true);
            assert.strictEqual(calls[1].opts.enforceBannedWith, false);
        });
    });

    it('validateSyntax accepts below the gate and rejects at the gate', function () {
        const code = 'module.exports = function(o){ with (o) { return value; } };';
        assert.strictEqual(newVm().validateSyntax(code, { enforceBannedWith: false }).valid, true);
        assert.strictEqual(newVm().validateSyntax(code, { enforceBannedWith: true }).valid, false);
    });

    it('simulator deploy lint resolves the configured network and coin', function () {
        for (const [network, expected] of [['regtest', true], ['mainnet', false], ['testnet', false]]) {
            let options;
            const verdict = gateWarnings.deployGateVerdict.call({
                limits: { maxCodeSize: 65536 },
                block: { height: 10000000, timestamp: 1786060800 },
                network,
                coin: 'BTC',
                vm: {
                    validateSyntax(code, opts) {
                        options = opts;
                        return { valid: true };
                    }
                }
            }, 'module.exports = function(){};');
            assert.deepStrictEqual(verdict, { valid: true });
            assert.strictEqual(options.enforceBannedWith, expected, network);
        }
    });
});
