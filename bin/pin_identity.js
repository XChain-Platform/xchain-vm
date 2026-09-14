#!/usr/bin/env node
/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * Grades bin/pins/identity.json, the identity pin for the contract-lint trio
 * this repo owns and xchain-sdk carries a byte-identical copy of.
 *
 * WHAT IS GRADED. Every key under `files` is a path in this repo, and its
 * `canonical` field is the sha256 of that file. Each one is re-hashed from the
 * working tree. A key whose file does not exist is a dead path, which is how a
 * rename that forgot the pin shows up; a digest that differs means the file
 * moved a byte, which the sdk copy must then reproduce.
 *
 * WHY THE ENTRY SET IS DECLARED HERE. Walking only the keys the pin names lets
 * a pin that lost an entry read as holding, and lets a stray entry ride along.
 * So the expected set lives in this tool (PINNED_FILES) and the compare takes
 * both sides: an entry the pin lacks, or one the tool does not know, is a
 * difference. Changing the set is then a reviewed edit to this file, not a
 * silent edit to the pin.
 *
 * WHAT IS NOT GRADED. The top-level prose (what, why, takenAt, note) and the
 * per-entry sdk fields (vendoredInSdk, sdkPath, sdkPathAtOrigin) describe the
 * sdk copy, which is not in this tree; they are printed as not graded.
 * test/unit/lint_parity.test.js is what compares the two copies directly.
 *
 * USAGE
 *   node bin/pin_identity.js --compare bin/pins/identity.json
 *     Prints one line per not-graded field and per difference, then a one-line
 *     verdict. Exit 0 when the pin holds, 1 on any difference or error.
 *
 ********************************************************************/

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO_ROOT = path.resolve(__dirname, '..');

// The vendored lint trio, in snake_case after the structure pass renames.
const PINNED_FILES = [
    'src/lint_core.js',
    'src/metering.js',
    'src/stripped_globals.js',
];

const ALGORITHM = 'sha256';
const GRADED_FIELD = 'canonical';

function sha256File(rel) {
    const buf = fs.readFileSync(path.join(REPO_ROOT, rel));
    return crypto.createHash(ALGORITHM).update(buf).digest('hex');
}

function parseArgs(argv) {
    const i = argv.indexOf('--compare');
    if (i === -1 || !argv[i + 1]) {
        throw new Error('usage: node bin/pin_identity.js --compare <pin file>');
    }
    return { compare: path.resolve(argv[i + 1]) };
}

// Top-level prose and per-entry sdk fields, listed so a reader of the output
// can see exactly which parts of the pin carried no weight in the verdict.
function notGradedFields(pin) {
    const lines = [];
    for (const key of Object.keys(pin)) {
        if (key !== 'files' && key !== 'algorithm') lines.push(key);
    }
    for (const [rel, entry] of Object.entries(pin.files || {})) {
        for (const field of Object.keys(entry || {})) {
            if (field !== GRADED_FIELD) lines.push(`files.${rel}.${field}`);
        }
    }
    return lines;
}

// One difference string per problem, grading both sides of the entry set.
function compareEntries(pin) {
    const diffs = [];
    const files = pin.files || {};
    const expected = new Set(PINNED_FILES);
    for (const rel of new Set([...PINNED_FILES, ...Object.keys(files)])) {
        if (!(rel in files)) {
            diffs.push(`${rel}: missing from pin (dropped entry)`);
            continue;
        }
        if (!expected.has(rel)) diffs.push(`${rel}: unknown to this tool (added entry)`);
        if (!fs.existsSync(path.join(REPO_ROOT, rel))) {
            diffs.push(`${rel}: dead path, no such file in this tree`);
            continue;
        }
        const pinned = files[rel] && files[rel][GRADED_FIELD];
        const tree = sha256File(rel);
        if (pinned !== tree) diffs.push(`${rel}: digest mismatch, pinned ${pinned}, tree ${tree}`);
    }
    return diffs;
}

function grade(pin) {
    if (pin.algorithm !== ALGORITHM) {
        return [`algorithm: pin says ${pin.algorithm}, this tool grades ${ALGORITHM}`];
    }
    if (!pin.files || typeof pin.files !== 'object') return ['files: pin has no files map'];
    return compareEntries(pin);
}

function main() {
    const { compare } = parseArgs(process.argv.slice(2));
    const pin = JSON.parse(fs.readFileSync(compare, 'utf8'));
    for (const field of notGradedFields(pin)) console.log(`not graded: ${field}`);
    const diffs = grade(pin);
    const label = path.relative(process.cwd(), compare);
    for (const d of diffs) console.log(`DIFFERENCE ${d}`);
    if (diffs.length) {
        console.log(`identity pin BROKEN: ${diffs.length} difference(s) against ${label}`);
        return 1;
    }
    console.log(`identity pin holds: ${PINNED_FILES.length} lint trio files byte-identical to ${label}`);
    return 0;
}

if (require.main === module) {
    try {
        process.exitCode = main();
    } catch (err) {
        console.log(`identity pin ERROR: ${err.message}`);
        process.exitCode = 1;
    }
}

module.exports = { PINNED_FILES, grade, notGradedFields };
