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
 * XChain VM Toolkit: TypeScript authoring -> ES the VM accepts
 *
 * The VM executes ES2020-max JavaScript inside the isolate; it does not
 * understand type annotations. Contract authors who want TypeScript get it
 * for free via Node's built-in type stripping (module.stripTypeScriptTypes,
 * available on the Node 22 the whole platform pins): types are ERASED, not
 * down-levelled, so the emitted JS is byte-for-byte the author's code minus
 * the annotations. No new dependency, no source maps to reconcile, and no
 * risk of a transpiler silently rewriting money-handling logic.
 *
 * Erase-only means TS features that EMIT runtime code (enums, namespaces,
 * parameter properties, experimental decorators) are rejected by Node rather
 * than compiled. That is deliberate: those constructs would change the code
 * the determinism gate and the VM see. Authors use plain types + interfaces.
 ********************************************************************/
// @ts-nocheck

const nodeModule = require('module');

const TS_EXTENSIONS = new Set(['.ts', '.mts', '.cts']);

// True when a filename should be treated as TypeScript source.
function isTypeScript(filename) {
    if (typeof filename !== 'string') return false;
    const dot = filename.lastIndexOf('.');
    if (dot < 0) return false;
    return TS_EXTENSIONS.has(filename.slice(dot).toLowerCase());
}

/**
 * Strip TypeScript type annotations, yielding the ES the VM accepts.
 * @param {string} source   - TypeScript contract source
 * @param {string} [filename] - for error messages only
 * @returns {string} JavaScript with types erased (whitespace-preserving)
 * @throws if the Node runtime lacks stripTypeScriptTypes, or the source uses
 *         a runtime-emitting TS construct (enum/namespace/decorator/etc.)
 */
function stripTypes(source, filename) {
    if (typeof nodeModule.stripTypeScriptTypes !== 'function') {
        throw new Error(
            'TypeScript authoring requires Node >= 22.13 (module.stripTypeScriptTypes). ' +
            'Current Node: ' + process.version + '. Author in .js, or upgrade Node.'
        );
    }
    try {
        // mode:'strip' erases types and leaves everything else byte-identical
        // (no down-levelling), which keeps the determinism gate honest. Enums,
        // namespaces, and parameter properties throw here by design.
        return nodeModule.stripTypeScriptTypes(String(source), { mode: 'strip' });
    } catch (e) {
        const where = filename ? ' (' + filename + ')' : '';
        throw new Error('TypeScript strip failed' + where + ': ' + e.message);
    }
}

/**
 * Return runnable JS for a contract source, transpiling only when it is TS.
 * @param {string} source
 * @param {string} filename - drives the .ts/.js decision
 * @returns {string}
 */
function toContractJs(source, filename) {
    return isTypeScript(filename) ? stripTypes(source, filename) : String(source);
}

module.exports = { isTypeScript, stripTypes, toContractJs };
