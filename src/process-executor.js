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
 * XChain VM — Process Executor (parent side)
 *
 * Runs every contract execution in a forked child (src/vm-worker.js) that
 * holds the real in-process VM. A contract that aborts V8 — e.g. a bulk
 * allocation that bypasses the isolate memory limit and triggers a
 * process-wide SIGABRT — kills only the child, never this (indexer) host.
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

const WORKER_PATH = path.join(__dirname, 'vm-worker.js');

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
        const cpu = (config.limits && config.limits.maxCpuTimeMs) || 30000;
        this._watchdogMs = cpu + 5000;

        this._child = null;
        this._pending = new Map();   // dispatched: id -> { resolve, timer }
        this._queue = [];            // accepted, not yet dispatched: { id, opts, resolve, timer }
        this._nextId = 1;
        this._inBlock = false;       // re-issue beginBlock to a respawned child
        this._shuttingDown = false;
        this._consecutiveSpawnFailures = 0;
        this._sawReady = false;

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

        // Initialize the worker's VM.
        this._send({ type: 'init', config: this._config });
        // A respawn mid-block must restore the worker's block state (cache only —
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
            // A fresh worker is now dispatchable — send it any queued executions
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
        }
    }

    // Dispatch queued executions to the worker, but ONLY once it has signaled
    // 'ready'. Gating on readiness (not merely channel-connected) is what makes
    // recovery deterministic: a contract that has not started executing always
    // runs on a fresh, ready worker on every validator, instead of racing a dying
    // worker — which would resolve it as a host-termination on some nodes and run
    // it on others → divergent result → fork.
    _flush() {
        while (this._queue.length && this._child && this._sawReady && this._child.connected) {
            const entry = this._queue[0];
            if (!this._send({ type: 'execute', id: entry.id, opts: entry.opts })) break;
            this._queue.shift();
            this._pending.set(entry.id, { resolve: entry.resolve, timer: entry.timer });
        }
    }

    _onExit(code, signal) {
        const child = this._child;
        this._child = null;

        // Resolve only DISPATCHED (in-flight) requests deterministically — a crash
        // here means the contract that was actually executing aborted the host. The
        // block must still advance. Queued (not-yet-dispatched) requests are left
        // intact: they never started, so they re-dispatch to the respawned worker
        // (_flush on its 'ready') and run normally — identical on every validator.
        const kind = signal ? ('signal ' + signal) : ('exit ' + code);
        for (const [id, entry] of this._pending) {
            if (entry.timer) clearTimeout(entry.timer);
            entry.resolve(hostTerminatedResult(this._gasCeiling, kind));
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
            // The worker can't start — drain queued (never-dispatched) executions to
            // the same deterministic result so callers don't hang until their watchdog.
            for (const entry of this._queue) {
                if (entry.timer) clearTimeout(entry.timer);
                entry.resolve(hostTerminatedResult(this._gasCeiling, 'executor unavailable'));
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
            return Promise.resolve(hostTerminatedResult(this._gasCeiling, 'executor unavailable'));
        }
        const id = this._nextId++;
        return new Promise((resolve) => {
            // Watchdog started at acceptance so it bounds queue-wait + execution — a
            // deterministic upper time bound regardless of where the request sits.
            const timer = setTimeout(() => {
                // Still queued (never dispatched): the worker never became ready in
                // time. Resolve deterministically; there is no worker to kill.
                const qi = this._queue.findIndex((e) => e.id === id);
                if (qi !== -1) {
                    this._queue.splice(qi, 1);
                    resolve(hostTerminatedResult(this._gasCeiling, 'watchdog timeout'));
                    return;
                }
                // Dispatched but unresponsive: kill the worker (triggers _onExit →
                // respawn) and return the deterministic result for THIS request.
                if (!this._pending.has(id)) return;
                this._pending.delete(id);
                resolve(hostTerminatedResult(this._gasCeiling, 'watchdog timeout'));
                const child = this._child;
                if (child) { try { child.kill('SIGKILL'); } catch (e) {} }
                // Mark the killed worker un-dispatchable NOW, synchronously, so the
                // NEXT execute() in this block queues until the respawn is 'ready'
                // instead of racing the dying worker before _onExit fires (the
                // window that would otherwise host-terminate the next contract
                // nondeterministically). Safe vs the spawn-failure counter: the
                // watchdog only fires long after spawn, past _onExit's <2s guard.
                this._sawReady = false;
            }, this._watchdogMs);

            // Accept into the queue, then dispatch only if a ready worker exists.
            // Never send to a worker that has not signaled 'ready' (a fresh or dying
            // one) — that is the determinism-breaking race this fix closes.
            this._queue.push({ id, opts, resolve, timer });
            this._flush();
        });
    }

    async shutdown() {
        this._shuttingDown = true;
        for (const [id, entry] of this._pending) {
            if (entry.timer) clearTimeout(entry.timer);
            entry.resolve(hostTerminatedResult(this._gasCeiling, 'shutdown'));
        }
        this._pending.clear();
        for (const entry of this._queue) {
            if (entry.timer) clearTimeout(entry.timer);
            entry.resolve(hostTerminatedResult(this._gasCeiling, 'shutdown'));
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
