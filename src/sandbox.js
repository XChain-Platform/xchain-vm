/*********************************************************************
 * XChain VM — Sandbox
 *
 * Strips non-deterministic and dangerous APIs from the V8 isolate
 * context. Only safe, deterministic builtins survive.
 ********************************************************************/

const ivm = require('isolated-vm');

// Script that runs inside the isolate to strip globals that can't
// be reached via setSync from the host (e.g., properties on existing objects)
const STRIP_SCRIPT = `
(function() {
    // Remove non-deterministic globals
    const toDelete = [
        'Date', 'setTimeout', 'setInterval', 'setImmediate',
        'clearTimeout', 'clearInterval', 'clearImmediate',
        'WeakRef', 'FinalizationRegistry', 'Proxy',
        'fetch', 'XMLHttpRequest', 'WebSocket',
        'SharedArrayBuffer', 'Atomics',
        'queueMicrotask'
    ];
    for (const name of toDelete) {
        try { delete globalThis[name]; } catch(e) {}
        try { globalThis[name] = undefined; } catch(e) {}
    }

    // Block eval and Function constructor
    try { globalThis.eval = undefined; } catch(e) {}
    try {
        // Prevent new Function('return process')()
        const OrigFunction = Function;
        globalThis.Function = undefined;
        // Also kill the constructor on Function.prototype
        try { Object.defineProperty(OrigFunction.prototype, 'constructor', { value: undefined }); } catch(e) {}
    } catch(e) {}

    // Remove console (replaced by xchain.log)
    try { globalThis.console = undefined; } catch(e) {}

    // Remove process/require/import (shouldn't exist in isolate, but defensive)
    try { globalThis.process = undefined; } catch(e) {}
    try { globalThis.require = undefined; } catch(e) {}
    try { globalThis.importScripts = undefined; } catch(e) {}

    // Replace Math with deterministic subset (no Math.random)
    const SafeMath = {
        floor: Math.floor,
        ceil:  Math.ceil,
        round: Math.round,
        abs:   Math.abs,
        min:   Math.min,
        max:   Math.max,
        sqrt:  Math.sqrt,
        pow:   Math.pow,
        sign:  Math.sign,
        trunc: Math.trunc,
        log:   Math.log,
        log2:  Math.log2,
        log10: Math.log10,
        PI:    Math.PI,
        E:     Math.E
    };
    globalThis.Math = Object.freeze(SafeMath);
})();
`;

/**
 * Strip non-deterministic APIs from the isolate context.
 * Must be called BEFORE injecting the gateway and __gas.
 * @param {ivm.Isolate} isolate
 * @param {ivm.Context} context
 */
function stripGlobals(isolate, context) {
    const script = isolate.compileScriptSync(STRIP_SCRIPT);
    script.runSync(context);
}

module.exports = { stripGlobals };
