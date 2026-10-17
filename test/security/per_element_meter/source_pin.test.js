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
 * Source-text pin for the wrappers the per-element meter touches.
 *
 * Contract code can read a reachable function's source with String(fn), and
 * that text (and the gas to build it) can land in hashed state. While the
 * per-element gate is unarmed, every wrapper it touches must therefore keep
 * the exact source text the previous release installed. The digests below
 * are sha256 of String(fn) read from the parent commit on mainnet and on
 * testnet at a late block, together with the probe's gasUsed.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const crypto = require('crypto');
const { createVM, execute, XChainVM } = require('../../fuzz/helpers/harness.js');

const LATE = { height: 100, timestamp: 4000000000, hash: 'abc123' };
// The v0.24.0 cut arms the per-element meter on testnet at block time 1792303200; the
// unarmed testnet wrappers are read one second before it.
const blockFor = (network) => (network === 'testnet' ? { ...LATE, timestamp: 1792303199 } : LATE);
const BODY = `var g = (function(){ return this; })();
var ip = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));
var hp = Object.getPrototypeOf([].values().take(0));
var out = {
  objspread: g['__obj' + 'spread'], objspreadmeter: g['__obj' + 'spreadmeter'], 'String.raw': String.raw,
  'helper.next': hp.next, 'iter.toArray': ip.toArray, 'iter.drop': ip.drop, 'iter.take': ip.take
};
['map','filter','flatMap','reduce','forEach','some','every','find'].forEach(function(m){ out['iter.' + m] = ip[m]; });
['union','intersection','difference','symmetricDifference','isSubsetOf','isSupersetOf','isDisjointFrom'].forEach(function(m){ out['Set.' + m] = Set.prototype[m]; });
var r = {}; Object.keys(out).forEach(function(k){ r[k] = typeof out[k] === 'function' ? String(out[k]) : ('<' + typeof out[k] + '>'); });
return JSON.stringify(r);`;

