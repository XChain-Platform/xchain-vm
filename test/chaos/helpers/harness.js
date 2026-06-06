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
 * Chaos Testing Harness
 *
 * Extends the fuzz harness with chaos-specific primitives:
 * - ProgrammableMock: fault-injectable oracle/crossChain accessor
 * - MemoryTracker: heap snapshot tracking for leak detection
 * - chaosAssertions: chaos-specific assertion helpers
 *
 * Reuses GAS_SCHEDULE, DEFAULT_LIMITS, createVM, execute, hashResult
 * from the fuzz harness to avoid duplication.
 ********************************************************************/

const assert = require('assert');
const { checkResultShape, checkAtomicity, checkNoPrototypePollution } = require('../../fuzz/invariants');

// Re-export fuzz harness utilities
const {
    GAS_SCHEDULE,
    DEFAULT_LIMITS,
    DEFAULT_BLOCK_CONTEXT,
    XChainVM,
    createVM,
    execute,
    hashResult
} = require('../../fuzz/harness');

/**
 * ProgrammableMock — fault-injectable accessor object.
 *
 * Used to build oracleData/crossChainData objects whose methods can be
 * programmed to throw, return specific values, or busy-wait on the Nth call.
 * This exploits the fact that opts.oracleData and opts.crossChainData are
 * duck-typed accessor objects whose methods are called synchronously inside
 * the bridge() closure in src/index.js.
 */
class ProgrammableMock {
    constructor() {
        this._callCount = 0;
        this._rules = [];   // [{ onCall: N, action, value }]
        this._defaultReturn = null;
    }

    /**
     * Program a fault on the Nth overall call (1-based).
     * Returns a builder with .throw(err), .returnValue(val), .delay(ms).
     */
    onCall(n) {
        const rule = { onCall: n, action: null, value: null };
        this._rules.push(rule);
        return {
            throw: (err) => {
                rule.action = 'throw';
                rule.value = err instanceof Error ? err : new Error(String(err));
                return this;
            },
            returnValue: (val) => {
                rule.action = 'return';
                rule.value = val;
                return this;
            },
            delay: (ms) => {
                rule.action = 'delay';
                rule.value = ms;
                return this;
            }
        };
    }

    /**
     * Set the default return value for calls without a matching rule.
     */
    setDefault(val) {
        this._defaultReturn = val;
        return this;
    }

    /**
     * Internal dispatch — called by accessor methods.
     */
    _dispatch() {
        this._callCount++;
        const rule = this._rules.find(r => r.onCall === this._callCount);
        if (rule) {
            if (rule.action === 'throw') throw rule.value;
            if (rule.action === 'return') return rule.value;
            if (rule.action === 'delay') {
                const end = Date.now() + rule.value;
                while (Date.now() < end) { /* busy-wait on host thread */ }
                return this._defaultReturn;
            }
        }
        return this._defaultReturn;
    }

    /** Get total calls made. */
    getCallCount() { return this._callCount; }

    /** Reset call counter and rules. */
    reset() {
        this._callCount = 0;
        this._rules = [];
    }

    /**
     * Build an oracleData-compatible accessor.
     * Every method delegates to _dispatch() so rules apply globally.
     */
    asOracleData() {
        const self = this;
        return {
            getPrice:        () => self._dispatch(),
            getPriceAtRound: () => self._dispatch(),
            getSnapshotAge:  () => { const r = self._dispatch(); return r === null ? 0 : r; }
        };
    }

    /**
     * Build a crossChainData-compatible accessor.
     */
    asCrossChainData() {
        const self = this;
        return {
            getAttestation: () => self._dispatch(),
            isSettled:      () => { const r = self._dispatch(); return r === null ? false : r; }
        };
    }
}

/**
 * MemoryTracker — records process.memoryUsage() snapshots for leak detection.
 */
class MemoryTracker {
    constructor() {
        this._snapshots = [];
    }

    /** Record a memory snapshot with a label. */
    snapshot(label) {
        const m = process.memoryUsage();
        this._snapshots.push({
            label,
            heapUsed: m.heapUsed,
            external: m.external,
            rss: m.rss,
            ts: Date.now()
        });
    }

    /** Calculate heap growth (bytes) from first to last snapshot. */
    getHeapGrowth() {
        if (this._snapshots.length < 2) return 0;
        return this._snapshots[this._snapshots.length - 1].heapUsed - this._snapshots[0].heapUsed;
    }

    /** Calculate external memory growth (bytes). */
    getExternalGrowth() {
        if (this._snapshots.length < 2) return 0;
        return this._snapshots[this._snapshots.length - 1].external - this._snapshots[0].external;
    }

    /** Check if heap growth is within tolerance (default 20MB). */
    isStable(toleranceBytes) {
        toleranceBytes = toleranceBytes || 20 * 1024 * 1024;
        return Math.abs(this.getHeapGrowth()) < toleranceBytes;
    }

    /** Get all snapshots for debugging. */
    getSnapshots() { return this._snapshots; }
}

/**
 * Chaos-specific assertion helpers.
 */
const chaosAssertions = {
    /**
     * Verify a result has the correct shape (delegates to fuzz invariants).
     */
    assertResultShape(result) {
        checkResultShape(result);
    },

    /**
     * Verify atomicity: failed executions have no state changes or emissions.
     */
    assertAtomicity(result) {
        checkAtomicity(result);
    },

    /**
     * Verify the host process prototype hasn't been polluted.
     */
    assertNoPrototypePollution() {
        checkNoPrototypePollution();
    },

    /**
     * Verify the VM recovers after a failure by executing a simple contract.
     * @returns {Promise<object>} The recovery execution result.
     */
    async assertRecovery(vm) {
        const code = 'module.exports = function(xchain) { return "recovered"; };';
        const result = await execute(vm, code);
        assert.strictEqual(result.success, true,
            'VM failed to recover after chaos fault: ' + result.error);
        assert.strictEqual(JSON.parse(result.returnValue), 'recovered');
        return result;
    },

    /**
     * Verify a result failed with a specific error substring.
     */
    assertFailedWith(result, substring) {
        assert.strictEqual(result.success, false, 'Expected failure but got success');
        assert(result.error && result.error.includes(substring),
            'Expected error containing "' + substring + '", got: ' + result.error);
    }
};

module.exports = {
    GAS_SCHEDULE,
    DEFAULT_LIMITS,
    DEFAULT_BLOCK_CONTEXT,
    XChainVM,
    createVM,
    execute,
    hashResult,
    ProgrammableMock,
    MemoryTracker,
    chaosAssertions
};
