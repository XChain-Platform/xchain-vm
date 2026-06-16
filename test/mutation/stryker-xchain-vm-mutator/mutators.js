// @ts-nocheck
// 
'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// XChain VM-specific mutation operators for mutation testing.
//
// Four operators that target VM security and correctness patterns not covered
// by Stryker's built-in mutation operators:
//
//   1. ArrayElementDeletion  - sandbox toDelete list elements
//   2. StringPrefixSwap      - \x01/\x02/\x03 protocol prefixes
//   3. GuardDeletion         - throw-inside-if security guards
//   4. ObjectFreezeRemoval   - Object.freeze / Object.defineProperty calls
//
// Each operator exports a static mutate(source, filename) method returning
// an array of { mutatorName, original, replacement, startIdx, endIdx, mutatedSource }.

const acorn = require('acorn');

// ─── Helpers ────────────────────────────────────────────────────────────────

function locationFromIndex(source, idx) {
    const before = source.slice(0, idx);
    const lines = before.split('\n');
    return { line: lines.length, column: lines[lines.length - 1].length };
}

function tryParse(source) {
    try {
        return acorn.parse(source, {
            ecmaVersion: 2020,
            sourceType: 'script',
            locations: true
        });
    } catch (_) {
        return null;
    }
}

function walkAST(node, visitor) {
    if (!node || typeof node !== 'object') return;
    visitor(node);
    for (const key of Object.keys(node)) {
        if (key === 'parent') continue;
        const child = node[key];
        if (Array.isArray(child)) {
            child.forEach(c => {
                if (c && typeof c.type === 'string') walkAST(c, visitor);
            });
        } else if (child && typeof child.type === 'string') {
            walkAST(child, visitor);
        }
    }
}

// ─── 1. ArrayElementDeletion ────────────────────────────────────────────────
//
// Removes one element at a time from array literals with 2+ elements.
// Primary target: sandbox.js toDelete list (lines 15-22). If any single
// global is missing from the deletion list, a sandbox escape is possible.
// Stryker's built-in operators do NOT delete individual array elements.

function arrayElementDeletion(source, filename) {
    const mutants = [];
    const ast = tryParse(source);
    if (!ast) return mutants;

    walkAST(ast, function (node) {
        if (node.type !== 'ArrayExpression' || node.elements.length < 2) return;

        for (let i = 0; i < node.elements.length; i++) {
            const el = node.elements[i];
            if (!el) continue;

            // Determine the slice to remove: element + surrounding comma/whitespace
            let removeStart = el.start;
            let removeEnd = el.end;

            if (i < node.elements.length - 1) {
                // Not last element: remove element and trailing comma+whitespace
                const afterEl = source.slice(el.end, node.elements[i + 1].start);
                const commaIdx = afterEl.indexOf(',');
                if (commaIdx !== -1) {
                    removeEnd = el.end + commaIdx + 1;
                    // Also consume whitespace after the comma
                    while (removeEnd < node.elements[i + 1].start &&
                           (source[removeEnd] === ' ' || source[removeEnd] === '\n' ||
                            source[removeEnd] === '\r' || source[removeEnd] === '\t')) {
                        removeEnd++;
                    }
                }
            } else {
                // Last element: remove leading comma+whitespace
                const prevEl = node.elements[i - 1];
                const between = source.slice(prevEl.end, el.start);
                const commaIdx = between.indexOf(',');
                if (commaIdx !== -1) {
                    removeStart = prevEl.end + commaIdx;
                }
            }

            const mutatedSource = source.slice(0, removeStart) + source.slice(removeEnd);
            const original = source.slice(el.start, el.end);

            mutants.push({
                mutatorName: 'ArrayElementDeletion',
                original: original,
                replacement: '/* removed */',
                startIdx: el.start,
                endIdx: el.end,
                location: {
                    start: locationFromIndex(source, el.start),
                    end: locationFromIndex(source, el.end)
                },
                mutatedSource: mutatedSource
            });
        }
    });

    return mutants;
}

// ─── 2. StringPrefixSwap ────────────────────────────────────────────────────
//
// Swaps \x01/\x02/\x03 protocol prefix characters used in the VM's
// cross-isolate communication protocol:
//   \x01 = JSON return value prefix
//   \x02 = contract return prefix in wrapper
//   \x03 = error/revert/gas prefix
//
// Also targets hex comparisons: 0x01, 0x02, 0x03.
// Stryker's built-in StringLiteral mutator doesn't understand the semantic
// relationship between these three prefixes.

