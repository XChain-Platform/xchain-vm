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
 *   {type:'endBlock'} | {type:'execute',id,opts}
 * Protocol (child → parent): {type:'ready'} | {type:'result',id,result}
 ********************************************************************/
// @ts-nocheck

const path = require('path');
const { fork } = require('child_process');
const { HostFaultError } = require('./errors.js');
const { effectiveCeiling } = require('./gas.js');

const WORKER_PATH = path.join(__dirname, 'vm-worker.js');

// Minimum spacing between respawn attempts once the executor is broken, so a
// host that can never start a worker doesn't fork-spin. Each subsequent
// execute() retries a spawn at most this often before rejecting as a host fault.
const BROKEN_RESPAWN_BACKOFF_MS = 2000;

// A spawned worker must signal 'ready' within this window or it is killed and
// counted as a spawn failure (worker init is a require + isolated-vm load,
// normally well under 2s). This keeps a child that hangs BEFORE ready inside
// the spawn-failure → HostFaultError machinery (halt and retry, a local
// fault), now that the per-request watchdog no longer covers queue wait.
const WORKER_READY_TIMEOUT_MS = 30000;

// Deterministic result for any non-gas host termination (crash / hang).
// gasUsed = ceiling matches src/index.js's timeout/OOM/stack clamp so the
// indexer's fee = gasUsed * GAS_PRICE is identical on every validator.
function hostTerminatedResult(gasCeiling, kind) {
    return {
        success:        false,
        error:          'out_of_resource: execution host terminated (' + kind + ')',
        gasUsed:        gasCeiling,
        returnValue:    null,
        stateChanges:   [],
        stateDeletes:   [],
        emittedActions: [],
        logs:           []
    };
}

class ProcessExecutor {
    constructor(config) {
        // Keep only the serializable VM config (drop execution mode etc.).
        this._config = {
            gasSchedule: config.gasSchedule,
            gasCeiling:  config.gasCeiling || 1000000,
            limits:      config.limits || null
        };
        this._gasCeiling = this._config.gasCeiling;
        // Watchdog: belt over the isolate's own maxCpuTimeMs in case the child
        // hangs (stuck isolate, native deadlock). Generous buffer above the
        // in-isolate timeout so the isolate's deterministic timeout wins normally.
        // Started at DISPATCH (see _flush), so it bounds one contract's
        // execution only, never queue wait, which varies per host.
        const cpu = (config.limits && config.limits.maxCpuTimeMs) || 30000;
        this._watchdogMs = cpu + 5000;

        this._child = null;
        this._pending = new Map();   // dispatched: id -> { resolve, reject, timer }
        this._queue = [];            // accepted, not yet dispatched: { id, opts, resolve, reject, timer }
        this._nextId = 1;
        this._inBlock = false;       // re-issue beginBlock to a respawned child
        this._shuttingDown = false;
        this._consecutiveSpawnFailures = 0;
        this._sawReady = false;
        this._broken = false;        // host fault latch: worker can't start (recoverable)
        this._lastBrokenRetryAt = 0; // backoff gate for broken-state recovery probes

        this._spawn();
    }

    _spawn() {
        if (this._shuttingDown) return;
        const child = fork(WORKER_PATH, [], {
            // Inherit stdio so the worker's console.error (e.g. [VM TIMEOUT]) is visible.
            stdio: ['ignore', 'inherit', 'inherit', 'ipc']
        });
        this._child = child;
        this._sawReady = false;
        this._spawnedAt = Date.now();

        child.on('message', (msg) => this._onMessage(msg));
        child.on('exit', (code, signal) => this._onExit(code, signal));
        child.on('error', () => { /* surfaced via 'exit' */ });

        // A child that hangs before 'ready' would otherwise stall the queue
        // forever (no exit event, nothing dispatched). Kill it and count it as
        // a spawn failure so the broken-latch path takes over.
        this._readyTimer = setTimeout(() => {
            if (!this._sawReady && this._child === child) {
                this._consecutiveSpawnFailures++;
                try { child.kill('SIGKILL'); } catch (e) {}
            }
        }, WORKER_READY_TIMEOUT_MS);

        // Initialize the worker's VM.
        this._send({ type: 'init', config: this._config });
        // A respawn mid-block must restore the worker's block state (cache only;
        // correctness holds without it, but keep behavior consistent).
        if (this._inBlock) this._send({ type: 'beginBlock' });
    }

