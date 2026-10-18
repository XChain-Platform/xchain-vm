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
 **********************************************************************
 * Source pin for the wrappers changed by the string receiver meter.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const crypto = require('crypto');
const { HARNESS_SOURCE } = require('../../../src/index/runtime/harness_source.js');
const select = require('../../../src/index/armed_harness/select.js');
const rule = require('../../../src/index/armed_harness/string_receiver_meter.js');
const { createVM, execute, XChainVM } = require('../../fuzz/helpers/harness.js');

const RELEASED_LINES = 1631;
const RELEASED_SHA256 = 'b6b49ddc0b95da4724b337fcf9482d9bb3f1ac0da02c6b0e8758773e6622c748';
const LATE = { height: 100, timestamp: 4000000000, hash: 'abc123' };
const PINNED = {
    repeat: '9abb89db8c34514f4884141aa477727ff5a41c7d7bf9a7fe6c763c0369b48c64',
    concat: '01c47d284bf73c26667e4bfeca46562d39476872c2b5336f23a99ce745e0114a',
    replace: '43355e2f1307b4b8d1c8a71e043e8dea42869f8c1900fda6d7bdc0ab9f56d9aa',
    replaceAll: '43355e2f1307b4b8d1c8a71e043e8dea42869f8c1900fda6d7bdc0ab9f56d9aa',
    indexOf: 'cb08a355daef6a762a33bd4f923a8cbf116ac4d82004ba8ca23fb3d7779dcd0a',
};
// The v0.25.0 cut arms testnet at this block time. These are the armed wrappers'
// String(fn) hashes, taken from this file's own body on testnet at that instant; regtest
// produces the same five.
const TESTNET_ARMED = 1792432800;
const ARMED = {
    repeat: '20cb035ee9ce4e28333d448694d8c6c36519eca877ee84e4b92e80c322a4bf91',
    concat: '8d1c3d24d8a66f7f291eddbc9e8846fb0eeafccc2372368b402bca33cb6496bc',
    replace: 'ec4215b23f4101a320580f14062994a6a63b18d058707a45f95ad46ece8f2b5b',
    replaceAll: 'ec4215b23f4101a320580f14062994a6a63b18d058707a45f95ad46ece8f2b5b',
    indexOf: '84ba955d2e6ed9b50af6a98a54e518de88531daf23f0f4fca027235737095546',
};

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

describe('string receiver meter: harness source pin', function () {
    it('keeps the unarmed harness byte-identical to the released source', function () {
        assert.strictEqual(HARNESS_SOURCE.split('\n').length, RELEASED_LINES);
        assert.strictEqual(sha256(HARNESS_SOURCE), RELEASED_SHA256);
        assert.strictEqual(select.harnessSourceFor(0), HARNESS_SOURCE);
    });

    it('derives same-line edits that each match exactly once', function () {
        for (const [from, to] of rule.EDITS) {
            assert.strictEqual(HARNESS_SOURCE.split(from).length - 1, 1, from.trim());
            assert.strictEqual(from.split('\n').length, to.split('\n').length, from.trim());
        }
        const bit = 1 << select.RULES.indexOf(rule);
        assert.strictEqual(select.harnessSourceFor(bit), rule.HARNESS_SOURCE_STRING_RECEIVER_METER);
        assert.strictEqual(rule.HARNESS_SOURCE_STRING_RECEIVER_METER.split('\n').length, RELEASED_LINES);
    });
});

(XChainVM ? describe : describe.skip)('string receiver meter: unarmed wrapper source text', function () {
    this.timeout(60000);

    for (const [title, network, timestamp, pins] of [
        ["mainnet retains every wrapper's released String(fn)", 'mainnet', LATE.timestamp, PINNED],
        ["testnet before its v0.25.0 instant retains every wrapper's released String(fn)",
            'testnet', TESTNET_ARMED - 1, PINNED],
        ["testnet from its v0.25.0 instant carries every wrapper's armed String(fn)",
            'testnet', TESTNET_ARMED, ARMED],
    ]) {
        it(title, async function () {
            const vm = createVM({ gasCeiling: 1000000, maxCpuTimeMs: 30000 });
            vm.beginBlock();
            try {
                const body = `module.exports=function(){var f={
                    repeat:String.prototype.repeat,concat:String.prototype.concat,
                    replace:String.prototype.replace,replaceAll:String.prototype.replaceAll,
                    indexOf:String.prototype.indexOf};var r={};Object.keys(f).forEach(function(k){r[k]=String(f[k]);});
                    return JSON.stringify(r);};`;
                const result = await execute(vm, body, { network, blockContext: { ...LATE, timestamp } });
                assert.strictEqual(result.success, true, result.error);
                const texts = JSON.parse(JSON.parse(result.returnValue));
                const got = {};
                for (const [name, text] of Object.entries(texts)) got[name] = sha256(text);
                assert.deepStrictEqual(got, pins);
            } finally { if (vm.endBlock) vm.endBlock(); }
        });
    }
});
