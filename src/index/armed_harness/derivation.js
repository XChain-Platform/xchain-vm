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
 * XChain VM: armed harness derivation
 *
 * Builds an armed harness from HARNESS_SOURCE without moving any of its
 * lines. Contract code can read harness function source with String(fn), and
 * a host-built error's stack names a harness line and column, so the unarmed
 * harness never changes and every armed rule is derived from it here:
 *   - same-line edits: each `from` text matches the source exactly once and
 *     its replacement carries the same number of line breaks, so every source
 *     line keeps its number in the armed harness;
 *   - helper text inserted before the closing line.
 * Each edit is located in the unarmed source, never in partly edited text, so
 * the order rules are listed in cannot change what any of them matches. Two
 * edits that touch one source line, from the same rule or from two rules,
 * refuse at build time instead of silently overwriting each other.
 ********************************************************************/
// @ts-nocheck
'use strict';

const CLOSING = '})();\n';

const lineBreaks = (s) => s.split('\n').length - 1;

// 0-based source line of a character offset.
function lineAt(source, offset) {
    return lineBreaks(source.slice(0, offset));
}

// Locate one rule's edits in the unarmed source. Each result carries the source span
// it replaces and the set of source lines that span covers.
function locateEdits(source, label, edits) {
    return edits.map(([from, to]) => {
        const hits = source.split(from).length - 1;
        if (hits !== 1)
            throw new Error('xchain-vm: ' + label + ' harness edit matched ' + hits + ' times: ' + from.trim());
        if (lineBreaks(from) !== lineBreaks(to))
            throw new Error('xchain-vm: ' + label + ' harness edit moves lines: ' + from.trim());
        const start = source.indexOf(from);
        const first = lineAt(source, start);
        const lines = [];
        for (let l = first; l <= first + lineBreaks(from.replace(/\n$/, '')); l++) lines.push(l);
        return { label, start, end: start + from.length, to, lines };
    });
}

// Derive the armed harness for an ordered list of rules, each { label, edits, helpers }.
// The helpers of every rule are inserted in list order before the closing line.
function deriveHarness(source, rules) {
    if (!source.endsWith(CLOSING))
        throw new Error('xchain-vm: harness no longer ends with its closing line');
    const located = [];
    const owner = new Map();
    for (const rule of rules) {
        for (const edit of locateEdits(source, rule.label, rule.edits)) {
            for (const line of edit.lines) {
                if (owner.has(line))
                    throw new Error('xchain-vm: harness line ' + (line + 1) + ' is edited by both ' +
                        owner.get(line) + ' and ' + rule.label);
                owner.set(line, rule.label);
            }
            located.push(edit);
        }
    }
    located.sort((a, b) => b.start - a.start);
    let out = source;
    for (const edit of located) out = out.slice(0, edit.start) + edit.to + out.slice(edit.end);
    const helpers = rules.map((rule) => rule.helpers).join('');
    return out.slice(0, out.length - CLOSING.length) + helpers + CLOSING;
}

module.exports = { deriveHarness };
