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
 * XChain VM: Process Executor (parent side)
 *
 * Runs every contract execution in a forked child (src/vm-worker.js) that
 * holds the real in-process VM. A contract that aborts V8 (e.g. a bulk
 * allocation that bypasses the isolate memory limit and triggers a
 * process-wide SIGABRT) kills only the child, never this (indexer) host.
 *
 * On a child crash or hang, the in-flight execution resolves to a
 * DETERMINISTIC resource-failure result with gasUsed = gasCeiling (same
 * charge as the timeout/OOM clamp in vm-core), so every validator maps the
 * poisoned contract to the identical result and the block ADVANCES instead
 * of the chain halting. The child is then respawned for subsequent work.
 *
 * Protocol (parent → child): {type:'init',config} | {type:'beginBlock'} |
 *   {type:'endBlock'} | {type:'execute',id,token,opts}
 * Protocol (child → parent): {type:'ready'} | {type:'result',id,token,result} |
 *   {type:'hostfault',id,token,reason}
 * The token is a random per-dispatch value the worker echoes, so a reply is
 * accepted only for the dispatch actually in flight (process_executor/frames.js).
 *
 * The two failure kinds are NOT interchangeable. An execution that never
 * reached the contract because of a LOCAL host fault (no isolate could be
 * spawned on this machine, opts that cannot cross IPC, a worker killed from
 * outside, a worker that sent a bad reply, a shutdown) REJECTS with
 * HostFaultError, so the caller halts and retries; only an execution where
 * the contract actually ran and killed the worker resolves hostTerminatedResult.
 ********************************************************************/
// @ts-nocheck

const path = require('path');
const { fork } = require('child_process');
const { HostFaultError } = require('./errors.js');
const { effectiveCeiling } = require('./gas.js');
const { CONSENSUS_MAX_WALL_MS } = require('./consensus-wall-clock.js');
const { newDispatchToken, replyFault } = require('./process_executor/frames.js');
const { isSelfInflicted, hostTerminatedResult } = require('./process_executor/termination.js');

const WORKER_PATH = path.join(__dirname, 'vm-worker.js');

// Minimum spacing between respawn attempts once the executor is broken, so a
// host that can never start a worker doesn't fork-spin. Each subsequent
// execute() retries a spawn at most this often before rejecting as a host fault.
const BROKEN_RESPAWN_BACKOFF_MS = 2000;

// Consecutive workers lost before signaling 'ready' (a fork that failed or
// threw, an init crash at any age, a ready timeout) that trip the broken latch.
const MAX_CONSECUTIVE_SPAWN_FAILURES = 3;

// A spawned worker must signal 'ready' within this window or it is killed and
// counted as a spawn failure (worker init is a require + isolated-vm load,
// normally well under 2s). This keeps a child that hangs BEFORE ready inside
// the spawn-failure → HostFaultError machinery (halt and retry, a local
// fault), now that the per-request watchdog no longer covers queue wait.
const WORKER_READY_TIMEOUT_MS = 30000;
class ProcessExecutor {
    constructor(config, releaseSlot = () => {}) {
        this._releaseSlot = releaseSlot;
        // Keep only the serializable VM config (drop execution mode etc.).
        this._config = {
            gasSchedule: config.gasSchedule,
            gasCeiling:  config.gasCeiling || 1000000,
            limits:      config.limits || null
        };
        this._gasCeiling = this._config.gasCeiling;
        // Watchdog: belt over the isolate's own wall-clock budget in case the child
        // hangs (stuck isolate, native deadlock), with a buffer so the isolate's
        // deterministic timeout wins normally. Started at DISPATCH (see flush).
        // The floor is CONSENSUS_MAX_WALL_MS, not the node's maxCpuTimeMs: a node
        // configured tighter than the consensus budget would kill the worker
        // mid-execution and return 'out_of_resource' where every other validator
        // returned the contract's real result, an operator-configurable fork.
        const cpu = Math.max((config.limits && config.limits.maxCpuTimeMs) || 30000,
            CONSENSUS_MAX_WALL_MS);
        this._watchdogMs = cpu + 5000;

        this._child = null;
        this._pending = new Map();   // dispatched: id -> { resolve, reject, timer, ceiling, token }
        this._queue = [];            // accepted, not yet dispatched: { id, opts, resolve, reject, timer }
        this._nextId = 1;
        this._inBlock = false;       // re-issue beginBlock to a respawned child
        this._shuttingDown = false;
        this._consecutiveSpawnFailures = 0;
        this._sawReady = false;      // dispatch gate: the current worker may take work
        this._everReady = false;     // the current worker signaled ready at least once
        this._lastSpawnError = null; // errno of the last failed fork, for the latch message
        this._broken = false;        // host fault latch: worker can't start (recoverable)
        this._lastBrokenRetryAt = 0; // backoff gate for broken-state recovery probes

        this.spawn();
    }

