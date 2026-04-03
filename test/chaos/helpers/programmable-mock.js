/*********************************************************************
 * Programmable Mock Providers
 *
 * Specialized fault-injectable providers for oracle and cross-chain
 * gateway paths. These are passed as opts.oracleData and
 * opts.crossChainData to vm.execute().
 *
 * NOTE: opts.state is a plain object consumed by StateManager's
 * constructor — we cannot intercept mid-execution state calls from
 * outside. For state-level fault injection, use corrupted opts.state
 * objects or contracts that trigger errors via their behavior.
 ********************************************************************/

/**
 * ProgrammableOracleProvider — oracle accessor with per-method fault rules.
 *
 * @param {object} [baseData] - Default data to return
 * @param {string} [baseData.price] - Default price return
 * @param {number} [baseData.snapshotAge] - Default snapshot age
 */
class ProgrammableOracleProvider {
    constructor(baseData) {
        this._base = baseData || {};
        this._callCounts = { getPrice: 0, getPriceAtRound: 0, getSnapshotAge: 0 };
        this._rules = [];  // [{ method, onCall, action, value }]
    }

    /**
     * Program a fault on the Nth call to a specific method.
     * @param {string} method - 'getPrice', 'getPriceAtRound', or 'getSnapshotAge'
     * @param {number} n - Call number (1-based)
     */
    onMethodCall(method, n) {
        const rule = { method, onCall: n, action: null, value: null };
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
            }
        };
    }

    _dispatch(method, args) {
        this._callCounts[method] = (this._callCounts[method] || 0) + 1;
        const count = this._callCounts[method];
        const rule = this._rules.find(r => r.method === method && r.onCall === count);
        if (rule) {
            if (rule.action === 'throw') throw rule.value;
            if (rule.action === 'return') return rule.value;
        }
        // Default behavior
        if (method === 'getPrice') return this._base.price || null;
        if (method === 'getPriceAtRound') return this._base.price || null;
        if (method === 'getSnapshotAge') return this._base.snapshotAge || 0;
        return null;
    }

    /** Build accessor object compatible with opts.oracleData. */
    asAccessor() {
        return {
            getPrice:        (coinPair) => this._dispatch('getPrice', [coinPair]),
            getPriceAtRound: (coinPair, round) => this._dispatch('getPriceAtRound', [coinPair, round]),
            getSnapshotAge:  () => this._dispatch('getSnapshotAge', [])
        };
    }

    getCallCounts() { return { ...this._callCounts }; }
}

/**
 * ProgrammableCrossChainProvider — cross-chain accessor with fault rules.
 */
class ProgrammableCrossChainProvider {
    constructor(baseData) {
        this._base = baseData || {};
        this._callCounts = { getAttestation: 0, isSettled: 0 };
        this._rules = [];
    }

    onMethodCall(method, n) {
        const rule = { method, onCall: n, action: null, value: null };
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
            }
        };
    }

    _dispatch(method, args) {
        this._callCounts[method] = (this._callCounts[method] || 0) + 1;
        const count = this._callCounts[method];
        const rule = this._rules.find(r => r.method === method && r.onCall === count);
        if (rule) {
            if (rule.action === 'throw') throw rule.value;
            if (rule.action === 'return') return rule.value;
        }
        if (method === 'getAttestation') return this._base.attestation || null;
        if (method === 'isSettled') return this._base.settled || false;
        return null;
    }

    asAccessor() {
        return {
            getAttestation: (chain, actionIndex) => this._dispatch('getAttestation', [chain, actionIndex]),
            isSettled:      (chain, actionIndex) => this._dispatch('isSettled', [chain, actionIndex])
        };
    }

    getCallCounts() { return { ...this._callCounts }; }
}

module.exports = { ProgrammableOracleProvider, ProgrammableCrossChainProvider };
