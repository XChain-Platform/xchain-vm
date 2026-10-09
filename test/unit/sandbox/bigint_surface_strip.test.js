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

function bigintDeletionList(opts) {
    const match = captureScript(opts).match(/var globalNames = (\[[\s\S]*?\]);/);
    assert(match, 'activated strip script must embed its BigInt deletion list');
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

describe('BigInt native surface strip: gated sets', function () {
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

    it('embeds the two globals when the host-injected BigInt flag is true', function () {
        const before = deletionList({ stripBigIntSurface: false });
        const after = deletionList({ stripBigIntSurface: true });
        assert.deepStrictEqual(after, before);
        assert.deepStrictEqual(bigintDeletionList({ stripBigIntSurface: true }),
            ['BigInt64Array', 'BigUint64Array']);
    });

    it('keeps the BigInt and WebAssembly strip flags independent', function () {
        const before = deletionList({ stripWasm: false });
        const after = deletionList({ stripWasm: true });
        assert.deepStrictEqual(after.filter((name) => !before.includes(name)),
            ['WebAssembly']);
        assert.ok(!captureScript({ stripWasm: true })
            .includes('BIGINT_SURFACE_STRIPPED_PROTO_METHODS'));
        assert.deepStrictEqual(bigintDeletionList({ stripBigIntSurface: true }),
            ['BigInt64Array', 'BigUint64Array']);
        assert.ok(!deletionList({ stripBigIntSurface: true }).includes('WebAssembly'));
    });

    it('keeps the BigInt prototype neuters out of the pre-activation script', function () {
        const source = captureScript({ stripBigIntSurface: false });
        assert.ok(!source.includes('BIGINT_SURFACE_STRIPPED_PROTO_METHODS'));
        assert.ok(!source.includes('BIGINT_SURFACE_NEUTERED_PROTO_CONSTRUCTORS'));
    });

});

describe('BigInt native surface strip: typed arrays and DataView', function () {
    this.timeout(30000);

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

});

describe('BigInt native surface strip: prototype constructor and isolation', function () {
    this.timeout(30000);

    it('neuters BigInt.prototype.constructor at activation', function () {
        assert.strictEqual(evaluateAfterStrip(
            '(0n).constructor === undefined', { stripBigIntSurface: true }), true);
    });

    it('locks every neutered property against recreation', function () {
        const result = evaluateAfterStrip(`(function() {
            var rows = [
                [DataView.prototype, 'getBigInt64'],
                [DataView.prototype, 'getBigUint64'],
                [DataView.prototype, 'setBigInt64'],
                [DataView.prototype, 'setBigUint64']
            ];
            var methodsLocked = rows.every(function(row) {
                var descriptor = Object.getOwnPropertyDescriptor(row[0], row[1]);
                return descriptor.value === undefined &&
                    descriptor.writable === false && descriptor.configurable === false;
            });
            var bigIntProto = Object.getPrototypeOf(0n);
            var descriptor = Object.getOwnPropertyDescriptor(bigIntProto, 'constructor');
            bigIntProto.constructor = function replacement() {};
            var assignmentBlocked = bigIntProto.constructor === undefined;
            var deletionBlocked = delete bigIntProto.constructor;
            var afterMutation = Object.getOwnPropertyDescriptor(bigIntProto, 'constructor');
            return methodsLocked &&
                descriptor.value === undefined && descriptor.writable === false &&
                descriptor.configurable === false && assignmentBlocked &&
                deletionBlocked === false && afterMutation.value === undefined &&
                afterMutation.writable === false && afterMutation.configurable === false;
        })()`, { stripBigIntSurface: true });
        assert.strictEqual(result, true);
    });

    it('uses the BigInt host flag without coupling to the Promise gate', function () {
        const bigint = deletionList({ stripBigIntSurface: true });
        assert.ok(!bigint.includes('WebAssembly'));
        assert.deepStrictEqual(bigintDeletionList({ stripBigIntSurface: true }),
            ['BigInt64Array', 'BigUint64Array']);
        assert.ok(!bigint.includes('Promise'));
        const promiseOnly = deletionList({ stripPromise: true });
        assert.ok(!promiseOnly.includes('BigInt64Array'));
        assert.ok(!promiseOnly.includes('BigUint64Array'));
        assert.ok(!captureScript({ stripPromise: true })
            .includes('BIGINT_SURFACE_STRIPPED_PROTO_METHODS'));
    });
});
