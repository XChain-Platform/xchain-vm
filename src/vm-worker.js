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
 * XChain VM: Worker (child side)
 *
 * Forked by src/process-executor.js. Holds ONE in-process XChainVM and runs
 * contract executions on its behalf. If a contract aborts V8, THIS process
 * dies and the parent maps it to a deterministic resource-failure result.
 * the indexer host stays alive.
 *
 * Messages are processed strictly sequentially (one execute at a time) to
 * preserve the synchronous-execution / per-block-cache determinism the VM
 * relies on.
 ********************************************************************/
// @ts-nocheck

const XChainVM = require('./index.js');

let vm = null;

// Coverage-harness support . The isolate-execution code that runs ONLY
// in this forked child (this worker's message handlers plus sandbox.stripGlobals
// and the in-isolate paths of index.execute) is invisible to a parent-process
// coverage run unless the child flushes its V8 coverage to the NODE_V8_COVERAGE
// directory before the parent tears it down. The parent SIGKILLs the worker on
// shutdown/respawn (see process-executor.js), and SIGKILL cannot flush, so relying
// on clean exit alone loses the execute path (it raced the kill). Flushing after
// each execute writes the accumulated profile to disk deterministically. Guarded
// on NODE_V8_COVERAGE, so it is completely inert in production (which never sets
// it): the require and takeCoverage() only ever run under a coverage harness.
const COVERAGE_ON = !!process.env.NODE_V8_COVERAGE;
let _v8 = null;
function flushCoverage() {
    if (!COVERAGE_ON) return;
    try {
        if (!_v8) _v8 = require('v8');
        _v8.takeCoverage();
    } catch (e) { /* best-effort: coverage tooling only, never a runtime path */ }
}

// Sequential message queue: chain handlers so executes never interleave.
let chain = Promise.resolve();
function enqueue(fn) {
    chain = chain.then(fn).catch(() => {});
}

function send(msg) {
    if (process.connected) {
        // process.send can fail SYNCHRONOUSLY (caught here) or ASYNCHRONOUSLY: the IPC
        // write is buffered and may fail later (e.g. EPIPE when the parent disconnected
        // during teardown). Per Node docs, an async failure with no send callback emits an
        // unhandled 'error' on the process and crashes the worker; passing a no-op callback
        // absorbs it. The worker is being torn down in that case, so the dropped message is
        // moot (the parent already reads execution results as a value, not from late IPC).
        try { process.send(msg, undefined, () => {}); } catch (e) { /* parent gone */ }
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
        enqueue(() => { if (vm) { vm.endBlock(); flushCoverage(); } });
        return;
    }

    if (msg.type === 'execute') {
        enqueue(async () => {
            let result;
            try {
                result = await vm.execute(msg.opts);
            } catch (e) {
                // vm.execute() throwing is a HOST fault, not a contract outcome:
                // the throwing window is host-side construction (new GasTracker /
                // new StateManager) that runs BEFORE execute()'s own try block, and
                // a contract cannot make those throw. Fabricating a consensus result
                // here was a fork hazard: gasUsed:0 zeroes the fee, the 'error:'
                // prefix maps to the frozen failed status, and the raw host
                // exception text leaked cross-chain via VM_ERROR_MESSAGE. Instead
                // die, so the parent's deterministic host-termination machinery
                // (process-executor _onExit, hostTerminatedResult) clamps this
                // request to its caller-funded ceiling, identically on every
                // validator, exactly as an in-isolate resource failure would.
                process.exit(1);
                return;
            }
            send({ type: 'result', id: msg.id, result });
            // Persist this execution's coverage before the parent can SIGKILL the
            // worker (inert unless a coverage harness set NODE_V8_COVERAGE).
            flushCoverage();
        });
        return;
    }
});

// If the parent disconnects (shutdown / crash), flush any pending coverage
// (best-effort; races the parent's SIGKILL) and exit cleanly.
process.on('disconnect', () => { flushCoverage(); process.exit(0); });
