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
 * An execute() throw that escapes the worker terminates that execution
 * host. Both consensus networks resolve the run as the deterministic
 * resource-failure result at the gas ceiling, then replace the worker.
 ********************************************************************/
// @ts-nocheck

const H = require('./support/liveness_setup.js');
const { assert } = H;

(H.HAVE_IVM ? describe : describe.skip)('process_executor liveness: an escaped execute throw', function () {
    this.timeout(60000);

    it('mainnet and testnet resolve host termination at the gas ceiling and replace the worker', async function () {
        await H.withPreload('execute_throw_preload.js', { XVM_TEST_EXECUTE_THROW: '1' }, async () => {
            const exec = H.newExec();
            exec.beginBlock();
            try {
                for (const network of ['mainnet', 'testnet']) {
                    assert.ok(await H.waitFor(() => exec._child && exec._sawReady, 10000),
                        network + ' worker did not become ready');
                    const worker = exec._child;
                    const run = H.track(exec.execute(Object.assign({}, H.quick(1), { network })));
                    assert.ok(await H.waitFor(() => run.state !== 'pending', 15000),
                        network + ' execution did not settle');
                    assert.strictEqual(run.state, 'resolved', network + ' execution rejected: ' + run.value);
                    assert.strictEqual(run.value.success, false);
                    assert.strictEqual(run.value.error, 'out_of_resource: execution host terminated (exit 1)');
                    assert.strictEqual(run.value.gasUsed, H.GAS_CEILING);
                    assert.ok(await H.waitFor(() => exec._child && exec._child !== worker, 10000),
                        network + ' worker was not replaced');
                }
            } finally { await exec.shutdown(); }
        });
    });
});
