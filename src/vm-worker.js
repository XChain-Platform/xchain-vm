/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * XChain VM — Worker (child side)
 *
 * Forked by src/process-executor.js. Holds ONE in-process XChainVM and runs
 * contract executions on its behalf. If a contract aborts V8, THIS process
 * dies and the parent maps it to a deterministic resource-failure result —
 * the indexer host stays alive.
 *
 * Messages are processed strictly sequentially (one execute at a time) to
 * preserve the synchronous-execution / per-block-cache determinism the VM
 * relies on.
 ********************************************************************/
// @ts-nocheck

const XChainVM = require('./index.js');

let vm = null;

// Sequential message queue — chain handlers so executes never interleave.
let chain = Promise.resolve();
function enqueue(fn) {
    chain = chain.then(fn).catch(() => {});
}

function send(msg) {
    if (process.connected) {
        try { process.send(msg); } catch (e) { /* parent gone */ }
    }
}

process.on('message', (msg) => {
    if (!msg) return;

    if (msg.type === 'init') {
        // Force in-process mode in the child (never recurse into another fork).
        vm = new XChainVM(Object.assign({}, msg.config, { execution: 'in-process' }));
        send({ type: 'ready' });
        return;
    }

    if (msg.type === 'beginBlock') {
        enqueue(() => { if (vm) vm.beginBlock(); });
        return;
    }

    if (msg.type === 'endBlock') {
        enqueue(() => { if (vm) vm.endBlock(); });
        return;
    }

    if (msg.type === 'execute') {
        enqueue(async () => {
            let result;
            try {
                result = await vm.execute(msg.opts);
            } catch (e) {
                // vm.execute() should never throw; if it does, surface a clean
                // failure rather than crashing the worker.
                result = {
                    success: false,
                    error: 'error: worker execute threw: ' + (e && e.message ? e.message : 'unknown'),
                    gasUsed: 0, returnValue: null,
                    stateChanges: [], stateDeletes: [], emittedActions: [], logs: []
                };
            }
            send({ type: 'result', id: msg.id, result });
        });
        return;
    }
});

// If the parent disconnects (shutdown / crash), exit cleanly.
process.on('disconnect', () => process.exit(0));
