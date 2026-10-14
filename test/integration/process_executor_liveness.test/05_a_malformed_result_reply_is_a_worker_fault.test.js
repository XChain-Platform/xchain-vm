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
 * A result reply for the in-flight dispatch whose payload is missing or
 * not the fixed result shape rejects the run as a host fault (the caller
 * halts and retries) and the worker is replaced; it never resolves as a
 * contract result. The next run executes normally on the replacement.
 ********************************************************************/
// @ts-nocheck

const H = require('./support/liveness_setup.js');
const { assert } = H;

(H.HAVE_IVM ? describe : describe.skip)('process_executor liveness: malformed result replies', function () {
    this.timeout(60000);

    it('a result reply with no result field (real wire) rejects as a host fault', async function () {
        await H.withPreload('fake_reply_preload.js', { XVM_TEST_FAKE_REPLY: 'noresult' }, async () => {
            const exec = H.newExec();
            exec.beginBlock();
            try {
                const t = H.track(exec.execute(H.quick(1)));
                await H.waitFor(() => t.state !== 'pending', 10000);
                assert.strictEqual(t.state, 'rejected', 'a reply without a result must not resolve');
                assert.ok(H.isHostFault(t.value), 'got ' + t.value);
            } finally { await exec.shutdown(); }
        });
    });

    it('malformed payloads (missing, null, 42, string, partial) are worker faults, never results', async function () {
        const exec = H.newExec();
        exec.beginBlock();
        try {
            await exec.execute(H.quick(0));
            const bads = [undefined, null, 42, 'str', { success: true },
                { success: true, error: null, gasUsed: -1, stateChanges: [], stateDeletes: [], emittedActions: [], logs: [] }];
            for (const bad of bads) {
                const p = H.track(exec.execute(H.busy(7)));
                await H.waitFor(() => exec._pending.size === 1, 5000);
                const [id, entry] = [...exec._pending.entries()][0];
                const frame = { type: 'result', id, token: entry.token };
                if (bad !== undefined) frame.result = bad;
                exec.onMessage(frame);
                await H.waitFor(() => p.state !== 'pending', 2000);
                assert.strictEqual(p.state, 'rejected', 'payload ' + JSON.stringify(bad) + ' resolved as a result');
                assert.ok(H.isHostFault(p.value), 'got ' + p.value);
            }
            // Ignored, not faults: nothing in flight matches them.
            exec.onMessage(null);
            exec.onMessage({ type: 'nonsense', id: 1 });
            exec.onMessage({ type: 'result' });
            const r = await exec.execute(H.quick(9));
            assert.strictEqual(r.returnValue, '"r9"', 'the replacement worker serves the next run');
            assert.strictEqual(exec._broken, false, 'a bad reply from a ready worker is not a spawn failure');
        } finally { await exec.shutdown(); }
    });
});
