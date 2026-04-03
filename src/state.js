/*********************************************************************
 * XChain VM — State Manager
 *
 * Manages contract state during execution. Reads from the initial
 * state snapshot, collects writes/deletes, enforces limits.
 * The dirty map uses null to represent deleted keys.
 ********************************************************************/

class StateManager {
    constructor(initialState, limits) {
        // Filter out any null/undefined values (defensive)
        this.state = {};
        for (const [key, value] of Object.entries(initialState)) {
            if (value !== null && value !== undefined)
                this.state[key] = value;
        }
        this.dirty    = new Map();  // key -> value (null = deleted)
        this.keyCount = Object.keys(this.state).length;
        this.limits   = limits;
    }

    get(key) {
        if (this.dirty.has(key)) {
            const val = this.dirty.get(key);
            return val === null ? null : val;
        }
        if (key in this.state) return this.state[key];
        return null;
    }

    has(key) {
        if (this.dirty.has(key)) return this.dirty.get(key) !== null;
        return key in this.state;
    }

    set(key, value) {
        // Enforce max key size
        const maxKeySize = this.limits.maxStateKeySize || 1024;
        if (typeof key === 'string' && Buffer.byteLength(key, 'utf8') > maxKeySize)
            throw new Error('state key exceeds max size (' + maxKeySize + ' bytes)');

        // Reject null/undefined — use delete() to remove keys
        if (value === null || value === undefined)
            throw new Error('state value cannot be null or undefined — use state.delete() to remove keys');

        // Reject NaN/Infinity — JSON.stringify(NaN) produces "null"
        if (typeof value === 'number' && !isFinite(value))
            throw new Error('state value cannot be NaN or Infinity — use xchain.math for numeric operations');

        // Validate JSON-serializable
        const serialized = JSON.stringify(value);
        if (serialized === undefined)
            throw new Error('state value must be JSON-serializable');

        // Enforce max value size
        if (Buffer.byteLength(serialized, 'utf8') > this.limits.maxStateValueSize)
            throw new Error('state value exceeds max size (' + this.limits.maxStateValueSize + ' bytes)');

        // Enforce max key count — new key if it doesn't currently exist as live
        const isLive = this.has(key);
        if (!isLive && this.keyCount >= this.limits.maxStateKeys)
            throw new Error('contract exceeds max state keys (' + this.limits.maxStateKeys + ')');

        this.dirty.set(key, value);
        if (!isLive) this.keyCount++;
    }

    delete(key) {
        const maxKeySize = this.limits.maxStateKeySize || 1024;
        if (typeof key === 'string' && Buffer.byteLength(key, 'utf8') > maxKeySize)
            throw new Error('state key exceeds max size (' + maxKeySize + ' bytes)');

        const isLive = this.has(key);
        if (isLive) {
            this.dirty.set(key, null);
            this.keyCount--;
        }
        return isLive;
    }

    getChanges() {
        const changes = [];
        const deletes = [];
        for (const [key, value] of this.dirty) {
            if (value === null) deletes.push(key);
            else changes.push({ key, value });
        }
        return { changes, deletes };
    }
}

module.exports = StateManager;
