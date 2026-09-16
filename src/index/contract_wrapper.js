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
 * XChain VM: contract wrapper script
 *
 * The in-isolate script that runs a contract module and dispatches one
 * method, in its legacy script-level-binding form and the VM_LINT_HARDENING
 * closure-parameter form derived from it. Both strings are consensus: they
 * are compiled ahead of every contract, so their bytes fix the line numbers
 * V8 reports in error text a contract can read. Held apart from the entry
 * so execute() reads as the host-side algorithm and this file as the
 * sandbox-side one.
 ********************************************************************/
// @ts-nocheck

/**
 * Contract wrapper script. Runs the contract code and invokes the
 * specified method (or the default export if it's a function).
 * Injected variables: __contractCode (string), __methodName (string),
 * __isCrossCall (bool), __readManifest (bool, Phase E manifest introspection)
 */
const CONTRACT_WRAPPER = `
(function() {
    // Execute the contract code to get the exports
    // Use __Function (saved by sandbox before stripping Function from global scope)
    var module = { exports: {} };
    var exports = module.exports;
    var __Fn = globalThis.__Function;
    delete globalThis.__Function;
    (new __Fn('module', 'exports', 'xchain', __contractCode))(module, exports, xchain);
    var contractExports = module.exports;

    // Permissions-manifest introspection (Phase E). When the host reads a
    // contract's declared policy at deploy time it sets __readManifest, and we
    // surface the exported permissions + maxTakeBps WITHOUT dispatching a method.
    // Type tags are surfaced (not just values) so the indexer can fail-closed on a
    // malformed manifest (e.g. permissions exported as a string, or a non-integer
    // maxTakeBps) rather than silently treating it as absent. All validation +
    // rejection lives host-side (actions/deploy/index.js); the VM only reports faithfully.
    if (__readManifest) {
        var __ce = (typeof contractExports === 'object' && contractExports !== null) ? contractExports : {};

        // Contract identity (CONTRACT_META_REQUIRED). Read off an object export OR
        // a function export, because a function-style contract has nowhere else to
        // hang it; __ce stays object-only on purpose, so a function export's
        // permissions/maxTakeBps verdicts do not move (they are ungated today).
        //
        // The serialisation and the 4096-unit cap live HERE, in the isolate,
        // because the host only ever sees this report after JSON.parse and the
        // whole report is truncated at 65536 characters before parsing: a
        // programmatically built multi-megabyte meta would otherwise produce an
        // unparseable report and skip every check. Bounding it here keeps the
        // report parseable whatever the contract does.
        //
        // Nothing in this block may throw. A throw would escape the wrapper and
        // report the whole manifest as unread, which would silently move the
        // EXISTING permissions/maxTakeBps verdicts for any contract whose meta
        // read misbehaves, including below the activation flag. So the property
        // read is caught (meta may be a throwing getter) and a stringify that
        // yields undefined (a toJSON returning undefined) is normalised.
        //
        // Reported faithfully; every verdict lives host-side (actions/deploy/index.js).
        var __metaSrc = undefined;
        var __metaJson = null, __metaError = false, __metaOversize = false;
        try {
            __metaSrc = ((typeof contractExports === 'object' && contractExports !== null) || typeof contractExports === 'function')
                      ? contractExports.meta : undefined;
        } catch (e) { __metaError = true; }
        var __metaType = (__metaSrc === undefined) ? 'undefined'
                       : (__metaSrc === null)      ? 'null'
                       : Array.isArray(__metaSrc)  ? 'array'
                       : typeof __metaSrc;
        if (__metaType === 'object') {
            try { __metaJson = JSON.stringify(__metaSrc); } catch (e) { __metaError = true; }
            // A toJSON that returns undefined serialises to undefined, not a string.
            if (__metaJson === undefined) { __metaJson = null; __metaError = true; }
            if (__metaJson !== null && __metaJson.length > 4096) { __metaOversize = true; __metaJson = null; }
            // A Date or a boxed String serialises to a non-object; the host wants a
            // manifest object or nothing at all.
            if (__metaJson !== null && __metaJson.charAt(0) !== '{') { __metaError = true; __metaJson = null; }
        }

        return '\\x02' + JSON.stringify({
            permissions:     Array.isArray(__ce.permissions) ? __ce.permissions : null,
            permissionsType: (__ce.permissions === undefined) ? 'undefined' : (Array.isArray(__ce.permissions) ? 'array' : typeof __ce.permissions),
            maxTakeBps:      (typeof __ce.maxTakeBps === 'number') ? __ce.maxTakeBps : null,
            maxTakeBpsType:  (__ce.maxTakeBps === undefined) ? 'undefined' : typeof __ce.maxTakeBps,
            // Whether the contract exports a callable constructor. Runtime-accurate
            // (matches how execute() dispatches, so it also catches a dynamically
            // assigned module.exports.initialize). The indexer uses this to reject a
            // DEPLOY that declares a constructor but supplies no CONSTRUCTOR_PARAMS,
            // gated on the DEPLOY_INIT_STRICT flag-day. Reported faithfully here;
            // all verdict logic lives host-side in actions/deploy/index.js.
            hasInitialize:   (typeof __ce.initialize === 'function'),
            metaType:        __metaType,
            metaJson:        __metaJson,
            metaError:       __metaError,
            metaOversize:    __metaOversize
        });
    }

    // Cross-chain call gate: an injected cross-chain execution may only invoke
    // methods the contract explicitly opted in via an exported crossCallable
    // array. This is the blast-radius bound on the federation's relay authority
    // a quorum-signed dispatch can only reach methods the target contract
    // consciously exposed. The fixed marker string is matched by the indexer
    // (xexec.js) to report status 'not_callable' back to the caller.
    if (__isCrossCall) {
        var __cc = (typeof contractExports === 'object' && contractExports !== null)
            ? contractExports.crossCallable : null;
        if (!Array.isArray(__cc) || __cc.indexOf(__methodName) === -1)
            throw new Error('XCALL_NOT_CALLABLE: method "' + __methodName + '" is not in the crossCallable allowlist');
    }

    // Invoke the method
    var __result;
    if (typeof contractExports === 'function') {
        __result = contractExports(xchain);
    } else if (typeof contractExports === 'object' && contractExports !== null) {
        var method = contractExports[__methodName];
        if (typeof method !== 'function')
            throw new Error('unknown method: ' + __methodName);
        __result = method(xchain);
    } else {
        throw new Error('contract must export a function or object');
    }
    // JSON-serialize the return value inside the isolate so it can
    // cross the boundary as a string (ivm only transfers primitives)
    if (__result === undefined) return undefined;
    return '\\x02' + JSON.stringify(__result);
})();
`;

// VM_LINT_HARDENING wrapper variant (5bff4687): identical body, but the four
// injected control bindings (__contractCode/__methodName/__isCrossCall/
// __readManifest) arrive as IIFE PARAMETERS instead of script-level `let`s.
// Script-level lexical bindings live in the context's global lexical scope,
// where the contract body (evaluated via the saved Function constructor, which
// compiles in global scope) can read or shadow them to defeat the crossCallable
// allowlist, manifest introspection, and method dispatch. Closure parameters
// are invisible to Function-constructed code. Derived mechanically from
// CONTRACT_WRAPPER so the two bodies can never drift; the legacy constant's
// bytes are untouched (pre-gate executions must compile byte-identical source).
const CONTRACT_WRAPPER_HARDENED = CONTRACT_WRAPPER
    .replace('(function() {', '(function(__contractCode, __methodName, __isCrossCall, __readManifest) {')
    .replace(/\}\)\(\);\s*$/, '})');

module.exports = { CONTRACT_WRAPPER, CONTRACT_WRAPPER_HARDENED };
