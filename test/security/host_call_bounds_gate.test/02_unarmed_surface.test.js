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
 * Host-call bounds: the unarmed harness surface is unchanged.
 *
 * A contract can read harness function source with String(fn) and can store a
 * host-thrown error's stack text, which names a harness line and column. Where
 * the host-call bounds activation is unarmed (mainnet and testnet today), both
 * must match the develop reading in test/fixtures/host_call_surface_develop.json:
 * every xchain.* function and the JSON and join/flat wrappers by source digest and
 * by the gas String(fn) costs, and every probed throw by name, message, stack text
 * and gas. The armed harness is pinned to keep every line of the unarmed one at
 * its line number, so host-thrown stack text does not move when it arms either.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const { createVM, XChainVM } = require('../../fuzz/helpers/harness.js');
const { readSurface, THROWS } = require('../../helpers/host_call_surface.js');
const DEVELOP = require('../../fixtures/host_call_surface_develop.json');
const { HARNESS_SOURCE } = require('../../../src/index/runtime/harness_source.js');
const { HARNESS_SOURCE_HOST_CALL_BOUNDS, buildHostCallBoundsHarness } =
    require('../../../src/index/armed_harness/host_call_bounds.js');

function assertSurface(actual, expected, network) {
    assert.deepStrictEqual(Object.keys(actual.functions).sort(), Object.keys(expected.functions).sort(),
        network + ': the set of contract-reachable functions moved');
    for (const [p, want] of Object.entries(expected.functions))
        assert.deepStrictEqual(actual.functions[p], want, network + ': String(' + p + ') moved');
    for (const [k, want] of Object.entries(expected.throws))
        assert.deepStrictEqual(actual.throws[k], want, network + ': throw ' + k + ' moved');
}

(XChainVM ? describe : describe.skip)('host-call bounds: unarmed harness surface matches develop', function () {
    this.timeout(300000);

    for (const network of ['mainnet', 'testnet']) {
        it(`${network}: String(fn), its gas, and thrown-error stack text match develop`, async function () {
            assertSurface(await readSurface(createVM, network), DEVELOP.networks[network], network);
        });
    }

    it('regtest (armed): host-thrown and in-isolate stack text match the develop text', async function () {
        const armed = (await readSurface(createVM, 'regtest')).throws;
        // Where the host error stack strip is armed too, a host-thrown error reaches the
        // contract with an empty stack; its name and message are unchanged.
        const stripped = XChainVM.isHostErrorStackStripActive('regtest', 'BTC', 0);
        const want = (k) => {
            const text = DEVELOP.networks.mainnet.throws[k].returnValue;
            if (!stripped || !text.includes('<isolated-vm boundary>')) return text;
            const [name, message] = JSON.parse(text);
            return JSON.stringify([name, message, '']);
        };
        for (const k of ['emitParams', 'stateKey', 'attestationProvider', 'revert', 'inIsolate'])
            assert.strictEqual(armed[k].returnValue, want(k), k);
        // The cap refusals keep their text and only lose the reservation charge.
        for (const k of ['capExecute', 'capCrossExecute', 'capAttestation'])
            assert.strictEqual(armed[k].returnValue, want(k), k);
        assert.deepStrictEqual(Object.keys(armed), Object.keys(THROWS));
    });

    it('the armed harness keeps every unarmed line at its line number', function () {
        const plain = HARNESS_SOURCE.split('\n');
        const armed = HARNESS_SOURCE_HOST_CALL_BOUNDS.split('\n');
        const closing = plain.length - 2;   // the closing line; the text ends in a line break
        assert.strictEqual(plain[closing], '})();');
        assert.strictEqual(armed[armed.length - 2], '})();');
        let edited = 0;
        for (let i = 0; i < closing; i++) if (plain[i] !== armed[i]) edited++;
        assert.strictEqual(edited, 10, 'edited lines');
        assert.ok(armed.length > plain.length, 'helpers sit before the closing line');
    });

    it('the armed harness derivation refuses a harness it no longer matches', function () {
        assert.throws(() => buildHostCallBoundsHarness(HARNESS_SOURCE.replace('var depths = [1];', 'var depths=[1];')),
            /matched 0 times/);
        assert.throws(() => buildHostCallBoundsHarness(HARNESS_SOURCE.slice(0, -1)), /closing line/);
    });
});
