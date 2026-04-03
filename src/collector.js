/*********************************************************************
 * XChain VM — Emission Collector
 *
 * Queues emitted actions and debug logs during contract execution.
 * Enforces emission cap (maxEmissions) and log cap (100 entries, 1KB each).
 ********************************************************************/

class EmissionCollector {
    constructor(maxEmissions) {
        this.actions = [];
        this.logs    = [];
        this.max     = maxEmissions;
    }

    add(actionType, params) {
        if (this.actions.length >= this.max)
            throw new Error('emission limit exceeded (' + this.max + ')');
        this.actions.push({ action: actionType, params: { ...params } });
    }

    addLog(message) {
        if (this.logs.length < 100) {
            if (message.length > 1024)
                message = message.substring(0, 1024) + '...(truncated)';
            this.logs.push(message);
        }
    }

    isLogFull() {
        return this.logs.length >= 100;
    }

    getLogCount() {
        return this.logs.length;
    }

    getActions() { return this.actions; }
    getLogs()    { return this.logs; }
}

module.exports = EmissionCollector;