function stringPrefixSwap(source, filename) {
    const mutants = [];

    // Match escape sequences in string literals and hex constants
    const patterns = [
        { re: /\\x01/g, alts: ['\\x02', '\\x03'] },
        { re: /\\x02/g, alts: ['\\x01', '\\x03'] },
        { re: /\\x03/g, alts: ['\\x01', '\\x02'] },
        { re: /\b0x01\b/g, alts: ['0x02', '0x03'] },
        { re: /\b0x02\b/g, alts: ['0x01', '0x03'] },
        { re: /\b0x03\b/g, alts: ['0x01', '0x02'] }
    ];

    for (const { re, alts } of patterns) {
        let match;
        // Reset lastIndex for each pattern
        re.lastIndex = 0;
        while ((match = re.exec(source)) !== null) {
            const start = match.index;
            const end = start + match[0].length;
            const original = match[0];

            for (const alt of alts) {
                mutants.push({
                    mutatorName: 'StringPrefixSwap',
                    original: original,
                    replacement: alt,
                    startIdx: start,
                    endIdx: end,
                    location: {
                        start: locationFromIndex(source, start),
                        end: locationFromIndex(source, end)
                    },
                    mutatedSource: source.slice(0, start) + alt + source.slice(end)
                });
            }
        }
    }

    return mutants;
}

// ─── 3. GuardDeletion ───────────────────────────────────────────────────────
//
// Removes throw statements that are the sole body of an if block.
// Targets the VM's security-critical guard pattern:
//   if (condition) throw new Error(...)
//   if (condition) { throw new GasExhaustedError(...) }
//
// These guards enforce gas ceilings, state limits, input validation.
// Stryker's StatementDeletion removes arbitrary statements; this operator
// specifically targets the if-throw guard pattern used throughout the VM.

function guardDeletion(source, filename) {
    const mutants = [];
    const ast = tryParse(source);
    if (!ast) return mutants;

    walkAST(ast, function (node) {
        if (node.type !== 'IfStatement') return;

        const body = node.consequent;
        let throwNode = null;

        if (body.type === 'ThrowStatement') {
            throwNode = body;
        } else if (body.type === 'BlockStatement' &&
                   body.body.length === 1 &&
                   body.body[0].type === 'ThrowStatement') {
            throwNode = body.body[0];
        }

        if (!throwNode) return;

        // Don't mutate if there's an else branch (more complex logic)
        if (node.alternate) return;

        // Replace entire if statement with empty block
        const original = source.slice(node.start, node.end);
        const mutatedSource = source.slice(0, node.start) +
            '{ /* guard removed */ }' +
            source.slice(node.end);

        mutants.push({
            mutatorName: 'GuardDeletion',
            original: original,
            replacement: '{ /* guard removed */ }',
            startIdx: node.start,
            endIdx: node.end,
            location: {
                start: locationFromIndex(source, node.start),
                end: locationFromIndex(source, node.end)
            },
            mutatedSource: mutatedSource
        });
    });

    return mutants;
}

// ─── 4. ObjectFreezeRemoval ─────────────────────────────────────────────────
//
// Removes Object.freeze() and Object.defineProperty() calls that establish
// immutability and non-configurability constraints in the VM sandbox.
// Targets:
//   sandbox.js: Object.freeze(SafeMath) — prevents Math.random restoration
//   sandbox.js: Object.defineProperty(..., 'constructor', ...) — prevents escape
//   index.js HARNESS_SOURCE: Object.defineProperty(globalThis, '__gas', ...) — prevents override
//
// Object.freeze(x) → replaced with just x (unwrap)
// Object.defineProperty(a,b,c) → replaced with undefined (no-op)

function objectFreezeRemoval(source, filename) {
    const mutants = [];
    const ast = tryParse(source);
    if (!ast) return mutants;

    walkAST(ast, function (node) {
        if (node.type !== 'CallExpression') return;
        const callee = node.callee;

        let callType = null;

        // Object.freeze(x)
        if (callee.type === 'MemberExpression' &&
            callee.object.type === 'Identifier' && callee.object.name === 'Object' &&
            callee.property.type === 'Identifier' && callee.property.name === 'freeze') {
            callType = 'freeze';
        }

        // Object.defineProperty(target, prop, descriptor)
        if (callee.type === 'MemberExpression' &&
            callee.object.type === 'Identifier' && callee.object.name === 'Object' &&
            callee.property.type === 'Identifier' && callee.property.name === 'defineProperty') {
            callType = 'defineProperty';
        }

        if (!callType) return;

        const original = source.slice(node.start, node.end);
        let replacement;
        let mutatedSource;

        if (callType === 'freeze' && node.arguments.length >= 1) {
            // Unwrap: Object.freeze(x) → x
            const arg = node.arguments[0];
            replacement = source.slice(arg.start, arg.end);
            mutatedSource = source.slice(0, node.start) + replacement + source.slice(node.end);
        } else if (callType === 'defineProperty') {
            // No-op: Object.defineProperty(a,b,c) → undefined
            replacement = 'undefined';
            mutatedSource = source.slice(0, node.start) + 'undefined' + source.slice(node.end);
        } else {
            return;
        }

        mutants.push({
            mutatorName: 'ObjectFreezeRemoval',
            original: original,
            replacement: replacement,
            startIdx: node.start,
            endIdx: node.end,
            location: {
                start: locationFromIndex(source, node.start),
                end: locationFromIndex(source, node.end)
            },
            mutatedSource: mutatedSource
        });
    });

    return mutants;
}

