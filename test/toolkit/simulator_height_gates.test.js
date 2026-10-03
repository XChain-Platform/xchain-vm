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
 * The simulator's HEIGHT_GATES table against the VM's exported per-coin height
 * gates. The table must list every `<COIN>:<network>` activation map the VM
 * exports, and the default height and the pre-activation warning must decide
 * genesis activation per gate through that gate's own predicate: the
 * optional-chain refinement is genesis-on for regtest only, so an armed testnet
 * threshold must move the testnet default rather than be pinned to height 1.
 *
 * The real activation maps are frozen consensus constants, so the armed cases
 * swap a synthetic map and predicate onto the VM export object and restore it.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const XChainVM = require('../../src/index.js');
const { HEIGHT_GATES } = require('../../src/toolkit/simulator/constants.js');
const { defaultBlockHeight } = require('../../src/toolkit/simulator/block_time_gates.js');
const gateWarnings = require('../../src/toolkit/simulator/gate_warnings.js');

const COIN_NETWORK_KEY = /^[A-Z]+:[a-z]+$/;

// Swap an armed optional-chain map and a predicate with the real resolver's shape
// onto the export object for the duration of fn, then restore both.
function withArmedOptionalChain(map, fn) {
    const realMap = XChainVM.LINT_OPTIONAL_CHAIN_ACTIVATION;
    const realPred = XChainVM.isLintOptionalChainActive;
    XChainVM.LINT_OPTIONAL_CHAIN_ACTIVATION = Object.freeze(map);
    XChainVM.isLintOptionalChainActive = function (network, coin, height) {
        if (network === 'regtest') return true;
        const t = map[coin + ':' + network];
        return Number.isFinite(t) && Number(height) >= t;
    };
    try { return fn(); } finally {
        XChainVM.LINT_OPTIONAL_CHAIN_ACTIVATION = realMap;
        XChainVM.isLintOptionalChainActive = realPred;
    }
}

function heightWarningsFor(network, height, contractAddress) {
    const lines = [];
    const warn = console.warn;
    console.warn = (msg) => { lines.push(String(msg)); };
    try {
        gateWarnings.warnIfPreHeightGate.call({ network, block: { height } }, contractAddress);
    } finally { console.warn = warn; }
    return lines;
}

describe('toolkit: simulator HEIGHT_GATES covers every VM height gate', function () {

    it('lists every exported per-coin activation map with an exported predicate', function () {
        const exported = Object.keys(XChainVM).filter((k) => /_ACTIVATION$/.test(k) &&
            XChainVM[k] && typeof XChainVM[k] === 'object' &&
            Object.keys(XChainVM[k]).some((key) => COIN_NETWORK_KEY.test(key)));
        assert.ok(exported.length >= 4, 'expected the VM to export its height-gate maps: ' + exported);
        const listed = HEIGHT_GATES.map((g) => g.map);
        for (const name of exported) {
            assert.ok(listed.includes(name), name + ' is a VM height gate missing from HEIGHT_GATES');
        }
        for (const g of HEIGHT_GATES) {
            assert.strictEqual(typeof XChainVM[g.isActive], 'function', g.isActive + ' is not exported');
            assert.ok(XChainVM[g.map] && typeof XChainVM[g.map] === 'object', g.map + ' is not exported');
        }
    });

    it('keeps the default heights the shipped optional-chain map implies', function () {
        const armed = { 'BTC:testnet': 155001, 'LTC:testnet': 4906040, 'DOGE:testnet': 67962387 };
        for (const coin of ['BTC', 'LTC', 'DOGE']) {
            assert.strictEqual(defaultBlockHeight(coin, 'regtest'), 1);
            assert.strictEqual(defaultBlockHeight(coin, 'testnet'), armed[coin + ':testnet']);
            assert.strictEqual(defaultBlockHeight(coin, 'mainnet'),
                XChainVM.PKG3_SANDBOX_ACTIVATION[coin + ':mainnet']);
        }
        assert.strictEqual(defaultBlockHeight(null, 'mainnet'), 1);
    });

    it('decides genesis activation per gate, so an armed testnet threshold moves the default', function () {
        withArmedOptionalChain({ 'BTC:testnet': 500, 'BTC:mainnet': 99999999 }, function () {
            assert.strictEqual(defaultBlockHeight('BTC', 'testnet'), 500);
            assert.strictEqual(defaultBlockHeight('BTC', 'mainnet'), 99999999);
            assert.strictEqual(defaultBlockHeight('BTC', 'regtest'), 1);
            assert.strictEqual(defaultBlockHeight('LTC', 'testnet'), 1);
        });
    });

    it('warns on testnet below an armed optional-chain threshold and stays quiet otherwise', function () {
        assert.deepStrictEqual(heightWarningsFor('testnet', 155001, 'C:BTC:5'), []);
        assert.deepStrictEqual(heightWarningsFor('regtest', 1, 'C:BTC:5'), []);
        withArmedOptionalChain({ 'BTC:testnet': 500 }, function () {
            const below = heightWarningsFor('testnet', 1, 'C:BTC:5');
            assert.strictEqual(below.length, 1, JSON.stringify(below));
            assert.ok(/lint optional-chain \(500\)/.test(below[0]), below[0]);
            assert.deepStrictEqual(heightWarningsFor('testnet', 500, 'C:BTC:5'), []);
            assert.deepStrictEqual(heightWarningsFor('regtest', 1, 'C:BTC:5'), []);
        });
    });
});