    spawn() {
        if (this._shuttingDown) return;
        if (this._readyTimer) { clearTimeout(this._readyTimer); this._readyTimer = null; }
        this._sawReady = false;
        this._everReady = false;
        let child;
        try {
            child = fork(WORKER_PATH, [], {
                // Inherit stdio so the worker's console.error (e.g. [VM TIMEOUT]) is visible.
                stdio: ['ignore', 'inherit', 'inherit', 'ipc']
            });
        } catch (e) {
            // fork() throws synchronously for errnos outside the five it reports
            // asynchronously (ENOMEM and kin). Same accounting as any worker lost
            // before ready; never an exception out of execute() or an 'exit' handler.
            this._child = null;
            this._lastSpawnError = (e && e.code) || 'spawn error';
            this.afterWorkerLost(true);
            return;
        }
        this._child = child;
        this._lastSpawnError = null;   // re-set below if this fork fails

        // A started worker ends with 'exit' (then 'close'); a fork that failed
        // with EACCES/EAGAIN/EMFILE/ENFILE/ENOENT emits 'error' and 'close' but
        // never 'exit'. Whichever comes first runs the death path, once.
        let gone = false;
        const onGone = (code, signal) => {
            if (gone) return;
            gone = true;
            this.onExit(child, code, signal);
        };
        child.on('message', (msg) => this.onMessage(msg, child));
        child.on('exit', onGone);
        child.on('close', onGone);
        child.on('error', (err) => {
            // A spawn-syscall error means the fork itself failed; 'close' follows and
            // counts it. Any other error (a failed send or kill) is followed by 'exit' if fatal.
            if (err && /^spawn/.test(String(err.syscall))) this._lastSpawnError = err.code || 'spawn error';
        });

        // A child that hangs before 'ready' would otherwise stall the queue
        // forever (nothing dispatched). Kill it and run its death path now, so
        // it counts as a spawn failure even if no 'exit' ever arrives.
        this._readyTimer = setTimeout(() => {
            if (!this._everReady && this._child === child) {
                try { child.kill('SIGKILL'); } catch (e) {}
                onGone(null, 'SIGKILL');
            }
        }, WORKER_READY_TIMEOUT_MS);

        // Initialize the worker's VM.
        this.send({ type: 'init', config: this._config });
        // A respawn mid-block must restore the worker's block state (cache only;
        // correctness holds without it, but keep behavior consistent).
        if (this._inBlock) this.send({ type: 'beginBlock' });
    }

    send(msg) {
        const child = this._child;
        if (!child || !child.connected) return false;
        try { child.send(msg); return true; }
        catch (e) { return false; }
    }