const PINNED = {
    mainnet: {
        'gasUsed': 4041,
        'objspread': 'e81180e1049b200a7d1e9ba48aa537f72b6310257b5bb6964161a0b4d0379cc6',
        'objspreadmeter': '01de3600b6d3ff059a57230b9f380f6c1c62eefd4690bb30905273fa6b3bf667',
        'String.raw': '7a3ffc77a1d954974375c167c22a19ef9a7fd392cb4df463d8ad7a98b382833f',
        'helper.next': '05a9615ca5cd6c3e314eb0f41b54e2c2fe18521c7357ec5affd61a8ac9572cb7',
        'iter.toArray': '811ad9e9b5d4121addd88394d7f8257b59088a4809301ed57fbc73127337ef7e',
        'iter.drop': 'dc7cda36e5b0a87e38a222946f49ca08329acc891ad9893aac3b18ecaa1cee29',
        'iter.take': 'da01a9b76c4fde51b9d4d407a27fe40ac416836bff274bfc0da8c4c9a2ed2982',
        'iter.map': '61d0f66e7810ce43f9c52928a1e8053e8681fe30fb6dd2421459ffd33de43132',
        'iter.filter': 'eae79e189d3122a05b4d46a5e75c0168321e615b1427703bfcfa7ec52556c56f',
        'iter.flatMap': 'da17151e29543867c079f4fc093193c7274d88a206f0313b8170bd60d581ce65',
        'iter.reduce': '7abda23099efe4cf7cffa34b036c07328d4c1cce1f908938959f085f2923cb0d',
        'iter.forEach': '067d6b785762398efbdc2a82e3a5ac418a198dd8efa857ba8b2fc97e8a1502cc',
        'iter.some': '2d447300cdd82aaa80db4e71656682485d5dea91fc8fbafd515318e93f42f53e',
        'iter.every': '2646f856a23f36c0979beffc016f39baff7bff011371107d427b86a93f1fa241',
        'iter.find': 'dbcd4527dee63794dda9a32c5eb95bafdf0ab2391a9de56dba50df7588edb80e',
        'Set.union': 'd293e2fa20794cefcabff7c9b9494a2549d66a4d8c672bb1da43cd33ca0ccac1',
        'Set.intersection': '98a0d2fc9786b58682fb5640aac69ea0682cd4c611d0ee4dff557589b6610a6e',
        'Set.difference': '8d4601f1f5154de6d3e9ca1970e5485f8e62e1a9e3b06de1496c35a9cc35983b',
        'Set.symmetricDifference': '7b98633b2db2545c78225b7db4b2e62c02ba8ad2b152a7046dfea3bc30338640',
        'Set.isSubsetOf': '4aefcfd4cbd635452515b3f7e7877d3843e7607d7279608d4422f6c3525c24cc',
        'Set.isSupersetOf': '12e599c4c8206c73e5efa17ca5e0150a7fe7d0654b78e2c24dffdc2ec92eaad9',
        'Set.isDisjointFrom': 'd09e09e6b371f881728f3c6761e68e66d47d10036701d4caa681c14187820d4c',
    },
    testnet: {
        'gasUsed': 6350,
        'objspread': 'e81180e1049b200a7d1e9ba48aa537f72b6310257b5bb6964161a0b4d0379cc6',
        'objspreadmeter': '01de3600b6d3ff059a57230b9f380f6c1c62eefd4690bb30905273fa6b3bf667',
        'String.raw': 'f851553d90518c99794146007f08c3165f6b14a7ebfa49578654cebec7168212',
        'helper.next': '05a9615ca5cd6c3e314eb0f41b54e2c2fe18521c7357ec5affd61a8ac9572cb7',
        'iter.toArray': '0f87d81d25b58a870b646445932d053bb92d43e0d7c14f8df0ad3b0caa565c90',
        'iter.drop': '2aff44d13f3d030a8c2499bceb46bc9af3590e7f6a958c15d9f5be8996298875',
        'iter.take': 'da01a9b76c4fde51b9d4d407a27fe40ac416836bff274bfc0da8c4c9a2ed2982',
        'iter.map': '61d0f66e7810ce43f9c52928a1e8053e8681fe30fb6dd2421459ffd33de43132',
        'iter.filter': 'eae79e189d3122a05b4d46a5e75c0168321e615b1427703bfcfa7ec52556c56f',
        'iter.flatMap': 'da17151e29543867c079f4fc093193c7274d88a206f0313b8170bd60d581ce65',
        'iter.reduce': '7abda23099efe4cf7cffa34b036c07328d4c1cce1f908938959f085f2923cb0d',
        'iter.forEach': '067d6b785762398efbdc2a82e3a5ac418a198dd8efa857ba8b2fc97e8a1502cc',
        'iter.some': '2d447300cdd82aaa80db4e71656682485d5dea91fc8fbafd515318e93f42f53e',
        'iter.every': '2646f856a23f36c0979beffc016f39baff7bff011371107d427b86a93f1fa241',
        'iter.find': 'dbcd4527dee63794dda9a32c5eb95bafdf0ab2391a9de56dba50df7588edb80e',
        'Set.union': '7685c41f24ef179dbb93d7398250c5203209307909bb270737ba0f2ac4434f75',
        'Set.intersection': '7685c41f24ef179dbb93d7398250c5203209307909bb270737ba0f2ac4434f75',
        'Set.difference': '7685c41f24ef179dbb93d7398250c5203209307909bb270737ba0f2ac4434f75',
        'Set.symmetricDifference': '7685c41f24ef179dbb93d7398250c5203209307909bb270737ba0f2ac4434f75',
        'Set.isSubsetOf': '7685c41f24ef179dbb93d7398250c5203209307909bb270737ba0f2ac4434f75',
        'Set.isSupersetOf': '7685c41f24ef179dbb93d7398250c5203209307909bb270737ba0f2ac4434f75',
        'Set.isDisjointFrom': '7685c41f24ef179dbb93d7398250c5203209307909bb270737ba0f2ac4434f75',
    },
};

async function readSources(network) {
    const vm = createVM({ gasCeiling: 10000000, maxCpuTimeMs: 30000 });
    vm.beginBlock();
    try {
        const r = await execute(vm, `module.exports = function(xchain) { ${BODY} };`,
            { method: 'default', network, blockContext: blockFor(network) });
        assert.strictEqual(r.success, true, r.error);
        const texts = JSON.parse(JSON.parse(r.returnValue));
        const got = { gasUsed: r.gasUsed };
        for (const [k, v] of Object.entries(texts)) got[k] = crypto.createHash('sha256').update(v).digest('hex');
        return got;
    } finally { if (vm.endBlock) vm.endBlock(); }
}

(XChainVM ? describe : describe.skip)('per-element meter: unarmed wrapper source text is unchanged', function () {
    this.timeout(60000);
    for (const network of ['mainnet', 'testnet']) {
        it(`${network}: String(fn) of every touched wrapper matches the previous release`, async function () {
            assert.deepStrictEqual(await readSources(network), PINNED[network]);
        });
    }
});