// ─── 5. EmbeddedCodeMutation ────────────────────────────────────────────────
//
// Handles code embedded inside string literals (template literals or quoted
// strings assigned to known variable names like STRIP_SCRIPT, HARNESS_SOURCE,
// CONTRACT_WRAPPER). These contain full JS programs that acorn can't see when
// parsing the outer file.
//
// This operator extracts the embedded code, runs the other 4 operators against
// it, then reconstructs the outer source with the mutation applied inside the
// string. Primary target: sandbox.js STRIP_SCRIPT (toDelete array, Object.freeze,
// Object.defineProperty calls).

function embeddedCodeMutation(source, filename) {
    const mutants = [];

    // Find template literals and multiline string constants that contain JS code
    // Pattern: variable = `...code...`; or variable = '...code...';
    const embeddedPatterns = [
        // Template literal: const VARNAME = `...`;
        { re: /(?:const|let|var)\s+(\w+)\s*=\s*`([\s\S]*?)`;/g, type: 'template' },
        // Single-quoted multiline (rare but possible via concatenation)
    ];

    // Inner operators to apply inside embedded code
    const innerOperators = [
        { name: 'ArrayElementDeletion', fn: arrayElementDeletion },
        { name: 'GuardDeletion',        fn: guardDeletion },
        { name: 'ObjectFreezeRemoval',  fn: objectFreezeRemoval }
    ];

    for (const { re, type } of embeddedPatterns) {
        let match;
        re.lastIndex = 0;
        while ((match = re.exec(source)) !== null) {
            const varName = match[1];
            const embeddedCode = match[2];
            const outerStart = match.index;
            // The embedded code starts after: const VARNAME = `
            const codeStartInOuter = outerStart + match[0].indexOf('`') + 1;

            for (const op of innerOperators) {
                const innerMutants = op.fn(embeddedCode, filename + ':' + varName);
                for (const im of innerMutants) {
                    // Reconstruct outer source with this mutation applied inside the string
                    const mutatedEmbedded = im.mutatedSource;
                    const mutatedOuter = source.slice(0, codeStartInOuter) +
                        mutatedEmbedded +
                        source.slice(codeStartInOuter + embeddedCode.length);

                    // Adjust location to outer file coordinates
                    const linesBeforeEmbed = source.slice(0, codeStartInOuter).split('\n');
                    const embedStartLine = linesBeforeEmbed.length;
                    const adjustedLine = embedStartLine + im.location.start.line - 1;

                    mutants.push({
                        mutatorName: im.mutatorName + ':Embedded(' + varName + ')',
                        original: im.original,
                        replacement: im.replacement,
                        startIdx: codeStartInOuter + im.startIdx,
                        endIdx: codeStartInOuter + im.endIdx,
                        location: {
                            start: { line: adjustedLine, column: im.location.start.column },
                            end: { line: adjustedLine + (im.location.end.line - im.location.start.line), column: im.location.end.column }
                        },
                        mutatedSource: mutatedOuter
                    });
                }
            }
        }
    }

    return mutants;
}

// ─── Exports ────────────────────────────────────────────────────────────────

const ALL_OPERATORS = [
    { name: 'ArrayElementDeletion', fn: arrayElementDeletion },
    { name: 'StringPrefixSwap',    fn: stringPrefixSwap },
    { name: 'GuardDeletion',       fn: guardDeletion },
    { name: 'ObjectFreezeRemoval', fn: objectFreezeRemoval },
    { name: 'EmbeddedCodeMutation', fn: embeddedCodeMutation }
];

function generateAllMutants(source, filename) {
    const all = [];
    for (const op of ALL_OPERATORS) {
        const mutants = op.fn(source, filename);
        all.push(...mutants);
    }
    return all;
}

module.exports = {
    arrayElementDeletion,
    stringPrefixSwap,
    guardDeletion,
    objectFreezeRemoval,
    embeddedCodeMutation,
    generateAllMutants,
    ALL_OPERATORS
};
