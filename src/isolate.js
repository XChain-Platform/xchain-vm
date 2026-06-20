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
 * XChain VM: Isolate Manager
 *
 * Manages V8 isolate creation, compilation, and disposal via
 * isolated-vm. All operations use synchronous APIs to prevent
 * async interleaving during contract execution.
 ********************************************************************/
// @ts-nocheck

const ivm = require('isolated-vm');

class IsolateManager {
    constructor(limits) {
        this.limits = limits;
    }

    /**
     * Create a new V8 isolate and context.
     * @returns {{ isolate: ivm.Isolate, context: ivm.Context }}
     */
    createIsolate() {
        const isolate = new ivm.Isolate({
            memoryLimit: this.limits.maxMemory  // MB
        });
        const context = isolate.createContextSync();
        return { isolate, context };
    }

    /**
     * Create a throwaway isolate for syntax validation (smaller memory limit).
     * @returns {{ isolate: ivm.Isolate }}
     */
    createThrowawayIsolate() {
        return new ivm.Isolate({ memoryLimit: 8 });
    }

    /**
     * Compile source code in an isolate.
     * @param {ivm.Isolate} isolate
     * @param {string} code
     * @param {Buffer} [cachedData] - V8 cached compilation data
     * @returns {ivm.Script}
     */
    compileScript(isolate, code, cachedData) {
        const opts = cachedData ? { cachedData } : {};
        return isolate.compileScriptSync(code, opts);
    }

    /**
     * Extract cached compilation data from a compiled script.
     * @param {ivm.Script} script
     * @returns {Buffer}
     */
    getCachedData(script) {
        return script.createCachedData();
    }

    /**
     * Safely dispose an isolate.
     * @param {ivm.Isolate} isolate
     */
    dispose(isolate) {
        try {
            if (isolate && !isolate.isDisposed)
                isolate.dispose();
        } catch (e) {
            // Already disposed or other cleanup error; ignore
        }
    }
}

module.exports = IsolateManager;
