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
const { closureAccessorField } = require('./opts_guard.js');
const { isDeepStrictEqual } = require('util');

function hasSerializableCrossChainSnapshot(opts) {
    if (!opts || !Object.prototype.hasOwnProperty.call(opts, 'crossChainData')) return false;
    const snap = opts.crossChainData;
    return !!snap && typeof snap === 'object' && typeof snap.getAttestation !== 'function';
}

// Consecutive workers lost with a snapshot sent but not acknowledged before
// the held queue is handed back as a host fault. Reset only by an accepted ack
// or a new block, so a worker that dies on the snapshot cannot respawn forever.
const MAX_UNACKED_SNAPSHOT_LOSSES = 3;

// In-block executions should reuse one immutable snapshot object. Equal copies
// may use the pinned token too. Any different snapshot travels inline so the
// subprocess observes the same input as the in-process executor.
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

    // True once enough consecutive workers died holding an unacknowledged snapshot.
    workerLost() {
        if (this.sent && !this.acked) this.unackedLosses += 1;
        this.clearTimer();
        return this.unackedLosses >= MAX_UNACKED_SNAPSHOT_LOSSES;
    }

    beginBlock() {
        this.set = false;
        this.snapshot = null;
        this.token = null;
        this.inlineMismatches = 0;
        this.unackedLosses = 0;
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
            this.unackedLosses = 0;
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
        if (opts.crossChainData !== this.snapshot &&
            !isDeepStrictEqual(opts.crossChainData, this.snapshot)) {
            this.inlineMismatches += 1;
            if (this.inlineMismatches === 1) {
                process.emitWarning(
                    'in-block cross-chain snapshot differs from the pinned snapshot; sending inline',
                    'XChainVMSnapshotWarning');
            }
            return opts;
        }
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
            const closure = closureAccessorField(entry.opts);
            if (closure) {
                exec._queue.shift();
                entry.reject(new HostFaultError('executor input not serializable: ' + closure +
                    ' is a closure accessor and cannot cross the worker channel; pass a plain snapshot'));
                continue;
            }
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
    // Halt on a stale reference: it is this worker's IPC state, which no contract can
    // influence, so committing it as a failed result would fork from every healthy peer.
    if (snap['__xchainWorkerSnapshot'] !== workerCrossChainSnapshotToken)
        throw new HostFaultError('worker cross-chain snapshot reference is unavailable');
    return workerCrossChainSnapshot;
}

module.exports = { WorkerSnapshotChannel, resolveWorkerCrossChainSnapshot, MAX_UNACKED_SNAPSHOT_LOSSES };
