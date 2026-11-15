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
 * Toolkit: the scaffolded test must assert the simulator's deploy verdict,
 * because the simulator registers a contract the chain refuses to DEPLOY and
 * only warns. The simulator-backed cases need the isolated-vm binding, so the
 * require is guarded and those cases SKIP where it cannot dlopen.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');

const { buildScaffold } = require('../../src/toolkit/scaffold.js');
const { toContractJs } = require('../../src/toolkit/transpile.js');

let ContractSimulator = null;
try {
    ({ ContractSimulator } = require('../../src/toolkit/simulator.js'));
} catch (e) {
    console.log('Skipping scaffold deploy-gate simulator tests (isolated-vm unavailable):', e.message);
}

const ASSERTION = /assert\.strictEqual\(dep\.deployGate\.valid, true,/;

describe('Toolkit scaffold: the generated test asserts the deploy verdict', function() {
    it('emits a deployGate.valid assertion in the JS and TS harness', function() {
        for (const useTs of [false, true]) {
            const { files, contractFile } = buildScaffold({ name: 'gate-check', typescript: useTs });
            const testJs = files['test/gate-check.test.js'];
            assert.ok(testJs, 'scaffold emitted no test file for ' + contractFile);
            assert.match(testJs, ASSERTION, 'the generated harness no longer asserts deployGate.valid');
            assert.ok(testJs.indexOf('deployGate.valid') > testJs.indexOf('initResult.success'),
                'the verdict is asserted after deploy returns, beside the constructor check');
        }
    });
});

(ContractSimulator ? describe : describe.skip)('Toolkit scaffold: deploy verdict against the simulator', function() {
    this.timeout(30000);

    async function deployQuiet(src, filename) {
        const sim = new ContractSimulator({ coin: 'BTC' });
        const real = console.warn;
        console.warn = () => {};
        try { return await sim.deploy(src, { filename, constructorParams: ['5'] }); }
        finally { console.warn = real; await sim.close(); }
    }

    it('passes the generated contract, JS and TS, with a true verdict', async function() {
        for (const useTs of [false, true]) {
            const { files, contractFile } = buildScaffold({ name: 'gate-pass', typescript: useTs });
            const dep = await deployQuiet(files['contracts/' + contractFile], contractFile);
            assert.strictEqual(dep.initResult.success, true, dep.initResult && dep.initResult.error);
            assert.strictEqual(dep.deployGate.valid, true, JSON.stringify(dep.deployGate));
        }
    });

    it('keeps initResult.success true for a contract the chain refuses, so only the verdict catches it', async function() {
        const { files, contractFile } = buildScaffold({ name: 'gate-fail' });
        const src = files['contracts/' + contractFile].replace(/meta:\s*\{[^}]*\},?/, '');
        assert.notStrictEqual(src, files['contracts/' + contractFile], 'the probe must strip the meta block');
        assert.ok(toContractJs(src, contractFile), 'the stripped contract still transpiles');
        const dep = await deployQuiet(src, contractFile);
        assert.strictEqual(dep.initResult.success, true, 'the old assertion alone stays green');
        assert.strictEqual(dep.deployGate.valid, false, JSON.stringify(dep.deployGate));
        assert.ok(dep.deployGate.error && dep.deployGate.error.length > 0, 'the verdict names the refusal');
    });
});
