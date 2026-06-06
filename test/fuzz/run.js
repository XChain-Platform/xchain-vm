#!/usr/bin/env node
// @ts-nocheck
// 
/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Fuzz Test Runner
 *
 * Usage:
 *   node test/fuzz/run.js              # all categories
 *   node test/fuzz/run.js code         # only code.fuzz.test.js
 *   node test/fuzz/run.js math state   # multiple categories
 *
 * Environment:
 *   FUZZ_ITERATIONS=1000  # override default 500 iterations per property
 ********************************************************************/

const Mocha = require('mocha');
const fs    = require('fs');
const path  = require('path');

const dir = __dirname;
const categories = process.argv.slice(2);
const iterations = process.env.FUZZ_ITERATIONS || '500';

const allFiles = fs.readdirSync(dir).filter(f => f.endsWith('.fuzz.test.js')).sort();

const selected = categories.length > 0
    ? allFiles.filter(f => categories.some(c => f.startsWith(c)))
    : allFiles;

if (selected.length === 0) {
    console.error('No fuzz test files matched. Available categories:');
    allFiles.forEach(f => console.error('  ' + f.replace('.fuzz.test.js', '')));
    process.exit(1);
}

console.log('XChain VM Fuzz Testing');
console.log('  Iterations per property: ' + iterations);
console.log('  Test files: ' + selected.length);
selected.forEach(f => console.log('    - ' + f));
console.log('');

const mocha = new Mocha({ timeout: 120000 });
selected.forEach(f => mocha.addFile(path.join(dir, f)));

mocha.run(failures => {
    process.exitCode = failures ? 1 : 0;
});