    onMessage(msg, child) {
        // A frame from a worker already replaced says nothing about the current one.
        if (child && child !== this._child) return;
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'ready') {
            // A worker signals ready once. A repeat must not re-open dispatch to
            // a worker the watchdog or a bad frame has just marked for death.
            if (this._everReady) return;
            this._sawReady = true;
            this._everReady = true;
            this._consecutiveSpawnFailures = 0;
            this._lastSpawnError = null;
            if (this._readyTimer) { clearTimeout(this._readyTimer); this._readyTimer = null; }
            // A fresh worker is now dispatchable; send it any queued executions
            // (e.g. the contract that followed a crashed/killed one in this block).
            this.flush();
            return;
        }
        if (msg.type !== 'result' && msg.type !== 'hostfault') return;
        const entry = this._pending.get(msg.id);
        // A reply for an id not in flight (already settled by the watchdog or an
        // exit, or a duplicate) is a no-op, never a second settle.
        if (!entry) return;
        const fault = replyFault(msg, entry.token);
        if (fault) { this.onBadReply(msg.id, fault); return; }
        this._pending.delete(msg.id);
        if (entry.timer) clearTimeout(entry.timer);
        if (msg.type === 'result') {
            entry.resolve(msg.result);
        } else {
            // 'hostfault': THIS machine could not spawn an isolate for the contract,
            // so no contract code ran. REJECT and the caller halts and retries;
            // resolving hostTerminatedResult would commit 'out_of_resource' and fork
            // this node. The worker started fine: spawn accounting is untouched.
            const reason = typeof msg.reason === 'string' && msg.reason ? msg.reason : 'executor unavailable';
            entry.reject(new HostFaultError(reason));
        }
        // The in-flight slot is free again: dispatch the next queued entry
        // (single-in-flight invariant; see flush). Its watchdog starts
        // NOW, at its own dispatch, never during its queue wait.
        this.flush();
    }

    // A reply naming the in-flight id that does not answer its dispatch or carries
    // no well-formed result is a worker fault, never a result: reject the run as a
    // host fault (halt and retry), kill the worker and let onExit respawn it. The
    // worker reached ready, so its death does not count toward the broken latch.
    onBadReply(id, fault) {
        const entry = this._pending.get(id);
        this._pending.delete(id);
        if (entry.timer) clearTimeout(entry.timer);
        entry.reject(new HostFaultError('executor worker sent a bad reply (' + fault + ')'));
        const child = this._child;
        if (child) { try { child.kill('SIGKILL'); } catch (e) {} }
        this._sawReady = false;
    }

    // Dispatch queued executions to the worker, but ONLY once it has signaled
    // 'ready'. Gating on readiness (not merely channel-connected) is what makes
    // recovery deterministic: a contract that has not started executing always
    // runs on a fresh, ready worker on every validator, instead of racing a dying
    // worker. Racing a dying worker would resolve it as a host-termination on some
    // nodes and run it on others, producing a divergent result and a fork.
    flush() {
        // AT MOST ONE ENTRY IN FLIGHT (`_pending.size === 0` in the loop guard):
        // the worker executes strictly sequentially, so a 2nd entry dispatched
        // alongside would start its watchdog while the 1st still ran, and a slow
        // validator would fabricate 'watchdog timeout' for a contract a fast one
        // ran normally → fork. The next entry dispatches when the current one
        // settles (result / watchdog / worker exit).
        while (this._queue.length && this._pending.size === 0 &&
               this._child && this._sawReady && this._child.connected) {
            const entry = this._queue[0];
            const token = newDispatchToken();
            try { this._child.send({ type: 'execute', id: entry.id, token, opts: entry.opts }); }
            catch (e) {
                // A throw on a live channel is this entry's opts failing to serialize
                // (a BigInt, a cycle). Settle it as a host fault so the queue keeps moving.
                if (!this._child.connected) break;
                this._queue.shift();
                entry.reject(new HostFaultError('executor input not serializable: ' + e.message));
                continue;
            }
            this._queue.shift();
            // Watchdog starts at DISPATCH: counting queue wait (which varies per
            // host) would fabricate out_of_resource on a backed-up validator → fork.
            // A never-dispatched request is bounded by the spawn-failure latch instead.
            entry.timer = setTimeout(() => this.onWatchdog(entry.id), this._watchdogMs);
            this._pending.set(entry.id, { resolve: entry.resolve, reject: entry.reject, timer: entry.timer, ceiling: entry.ceiling, token });
        }
    }

    // Dispatched but unresponsive past the in-isolate timeout + buffer: the
    // worker is stuck (hung isolate, native deadlock). Kill it (triggers
    // onExit, then respawn) and resolve THIS request deterministically with
    // the same resource-failure clamp the in-isolate timeout would have produced.
    onWatchdog(id) {
        const entry = this._pending.get(id);
        if (!entry) return;
        this._pending.delete(id);
        // Per-entry ceiling: a host-terminated nested (cross-contract) call must
        // clamp to its caller-funded reservation, exactly like the in-isolate
        // clamps. A 1M charge against a 50k reservation would diverge the fee.
        entry.resolve(hostTerminatedResult(entry.ceiling, 'watchdog timeout'));
        const child = this._child;
        if (child) { try { child.kill('SIGKILL'); } catch (e) {} }
        // Mark the killed worker un-dispatchable NOW, synchronously, so the
        // NEXT execute() in this block queues until the respawn is 'ready'
        // instead of racing the dying worker before onExit fires. Safe vs the
        // spawn-failure counter: that counts only workers that never reached
        // ready (_everReady), and a dispatched worker always had.
        this._sawReady = false;
    }

    onExit(child, code, signal) {
        if (child !== this._child) return;   // a worker already replaced or shut down
        this._child = null;
        if (this._readyTimer) { clearTimeout(this._readyTimer); this._readyTimer = null; }

        // Settle only DISPATCHED requests. A self-inflicted death is the contract
        // aborting the host: resolve it deterministically so the block advances.
        // Any other death is local: reject so the caller halts. The executor's
        // own kills empty _pending first; queued requests re-dispatch.
        const kind = signal ? ('signal ' + signal) : ('exit ' + code);
        const selfInflicted = isSelfInflicted(code, signal);
        for (const [id, entry] of this._pending) {
            if (entry.timer) clearTimeout(entry.timer);
            if (selfInflicted) entry.resolve(hostTerminatedResult(entry.ceiling, kind));
            else entry.reject(new HostFaultError('executor worker terminated externally (' + kind + ')'));
        }
        this._pending.clear();
        this.afterWorkerLost(!this._everReady);
    }

    // Respawn after losing a worker, or latch broken. Every worker lost before it
    // signaled ready counts, whatever its age: a cutoff on age let a worker that
    // always died just past it respawn forever. A dispatched worker had reached
    // ready, so a contract-caused death or a watchdog kill never counts.
    afterWorkerLost(neverReady) {
        if (this._shuttingDown) return;
        if (neverReady) this._consecutiveSpawnFailures++;
        if (this._consecutiveSpawnFailures >= MAX_CONSECUTIVE_SPAWN_FAILURES) {
            this._broken = true;
            // The worker can't start. This is a LOCAL host fault, not a contract
            // outcome (a contract cannot make fork() fail). REJECT queued
            // (never-dispatched) executions with a host fault so the caller HALTS
            // and retries, instead of fabricating out_of_resource for work the
            // fleet runs normally (which would fork this node off the chain).
            const reason = this.unavailableReason();
            for (const entry of this._queue) {
                if (entry.timer) clearTimeout(entry.timer);
                entry.reject(new HostFaultError(reason));
            }
            this._queue = [];
            return;
        }
        this.spawn();
    }

    unavailableReason() {
        return this._lastSpawnError ? 'executor unavailable (spawn ' + this._lastSpawnError + ')' : 'executor unavailable';
    }

    beginBlock() {
        this._inBlock = true;
        this.send({ type: 'beginBlock' });
    }

    endBlock() {
        this._inBlock = false;
        this.send({ type: 'endBlock' });
    }

    execute(opts) {
        // No worker is spawned or dispatched after shutdown(), so a queued entry would never settle.
        if (this._shuttingDown) return Promise.reject(new HostFaultError('executor shutting down'));
        if (this._broken) {
            // The worker could not be started: a host fault, never a consensus
            // result. Past the backoff, clear the latch and probe a fresh spawn so a
            // TRANSIENT fault self-heals; the request queues, and a failed probe
            // re-latches and rejects it. Inside the window, reject at once.
            const now = Date.now();
            if (now - (this._lastBrokenRetryAt || 0) < BROKEN_RESPAWN_BACKOFF_MS) {
                return Promise.reject(new HostFaultError(this.unavailableReason()));
            }
            this._lastBrokenRetryAt = now;
            this._broken = false;
            this.spawn();
            // A probe whose fork() threw re-latched synchronously, before this
            // request could queue, so nothing would ever settle it: reject now.
            if (this._broken) return Promise.reject(new HostFaultError(this.unavailableReason()));
        }
        const id = this._nextId++;
        // Resolve the per-call ceiling NOW (same helper as the in-process path in
        // index.js) so every termination clamp for this entry uses the callee's
        // caller-funded reservation, not the config ceiling.
        const ceiling = effectiveCeiling(opts && opts.gasCeiling, this._gasCeiling);
        return new Promise((resolve, reject) => {
            // No timer here: the watchdog starts at DISPATCH (flush). Queued requests
            // are settled by the broken latch or shutdown(), never by a timer.
            this._queue.push({ id, opts, resolve, reject, timer: null, ceiling });
            this.flush();
        });
    }

    async shutdown() {
        this._shuttingDown = true;
        this._releaseSlot();
        if (this._readyTimer) { clearTimeout(this._readyTimer); this._readyTimer = null; }
        // A local shutdown is not a contract outcome, even for a dispatched request
        // whose contract had started: every peer finishes it normally, so reject it.
        // Queued (never-dispatched) requests never ran: reject them the same way.
        for (const [id, entry] of this._pending) {
            if (entry.timer) clearTimeout(entry.timer);
            entry.reject(new HostFaultError('executor shutting down'));
        }
        this._pending.clear();
        for (const entry of this._queue) {
            if (entry.timer) clearTimeout(entry.timer);
            entry.reject(new HostFaultError('executor shutting down'));
        }
        this._queue = [];
        const child = this._child;
        this._child = null;
        if (child) {
            try { child.disconnect(); } catch (e) {}
            try { child.kill('SIGKILL'); } catch (e) {}
        }
    }
}
module.exports = ProcessExecutor;
