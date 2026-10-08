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

function withLintSourceSpy(fn) {
    const lintCorePath = require.resolve('../../../../src/lint-core.js');
    const syntaxPath = require.resolve('../../../../src/syntax.js');
    const realLintCore = require.cache[lintCorePath];
    const realSyntax = require.cache[syntaxPath];
    const lintCore = realLintCore ? realLintCore.exports : require(lintCorePath);
    const calls = [];

    require.cache[lintCorePath] = {
        id: lintCorePath,
        filename: lintCorePath,
        loaded: true,
        exports: {
            ...lintCore,
            lintSource(code, opts) {
                calls.push({ code, opts });
                return { errors: [] };
            }
        }
    };
    delete require.cache[syntaxPath];

    try {
        return fn(require(syntaxPath).validateSyntax, calls);
    } finally {
        if (realLintCore) require.cache[lintCorePath] = realLintCore;
        else delete require.cache[lintCorePath];
        if (realSyntax) require.cache[syntaxPath] = realSyntax;
        else delete require.cache[syntaxPath];
    }
}

describe('destructure lint threading', function () {
    it('partitions the verdict cache independently from banned-with and forwards the exact boolean', function () {
        const vm = newVm();
        const code = 'module.exports = function(){ return 1; };';

        withSyntaxSpy((getLintVerdict, calls) => {
            getLintVerdict.call(vm, code, false, false, false, false, false, false,
                undefined, false, true);
            getLintVerdict.call(vm, code, false, false, false, false, false, false,
                undefined, false, false);
            getLintVerdict.call(vm, code, false, false, false, false, false, false,
                undefined, true, false);

            assert.strictEqual(Reflect.get(vm, '_lintVerdictCache').size, 3);
            assert.deepStrictEqual(calls.map(({ opts }) => [
                opts.enforceBannedWith,
                opts.enforceLintDestructure
            ]), [[false, true], [false, false], [true, false]]);
        });
    });

    it('validateSyntax defaults the lint-core destructure option on and forwards explicit values', function () {
        withLintSourceSpy((validateSyntax, calls) => {
            validateSyntax('const a = 1;');
            validateSyntax('const a = 1;', { enforceLintDestructure: true });
            validateSyntax('const a = 1;', { enforceLintDestructure: false });

            assert.deepStrictEqual(calls.map(({ opts }) => opts.destructure), [true, true, false]);
        });
    });
});

describe('destructure lint threading', function () {
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
            assert.strictEqual(options.enforceLintDestructure, expected, network);
        }
    });

    it('execute lint resolves the contract coin and restores the private carrier', async function () {
        const vm = newVm();
        const seen = [];
        const realGetLintVerdict = vm.getLintVerdict;
        vm.getLintVerdict = function (...args) {
            seen.push(Reflect.get(this, '_executeLintDestructure'));
            return realGetLintVerdict.apply(this, args);
        };
        const code = 'module.exports = function(){ return 1; };';
        const opts = {
            code,
            state: {},
            method: 'default',
            params: [],
            caller: 'bc1qcaller',
            contractAddress: 'C:BTC:1',
            contractIndex: 1,
            txHash: 'a'.repeat(64),
            blockContext: { height: 10000000, timestamp: 1786060800, hash: 'b'.repeat(64) }
        };

        const regtest = await vm.execute({ ...opts, network: 'regtest' });
        const mainnet = await vm.execute({ ...opts, network: 'mainnet' });

        assert.strictEqual(regtest.success, true, regtest.error);
        assert.strictEqual(mainnet.success, true, mainnet.error);
        assert.deepStrictEqual(seen, [true, false]);
        assert.strictEqual(Object.hasOwn(vm, '_executeLintDestructure'), false);
    });
});