    _send(msg) {
        const child = this._child;
        if (!child || !child.connected) return false;
        try { child.send(msg); return true; }
        catch (e) { return false; }
    }

    _onMessage(msg) {
        if (!msg) return;
        if (msg.type === 'ready') {
            this._sawReady = true;
            this._consecutiveSpawnFailures = 0;
            if (this._readyTimer) { clearTimeout(this._readyTimer); this._readyTimer = null; }
            // A fresh worker is now dispatchable; send it any queued executions
            // (e.g. the contract that followed a crashed/killed one in this block).
            this._flush();
            return;
        }
        if (msg.type === 'result') {
            const entry = this._pending.get(msg.id);
            if (!entry) return;
            this._pending.delete(msg.id);
            if (entry.timer) clearTimeout(entry.timer);
            entry.resolve(msg.result);
            // The in-flight slot is free again: dispatch the next queued entry
            // (single-in-flight invariant; see _flush). Its watchdog starts
            // NOW, at its own dispatch, never during its queue wait.
            this._flush();
        }
    }

    // Dispatch queued executions to the worker, but ONLY once it has signaled
    // 'ready'. Gating on readiness (not merely channel-connected) is what makes
    // recovery deterministic: a contract that has not started executing always
    // runs on a fresh, ready worker on every validator, instead of racing a dying
    // worker. Racing a dying worker would resolve it as a host-termination on some
    // nodes and run it on others, producing a divergent result and a fork.
    _flush() {
        // AT MOST ONE ENTRY IN FLIGHT (`_pending.size === 0` in the loop guard):
        // the worker (vm-worker.js) executes strictly sequentially, so if two
        // entries were dispatched together the 2nd's watchdog would start
        // counting while the 1st still ran head-of-line. Its effective budget
        // would become `_watchdogMs - (runtime of the contracts ahead)`, a
        // per-host wall-clock quantity: a slow validator would fabricate
        // 'watchdog timeout' (gasUsed = ceiling) for a contract a fast
        // validator executed normally → divergent status → fork. The sole
        // production embedder awaits every execute() (depth never exceeds 1),
        // but that was caller discipline, not an executor invariant; enforcing
        // it here means the watchdog provably bounds exactly one contract's
        // execution regardless of caller behavior. The next entry dispatches
        // when the current one settles (result / watchdog / worker exit).
        while (this._queue.length && this._pending.size === 0 &&
               this._child && this._sawReady && this._child.connected) {
            const entry = this._queue[0];
            if (!this._send({ type: 'execute', id: entry.id, opts: entry.opts })) break;
            this._queue.shift();
            // Watchdog starts at DISPATCH, not acceptance. The timeout must
            // bound ONE contract's execution: started at acceptance it also
            // counted queue wait, so a validator whose queue was backed up
            // (many contracts in a block, slow disk, a respawn in progress)
            // fabricated out_of_resource for a contract every other validator
            // executed normally → divergent contract status → fork. A queued
            // request that never dispatches is bounded by the worker readiness
            // timeout + spawn-failure machinery instead (HostFaultError →
            // halt and retry), which is a local fault, not a consensus result.
            entry.timer = setTimeout(() => this._onWatchdog(entry.id), this._watchdogMs);
            this._pending.set(entry.id, { resolve: entry.resolve, reject: entry.reject, timer: entry.timer, ceiling: entry.ceiling });
        }
    }

    // Dispatched but unresponsive past the in-isolate timeout + buffer: the
    // worker is stuck (hung isolate, native deadlock). Kill it (triggers
    // _onExit, then respawn) and resolve THIS request deterministically with
    // the same resource-failure clamp the in-isolate timeout would have produced.
    _onWatchdog(id) {
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
        // instead of racing the dying worker before _onExit fires (the
        // window that would otherwise host-terminate the next contract
        // nondeterministically). Safe vs the spawn-failure counter: the
        // watchdog only fires long after spawn, past _onExit's <2s guard.
        this._sawReady = false;
    }

