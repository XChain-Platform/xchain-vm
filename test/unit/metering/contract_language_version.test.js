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
//
// The contract language version (ES2020) is a FROZEN consensus choice: every
// acorn parse in the VM pins to CONTRACT_ECMA_VERSION, and V8 on the pinned
// runtime accepts a superset, so acorn-accepted code parses identically at
// execution time. These tests pin the choice against accidental drift.
// Bumping it is a deliberate protocol migration (re-verify the metering
// transform on every new AST node type), not a dependency-default change.

const assert = require('assert');
const fs     = require('fs');
const { CONTRACT_ECMA_VERSION, meterCode } = require('../../../src/metering');

// Extensionless specifiers so a move from src/metering.js to
// src/metering/index.js still resolves to the module the VM loads.
const sourcePaths = {
    metering: require.resolve('../../../src/metering'),
    syntax: require.resolve('../../../src/syntax'),
};

// validateSyntax needs isolated-vm (V8 pre-check); skip those cases cleanly
// where the binding doesn't load; the preflight suite is the loud guard.
// Only the binding probe may skip: a syntax.js that fails to load for any
// other reason (a moved import, say) must fail here, not skip.
let HAVE_IVM = true;
try { require('isolated-vm'); } catch (e) { HAVE_IVM = false; }
const validateSyntax = HAVE_IVM ? require('../../../src/syntax').validateSyntax : null;

describe('Contract language version (frozen consensus pin)', function () {

    it('CONTRACT_ECMA_VERSION is 2020 (bumping is a protocol migration, not a tweak)', function () {
        assert.strictEqual(CONTRACT_ECMA_VERSION, 2020,
            'The contract language version is consensus once contracts exist. If this change is ' +
            'deliberate, re-verify the metering transform against every AST node type the new ' +
            'version introduces and update the protocol docs; otherwise revert.');
    });

    it('no parse site hardcodes an ecmaVersion outside the shared constant', function () {
        let pinnedSites = 0;
        for (const file of Object.values(sourcePaths)) {
            const src = fs.readFileSync(file, 'utf8');
            const hardcoded = src.match(/ecmaVersion:\s*\d+/g) || [];
            assert.deepStrictEqual(hardcoded, [],
                file + ' has a hardcoded ecmaVersion; use CONTRACT_ECMA_VERSION: ' + hardcoded.join(', '));
            pinnedSites += (src.match(/ecmaVersion:\s*CONTRACT_ECMA_VERSION/g) || []).length;
        }
        // A re-export shim left behind by a move would pass the check above
        // without scanning any parse site, so require at least one pinned site.
        assert.ok(pinnedSites > 0,
            'no CONTRACT_ECMA_VERSION parse site in ' + Object.values(sourcePaths).join(', ') +
            '; point this test at the file that now holds the acorn parse');
    });

    it('meterCode accepts ES2020 syntax (optional chaining, nullish coalescing)', function () {
        const metered = meterCode('var v = (a ?? {})?.b; if (v) { v = v + 1; }');
        assert.ok(metered.includes('__gas'), 'ES2020 contract should meter normally');
    });

    it('meterCode rejects post-2020 syntax (logical assignment, ES2021)', function () {
        assert.throws(() => meterCode('var a = null; a ??= 1;'), /./,
            'acorn pinned to ES2020 must reject ES2021 logical assignment');
    });

    (HAVE_IVM ? describe : describe.skip)('validateSyntax (V8 + acorn)', function () {

        it('accepts an ES2020 contract', function () {
            const r = validateSyntax('module.exports = function(x){ var v = (x ?? {})?.b; return v; };');
            assert.strictEqual(r.valid, true, r.error);
        });

        it('rejects ES2021 logical assignment with the ES2020-maximum error', function () {
            // V8 (step 1) parses this fine; the acorn pass must reject it with an
            // error that names the contract standard rather than a bare parse error.
            const r = validateSyntax('module.exports = function(){ var a = null; a ??= 1; return a; };');
            assert.strictEqual(r.valid, false);
            assert.match(r.error, /unsupported syntax \(ES2020 maximum\)/);
        });

        it('rejects an ES2022 class static block with the ES2020-maximum error', function () {
            const r = validateSyntax('class C { static { } }\nmodule.exports = function(){ return 1; };');
            assert.strictEqual(r.valid, false);
            assert.match(r.error, /unsupported syntax \(ES2020 maximum\)/);
        });
    });
});
