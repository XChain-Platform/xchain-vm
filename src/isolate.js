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
     *
     * Cache handling is API-version-specific. Under isolated-vm 5.x cached
     * compilation data is an ExternalCopy<ArrayBuffer> handle carried on the
     * ScriptInfo, NOT a Script method: you CONSUME it by passing `cachedData`,
     * and you PRODUCE it by passing `produceCachedData: true` (V8 then attaches
     * the handle as `script.cachedData`). Passing a known-good handle skips the
     * parse; absent one we produce a handle so the caller can store it. V8
     * validates the handle against the source and transparently recompiles from
     * source on any mismatch (surfaced as `script.cachedDataRejected`), so the
     * cache is a pure parse-time speedup that can never change the compiled
     * program, its gas metering, or its execution result.
     * @param {ivm.Isolate} isolate
     * @param {ivm.ExternalCopy} [cachedData] - V8 cached compilation data handle
     * @returns {ivm.Script}
     */
    compileScript(isolate, code, cachedData) {
        const opts = cachedData ? { cachedData } : { produceCachedData: true };
        return isolate.compileScriptSync(code, opts);
    }

    /**
     * Read the cached compilation data produced by a compileScript() call made
     * without a `cachedData` argument. Under isolated-vm 5.x the produced handle
     * is attached as `script.cachedData` (an ExternalCopy<ArrayBuffer>); there is
     * no `Script.createCachedData()` method in this API line (the earlier code
     * called it, so every read threw and the cache silently never populated: the
     * harness and per-block contract compiles re-parsed on every execution).
     * @param {ivm.Script} script
     * @returns {ivm.ExternalCopy|null}
     */
    getCachedData(script) {
        return (script && script.cachedData) || null;
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
