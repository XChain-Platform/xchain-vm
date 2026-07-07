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

// Recursively copy a JSON-shaped value into prototype-free containers, dropping
// any `__proto__`/`constructor` OWN key at EVERY level (RISK-10). The original
// shallow strip only cleaned the top-level params object, so a nested own
// `__proto__` (reachable via JSON.parse, which makes it a normal own key rather
// than invoking the prototype setter) survived into the emission and was handed
// to the indexer. Iterative (explicit stack, never recurses) because emitted
// params are a bounded JSON tree: no cycles (JSON has no shared refs) and total
// size already gas-metered at the wrap() marshaling boundary, so the walk is
// O(size) with no host-side stack-overflow risk. For any param WITHOUT such keys
// the JSON serialization is byte-identical to the shallow-strip output (JSON uses
// only own enumerable keys, and a null-proto object serializes the same), so this
// changes the emitted hash only for pathological params.
function deepStripParams(root) {
    const makeContainer = (v) => Array.isArray(v) ? [] : Object.create(null);
    if (root === null || typeof root !== 'object') return root;
    const out = makeContainer(root);
    const stack = [[root, out]];
    while (stack.length) {
        const [src, dst] = stack.pop();
        if (Array.isArray(src)) {
            for (let i = 0; i < src.length; i++) {
                const val = src[i];
                if (val !== null && typeof val === 'object') {
                    const child = makeContainer(val); dst[i] = child; stack.push([val, child]);
                } else dst[i] = val;
            }
        } else {
            for (const key of Object.keys(src)) {
                if (key === '__proto__' || key === 'constructor') continue;
                const val = src[key];
                if (val !== null && typeof val === 'object') {
                    const child = makeContainer(val); dst[key] = child; stack.push([val, child]);
                } else dst[key] = val;
            }
        }
    }
    return out;
}

class EmissionCollector {
    constructor(maxEmissions, deepStrip) {
        this.actions    = [];
        this.logs       = [];
        this.max        = maxEmissions;
        // Gated (index.js F-PS): true => recursive strip; false => legacy shallow
        // top-level strip, preserving pre-flag-day replay bit-for-bit.
        this.deepStrip  = !!deepStrip;
    }

    add(actionType, params) {
        if (this.actions.length >= this.max)
            throw new Error('emission limit exceeded (' + this.max + ')');
        let safe;
        if (this.deepStrip) {
            safe = deepStripParams(params);
        } else {
            // Legacy shallow strip: prototype-free copy of the TOP LEVEL only.
            safe = Object.create(null);
            for (const key of Object.keys(params)) {
                if (key === '__proto__' || key === 'constructor') continue;
                safe[key] = params[key];
            }
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
