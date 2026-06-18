// @ts-nocheck
// 
// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { meterCode } = require('../../src/metering.js');

let ivm;
try {
    ivm = require('isolated-vm');
} catch (e) {
    console.log('Skipping compilation tests (isolated-vm not available):', e);
}

describe('Compilation', function() {

    it('should meter compile_bomb.js without error', function() {
        const code = fs.readFileSync(path.join(__dirname, '../contracts/compile_bomb.js'), 'utf8');
        const start = Date.now();
        const metered = meterCode(code);
        const elapsed = Date.now() - start;
        console.log('      Metering time: ' + elapsed + 'ms');
        assert(elapsed < 10000, 'metering should complete in under 10s');
        assert(metered.length > code.length, 'metered code should be larger');
    });

    (ivm ? it : it.skip)('should compile metered code in isolate', function() {
        const code = fs.readFileSync(path.join(__dirname, '../contracts/compile_bomb.js'), 'utf8');
        const metered = meterCode(code);
        const isolate = new ivm.Isolate({ memoryLimit: 16 });
        try {
            const start = Date.now();
            isolate.compileScriptSync(metered);
            const elapsed = Date.now() - start;
            console.log('      Compilation time: ' + elapsed + 'ms');
            assert(elapsed < 10000, 'compilation should complete in under 10s');
        } finally {
            isolate.dispose();
        }
    });

    it('should meter typical contract code quickly', function() {
        const code = fs.readFileSync(path.join(__dirname, '../contracts/state_counter.js'), 'utf8');
        const start = Date.now();
        meterCode(code);
        const elapsed = Date.now() - start;
        console.log('      Metering time (typical): ' + elapsed + 'ms');
        assert(elapsed < 100, 'typical contract metering should be fast');
    });
});
