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
const { HostFaultError } = require('./errors.js');

let vm = null;

// Coverage-harness support. The isolate-execution code that runs ONLY
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
                // vm.execute() throwing is a HOST fault, not a contract outcome, and
                // the two host-fault shapes need OPPOSITE handling.
                //
                // A HostFaultError says THIS MACHINE cannot run the contract at all:
                // index.js raises it when isolateManager.createIsolate() fails, and
                // syntax.js raises it when the execute-time lint isolate cannot be
                // spawned (reaching execute() through _getLintVerdict, outside its own
                // try block). Both are properties of this host's memory/thread budget,
                // not of the contract, so every healthy peer commits a normal result
                // for the same execution. Dying here handed the parent's crash clamp a
                // dispatched entry, which resolved a committed
                // 'out_of_resource: execution host terminated' at gasUsed = ceiling --
                // a unilateral fork, and the exact laundering index.js:_classifyError
                // re-throws HostFaultError to prevent. Report it instead; the parent
                // rejects the request so the caller HALTS and retries, which is the
                // rule process-executor already enforces for queued and shutdown work.
                // Tested with instanceof, never e.code or the message: an error that
                // crossed the isolate boundary arrives as a plain host Error built from
                // contract-controlled text, and a name/code match would let a contract
                // spoof a chain-wide halt (same anti-spoof rule as _classifyError).
                //
                // Every OTHER throw still dies into the parent's deterministic
                // host-termination machinery (_onExit -> hostTerminatedResult), which
                // clamps the request to its caller-funded ceiling identically on every
                // validator, exactly as an in-isolate resource failure would.
                if (e instanceof HostFaultError) {
                    send({
                        type: 'hostfault',
                        id: msg.id,
                        reason: String((e && e.message) || 'executor unavailable').slice(0, 200)
                    });
                    // The isolate never came up, so worker state is intact (execute()'s
                    // finally disposes nothing when createIsolate threw). Staying alive
                    // avoids a respawn for what is usually a transient pressure blip.
                    flushCoverage();
                    return;
                }
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
