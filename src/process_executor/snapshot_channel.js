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
 * Cross-chain snapshot delivery between ProcessExecutor and its worker.
 ********************************************************************/
// @ts-nocheck

const { HostFaultError } = require('../errors.js');
const { newDispatchToken } = require('./frames.js');

function hasSerializableCrossChainSnapshot(opts) {
    if (!opts || !Object.prototype.hasOwnProperty.call(opts, 'crossChainData')) return false;
    const snap = opts.crossChainData;
    return !!snap && typeof snap === 'object' && typeof snap.getAttestation !== 'function';
}

class WorkerSnapshotChannel {
    constructor(send, kill, timeoutMs) {
        this.send = send;
        this.kill = kill;
        this.timeoutMs = timeoutMs;
        this.beginBlock();
    }

    clearTimer() {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
    }

    workerSpawned() {
        this.sent = false;
        this.acked = false;
        this.clearTimer();
    }

    workerLost() {
        this.clearTimer();
    }

    beginBlock() {
        this.set = false;
        this.snapshot = null;
        this.token = null;
        this.workerSpawned();
    }

    endBlock() {
        this.beginBlock();
    }

    close() {
        this.clearTimer();
    }

    onMessage(msg) {
        if (!msg || msg.type !== 'snapshotAck') return false;
        if (this.sent && msg.token === this.token) {
            this.acked = true;
            this.clearTimer();
        }
        return true;
    }

    hold(opts, inBlock) {
        if (!this.set && inBlock && hasSerializableCrossChainSnapshot(opts)) {
            this.set = true;
            this.snapshot = opts.crossChainData;
            this.token = newDispatchToken();
        }
        if (!this.set || this.acked) return false;
        if (!this.sent) {
            this.sent = true;
            if (!this.send({ type: 'snapshot', token: this.token,
                crossChainData: this.snapshot })) {
                this.sent = false;
                this.set = false;
                this.snapshot = null;
                this.token = null;
                return false;
            }
            this.timer = setTimeout(() => {
                if (this.sent && !this.acked) this.kill();
            }, this.timeoutMs);
        }
        return true;
    }

    reference(opts) {
        if (!this.set || !hasSerializableCrossChainSnapshot(opts)) return opts;
        return Object.assign({}, opts, {
            crossChainData: { __xchainWorkerSnapshot: this.token }
        });
    }

    flush(exec) {
        // One in-flight entry keeps each watchdog tied to actual execution time.
        // The next queued entry starts only after the current entry settles.
        while (exec._queue.length && exec._pending.size === 0 &&
               exec._child && exec._sawReady && exec._child.connected) {
            const entry = exec._queue[0];
            if (this.hold(entry.opts, exec._inBlock)) return;
            const token = newDispatchToken();
            const opts = this.reference(entry.opts);
            try { exec._child.send({ type: 'execute', id: entry.id, token, opts }); }
            catch (e) {
                // A live-channel throw means this entry cannot cross IPC. Reject it
                // and leave the worker available for the next serializable entry.
                if (!exec._child.connected) break;
                exec._queue.shift();
                entry.reject(new HostFaultError('executor input not serializable: ' + e.message));
                continue;
            }
            exec._queue.shift();
            // Queue wait is host-specific, so the watchdog starts at dispatch.
            entry.timer = setTimeout(() => exec.onWatchdog(entry.id), exec._watchdogMs);
            exec._pending.set(entry.id, {
                resolve: entry.resolve, reject: entry.reject, timer: entry.timer,
                ceiling: entry.ceiling, token
            });
        }
    }
}

let workerCrossChainSnapshot = null;
let workerCrossChainSnapshotToken = null;

if (require.main && /[\\/]vm-worker[.]js$/.test(require.main.filename) &&
    typeof process.send === 'function') {
    // readonly-accessors loads this module before vm-worker installs its dispatcher.
    process.on('message', (msg) => {
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'snapshot' && typeof msg.token === 'string') {
            workerCrossChainSnapshot = msg.crossChainData;
            workerCrossChainSnapshotToken = msg.token;
            try { process.send({ type: 'snapshotAck', token: msg.token }, undefined, () => {}); }
            catch (e) {}
        } else if (msg.type === 'endBlock') {
            workerCrossChainSnapshot = null;
            workerCrossChainSnapshotToken = null;
        }
    });
}

function resolveWorkerCrossChainSnapshot(snap) {
    if (!snap || typeof snap !== 'object' ||
        !Object.prototype.hasOwnProperty.call(snap, '__xchainWorkerSnapshot')) return snap;
    if (snap['__xchainWorkerSnapshot'] !== workerCrossChainSnapshotToken)
        throw new Error('worker cross-chain snapshot reference is unavailable');
    return workerCrossChainSnapshot;
}

module.exports = { WorkerSnapshotChannel, resolveWorkerCrossChainSnapshot };
