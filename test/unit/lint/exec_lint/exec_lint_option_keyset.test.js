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
 ********************************************************************/
'use strict';

const assert = require('assert');
const XChainVM = require('../../../../src/index.js');

const GAS_SCHEDULE = {
    VM_COMPUTATION: 1, VM_STATE_READ: 100, VM_STATE_WRITE: 200, VM_STATE_DELETE: 100,
    VM_ORACLE_READ: 100, VM_CROSSCHAIN_READ: 100, VM_ATTEST_REQUEST: 5000, VM_EMISSION: 500,
    VM_XCALL_REQUEST: 2000, VM_XCALL_CALLBACK: 20000
};
const CODE = 'module.exports = function(){ return 1; };';

// Every enforce* option validateSyntax reads; an omitted one reads as ON.
const EXPECTED = [
    'enforceBannedAsync', 'enforceBannedGenerator', 'enforceBannedRest',
    'enforceBannedWasm', 'enforceBannedWith', 'enforceLintDestructure',
    'enforceLintGlobalAlias', 'enforceLintHardening', 'enforceLintNestingDepth',
    'enforceLintOptionalChain', 'enforceLintSyntaxDepth'
].sort();

// Keys the execute path leaves out on purpose, each with its reason.
const DELIBERATE_EXEC_OMISSIONS = {
    enforceLintNestingDepth: 'execute-time lint has always enforced the delimiter rule, so omitted-reads-as-ON is intended'
};

// Map each getLintVerdict flag position (after code) to the options it drives; position 7 is codeHash.
const PARAM_KEYS = {
    1: ['enforceBannedAsync'],
    2: ['enforceLintHardening'],
    3: ['enforceBannedGenerator', 'enforceBannedWasm'],
    4: ['enforceLintGlobalAlias'],
    5: ['enforceBannedRest'],
    6: ['enforceLintOptionalChain'],
    8: ['enforceBannedWith'],
    9: ['enforceLintDestructure'],
    10: ['enforceLintSyntaxDepth']
};
const MISSING_KEY_HINT = 'a validateSyntax option missing from the execute path is enforced at every height ' +
    'regardless of its activation: forward it from a gated parameter with a cache-key bit, or list it in ' +
    'DELIBERATE_EXEC_OMISSIONS with a reason';

function newVm() {
    return new XChainVM({ gasSchedule: GAS_SCHEDULE, gasCeiling: 1000000, execution: 'in-process' });
}

// Collect the enforce* names the real validateSyntax reads off its options.
function derivedValidateSyntaxKeys() {
    const { validateSyntax } = require('../../../../src/syntax.js');
    const found = new Set();
    for (const m of validateSyntax.toString().matchAll(/opts\.(enforce\w+)/g)) found.add(m[1]);
    return [...found].sort();
}

// Swap syntax.js for a recorder and reload getLintVerdict against it.
function withSyntaxSpy(fn) {
    const syntaxPath = require.resolve('../../../../src/syntax.js');
    const lintPath = require.resolve('../../../../src/index/methods/lint_and_metering.js');
    const realSyntax = require.cache[syntaxPath];
    const realLint = require.cache[lintPath];
    const calls = [];
    require.cache[syntaxPath] = {
        id: syntaxPath,
        filename: syntaxPath,
        loaded: true,
        exports: {
            validateSyntax: (code, opts) => { calls.push(opts); return { valid: true }; },
            checkFloatWarnings: () => []
        }
    };
    delete require.cache[lintPath];
    try {
        return fn(require(lintPath).getLintVerdict, calls);
    } finally {
        if (realSyntax) require.cache[syntaxPath] = realSyntax;
        else delete require.cache[syntaxPath];
        if (realLint) require.cache[lintPath] = realLint;
        else delete require.cache[lintPath];
    }
}

// Build the ten arguments after code: every flag set to `on` except the codeHash slot.
function flagArgs(on, only) {
    const args = [];
    for (let pos = 1; pos <= 10; pos++) {
        if (pos === 7) args.push(undefined);
        else args.push(only === undefined ? on : pos === only);
    }
    return args;
}

function forwardedKeys() {
    return EXPECTED.filter((k) => !Object.prototype.hasOwnProperty.call(DELIBERATE_EXEC_OMISSIONS, k));
}

describe('execute-time lint option key set', function () {
    it('reads the validateSyntax enforce key set off the real function', function () {
        const derived = derivedValidateSyntaxKeys();
        assert.ok(derived.length > 0,
            'no opts.enforce* read found in validateSyntax; update derivedValidateSyntaxKeys for its new shape');
        assert.deepStrictEqual(derived, EXPECTED,
            'validateSyntax reads a different option set than this guard pins; ' + MISSING_KEY_HINT);
        for (const k of Object.keys(DELIBERATE_EXEC_OMISSIONS))
            assert.ok(EXPECTED.includes(k), 'stale deliberate omission ' + k);
    });

    it('pins the exact option key set getLintVerdict hands validateSyntax', function () {
        for (const on of [false, true]) {
            withSyntaxSpy((getLintVerdict, calls) => {
                getLintVerdict.call(newVm(), CODE, ...flagArgs(on));
                assert.strictEqual(calls.length, 1);
                const opts = calls[0];
                const own = Object.getOwnPropertyNames(opts).sort();
                assert.deepStrictEqual(own, forwardedKeys(), MISSING_KEY_HINT);
                assert.deepStrictEqual(Object.keys(opts).sort(), own,
                    'an execute-path flag is non-enumerable, which hides it from key-set guards');
                for (const k of Object.keys(DELIBERATE_EXEC_OMISSIONS))
                    assert.ok(!(k in opts), k + ' is forwarded now; drop it from DELIBERATE_EXEC_OMISSIONS');
                for (const k of own)
                    assert.strictEqual(opts[k], on, k + ' is not driven by its flag parameter');
            });
        }
    });

    it('ties each forwarded option to one flag parameter and one cache-key bit', function () {
        const mapped = [];
        for (const [pos, keys] of Object.entries(PARAM_KEYS)) {
            withSyntaxSpy((getLintVerdict, calls) => {
                const vm = newVm();
                getLintVerdict.call(vm, CODE, ...flagArgs(false));
                getLintVerdict.call(vm, CODE, ...flagArgs(false, Number(pos)));
                assert.strictEqual(calls.length, 2, 'position ' + pos + ' shares a cache entry with all-off');
                const changed = Object.keys(calls[1]).filter((k) => calls[0][k] !== calls[1][k]).sort();
                assert.deepStrictEqual(changed, keys.slice().sort(), 'position ' + pos + ' drives the wrong options');
                const [a, b] = [...vm._lintVerdictCache.keys()].map((key) => key.split(':')[1]);
                const diff = [...a].filter((bit, i) => bit !== b[i]).length;
                assert.strictEqual(diff, 1, 'position ' + pos + ' must flip exactly one cache-key bit');
            });
            mapped.push(...keys);
        }
        assert.deepStrictEqual(mapped.sort(), forwardedKeys(), 'a forwarded option has no flag parameter');
    });
});
