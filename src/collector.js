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
 * XChain VM: Emission Collector
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
        // Copy params into a prototype-free object to prevent prototype pollution (RISK-10).
        const safe = Object.create(null);
        for (const key of Object.keys(params)) {
            if (key === '__proto__' || key === 'constructor') continue;
            safe[key] = params[key];
        }
        this.actions.push({ action: actionType, params: safe });
    }

    addLog(message) {
        if (this.logs.length < 100) {
            if (Buffer.byteLength(message, 'utf8') > 1024) {
                message = Buffer.from(message, 'utf8').subarray(0, 1024).toString('utf8') + '...(truncated)';
            }
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