    _onExit(code, signal) {
        const child = this._child;
        this._child = null;
        if (this._readyTimer) { clearTimeout(this._readyTimer); this._readyTimer = null; }

        // Resolve only DISPATCHED (in-flight) requests deterministically. A crash
        // here means the contract that was actually executing aborted the host. The
        // block must still advance. Queued (not-yet-dispatched) requests are left
        // intact: they never started, so they re-dispatch to the respawned worker
        // (_flush on its 'ready') and run normally, identical on every validator.
        const kind = signal ? ('signal ' + signal) : ('exit ' + code);
        for (const [id, entry] of this._pending) {
            if (entry.timer) clearTimeout(entry.timer);
            entry.resolve(hostTerminatedResult(entry.ceiling, kind));
        }
        this._pending.clear();

        if (this._shuttingDown) return;

        // Guard against a child that can't even start (e.g. isolated-vm fails to
        // load): don't respawn-spin forever.
        if (!this._sawReady && (Date.now() - this._spawnedAt) < 2000) {
            this._consecutiveSpawnFailures++;
        }
        if (this._consecutiveSpawnFailures >= 3) {
            this._broken = true;
            // The worker can't start. This is a LOCAL host fault, not a contract
            // outcome (a contract cannot make fork() fail). REJECT queued
            // (never-dispatched) executions with a host fault so the caller HALTS
            // and retries, instead of fabricating out_of_resource for work the
            // fleet runs normally (which would fork this node off the chain).
            for (const entry of this._queue) {
                if (entry.timer) clearTimeout(entry.timer);
                entry.reject(new HostFaultError('executor unavailable'));
            }
            this._queue = [];
            return;
        }
        this._spawn();
    }

    beginBlock() {
        this._inBlock = true;
        this._send({ type: 'beginBlock' });
    }

    endBlock() {
        this._inBlock = false;
        this._send({ type: 'endBlock' });
    }

    execute(opts) {
        if (this._broken) {
            // The worker could not be started (host fault: fork EAGAIN or
            // isolated-vm load failure). This is NOT a contract outcome and must
            // never be fabricated into a consensus result (it would fork). Try to
            // recover on a backoff so a TRANSIENT fault self-heals without a
            // process restart: clear the latch and probe a fresh spawn, then let
            // the request queue normally. If the probe also fails the worker
            // re-breaks and _onExit rejects the queued request (below); if it
            // succeeds the request dispatches and runs. Within the backoff window
            // we reject immediately so a persistent fault doesn't fork-spin.
            const now = Date.now();
            if (now - (this._lastBrokenRetryAt || 0) < BROKEN_RESPAWN_BACKOFF_MS) {
                return Promise.reject(new HostFaultError('executor unavailable'));
            }
            this._lastBrokenRetryAt = now;
            this._broken = false;
            this._spawn();
            // fall through and queue; _flush dispatches once/if the probe is ready.
        }
        const id = this._nextId++;
        // Resolve the per-call ceiling NOW (same helper as the in-process path in
        // index.js) so every termination clamp for this entry uses the callee's
        // caller-funded reservation, not the config ceiling.
        const ceiling = effectiveCeiling(opts && opts.gasCeiling, this._gasCeiling);
        return new Promise((resolve, reject) => {
            // No timer here: the watchdog starts when the request DISPATCHES
            // (_flush), so queue wait (which differs per host) is never part
            // of the bound. Queued requests are cleaned up by _onExit (broken
            // latch → HostFaultError) or shutdown().
            //
            // Accept into the queue, then dispatch only if a ready worker exists.
            // Never send to a worker that has not signaled 'ready' (a fresh or dying
            // one): that is the determinism-breaking race this fix closes.
            this._queue.push({ id, opts, resolve, reject, timer: null, ceiling });
            this._flush();
        });
    }

    async shutdown() {
        this._shuttingDown = true;
        if (this._readyTimer) { clearTimeout(this._readyTimer); this._readyTimer = null; }
        for (const [id, entry] of this._pending) {
            if (entry.timer) clearTimeout(entry.timer);
            entry.resolve(hostTerminatedResult(entry.ceiling, 'shutdown'));
        }
        this._pending.clear();
        for (const entry of this._queue) {
            if (entry.timer) clearTimeout(entry.timer);
            entry.resolve(hostTerminatedResult(entry.ceiling, 'shutdown'));
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
