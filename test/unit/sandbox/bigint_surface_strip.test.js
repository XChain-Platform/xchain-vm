/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const { Isolate } = require('isolated-vm');
const {
    stripGlobals,
    BIGINT_SURFACE_STRIPPED_GLOBAL_NAMES,
    BIGINT_SURFACE_STRIPPED_PROTO_METHODS,
    BIGINT_SURFACE_NEUTERED_PROTO_CONSTRUCTORS
} = require('../../../src/sandbox.js');

function captureScript(opts) {
    let source;
    const isolate = {
        compileScriptSync(input) {
            source = input;
            return { runSync() {} };
        }
    };
    stripGlobals(isolate, {}, opts);
    return source;
}

function deletionList(opts) {
    const match = captureScript(opts).match(/const toDelete = (\[[\s\S]*?\]);/);
    assert(match, 'strip script must embed its deletion list');
    return JSON.parse(match[1]);
}

function evaluateAfterStrip(expression, opts) {
    const isolate = new Isolate({ memoryLimit: 8 });
    const context = isolate.createContextSync();
    try {
        stripGlobals(isolate, context, opts);
        return isolate.compileScriptSync(expression).runSync(context);
    } finally {
        context.release();
        isolate.dispose();
    }
}

describe('BigInt native surface strip', function () {
    this.timeout(30000);

    it('freezes the exact gated surface sets', function () {
        assert.ok(Object.isFrozen(BIGINT_SURFACE_STRIPPED_GLOBAL_NAMES));
        assert.ok(Object.isFrozen(BIGINT_SURFACE_STRIPPED_PROTO_METHODS));
        assert.ok(Object.isFrozen(BIGINT_SURFACE_NEUTERED_PROTO_CONSTRUCTORS));
        assert.deepStrictEqual(BIGINT_SURFACE_STRIPPED_GLOBAL_NAMES,
            ['BigInt64Array', 'BigUint64Array']);
        assert.deepStrictEqual(BIGINT_SURFACE_STRIPPED_PROTO_METHODS, [
            { proto: 'DataView', method: 'getBigInt64' },
            { proto: 'DataView', method: 'getBigUint64' },
            { proto: 'DataView', method: 'setBigInt64' },
            { proto: 'DataView', method: 'setBigUint64' }
        ]);
        assert.deepStrictEqual(BIGINT_SURFACE_NEUTERED_PROTO_CONSTRUCTORS, ['BigInt']);
    });

    it('leaves the gated globals out of the deletion list by default and when false', function () {
        for (const opts of [undefined, {}, { stripBigIntSurface: false }]) {
            const names = deletionList(opts);
            assert.ok(!names.includes('BigInt64Array'));
            assert.ok(!names.includes('BigUint64Array'));
        }
    });

    it('adds exactly the two gated globals when the flag is true', function () {
        const before = deletionList({ stripBigIntSurface: false });
        const after = deletionList({ stripBigIntSurface: true });
        assert.deepStrictEqual(after.slice(0, before.length), before);
        assert.deepStrictEqual(after.slice(before.length),
            ['BigInt64Array', 'BigUint64Array']);
    });

    it('keeps the BigInt prototype neuters out of the pre-activation script', function () {
        const source = captureScript({ stripBigIntSurface: false });
        assert.ok(!source.includes('BIGINT_SURFACE_STRIPPED_PROTO_METHODS'));
        assert.ok(!source.includes('BIGINT_SURFACE_NEUTERED_PROTO_CONSTRUCTORS'));
    });

    it('keeps all three surfaces reachable below activation', function () {
        const result = evaluateAfterStrip(`JSON.stringify([
            typeof BigInt64Array,
            typeof BigUint64Array,
            typeof DataView.prototype.getBigInt64,
            typeof DataView.prototype.getBigUint64,
            typeof DataView.prototype.setBigInt64,
            typeof DataView.prototype.setBigUint64,
            typeof (0n).constructor
        ])`, { stripBigIntSurface: false });
        assert.strictEqual(result,
            '["function","function","function","function","function","function","function"]');
    });

    it('removes both typed-array globals at activation', function () {
        const result = evaluateAfterStrip(
            'typeof BigInt64Array + "," + typeof BigUint64Array',
            { stripBigIntSurface: true });
        assert.strictEqual(result, 'undefined,undefined');
    });

    it('neuters every DataView BigInt64 method at activation', function () {
        const result = evaluateAfterStrip(`[
            DataView.prototype.getBigInt64,
            DataView.prototype.getBigUint64,
            DataView.prototype.setBigInt64,
            DataView.prototype.setBigUint64
        ].every(function(value) { return value === undefined; })`,
        { stripBigIntSurface: true });
        assert.strictEqual(result, true);
    });

    it('neuters BigInt.prototype.constructor at activation', function () {
        assert.strictEqual(evaluateAfterStrip(
            '(0n).constructor === undefined', { stripBigIntSurface: true }), true);
    });

    it('locks every neutered property to undefined', function () {
        const result = evaluateAfterStrip(`(function() {
            var rows = [
                [DataView.prototype, 'getBigInt64'],
                [DataView.prototype, 'getBigUint64'],
                [DataView.prototype, 'setBigInt64'],
                [DataView.prototype, 'setBigUint64'],
                [Object.getPrototypeOf(0n), 'constructor']
            ];
            return rows.every(function(row) {
                var descriptor = Object.getOwnPropertyDescriptor(row[0], row[1]);
                return descriptor.value === undefined &&
                    descriptor.writable === false && descriptor.configurable === false;
            });
        })()`, { stripBigIntSurface: true });
        assert.strictEqual(result, true);
    });

    it('does not couple the BigInt surface flag to the Promise or WebAssembly gates', function () {
        const onlyBigInt = deletionList({ stripBigIntSurface: true });
        assert.ok(!onlyBigInt.includes('Promise'));
        assert.ok(!onlyBigInt.includes('WebAssembly'));
        const otherGates = deletionList({ stripPromise: true, stripWasm: true });
        assert.ok(!otherGates.includes('BigInt64Array'));
        assert.ok(!otherGates.includes('BigUint64Array'));
    });
});
