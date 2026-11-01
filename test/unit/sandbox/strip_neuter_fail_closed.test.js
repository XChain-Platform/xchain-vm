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

// Pin that every strip-script neuter fails closed: a target locked to its live value
// before setup must make stripGlobals throw rather than leave the surface reachable.

const assert = require('assert');
const { Isolate } = require('isolated-vm');
const {
    stripGlobals,
    STRIPPED_PROTO_METHODS,
    NEUTERED_PROTO_CONSTRUCTORS,
    BIGINT_SURFACE_STRIPPED_PROTO_METHODS,
    BIGINT_SURFACE_NEUTERED_PROTO_CONSTRUCTORS
} = require('../../../src/sandbox.js');

// Run `before` in a fresh context, then strip it; returns `after` evaluated post-strip.
function stripWith(before, opts, after) {
    const isolate = new Isolate({ memoryLimit: 8 });
    const context = isolate.createContextSync();
    try {
        if (before) isolate.compileScriptSync(before).runSync(context);
        stripGlobals(isolate, context, opts);
        return after ? isolate.compileScriptSync(after).runSync(context) : undefined;
    } finally {
        context.release();
        isolate.dispose();
    }
}

// A script that locks `target[key]` to its live value (or a getter) so no neuter can take.
function lockScript(target, key, asGetter) {
    const desc = asGetter
        ? '{ get: function () { return function () { return "x"; }; }, configurable: false }'
        : '{ value: ' + target + '[' + JSON.stringify(key) + '], writable: false, configurable: false }';
    return 'Object.defineProperty(' + target + ', ' + JSON.stringify(key) + ', ' + desc + ');';
}

// Every neutered own property, read back post-strip: names that are NOT neutered.
function unneuteredAfterStrip(opts) {
    const targets = [];
    for (const p of STRIPPED_PROTO_METHODS) targets.push([p.proto + '.prototype', p.method]);
    for (const name of NEUTERED_PROTO_CONSTRUCTORS) targets.push([name + '.prototype', 'constructor']);
    if (opts && opts.stripWasm) {
        for (const p of BIGINT_SURFACE_STRIPPED_PROTO_METHODS) targets.push([p.proto + '.prototype', p.method]);
        for (const name of BIGINT_SURFACE_NEUTERED_PROTO_CONSTRUCTORS) targets.push([name + '.prototype', 'constructor']);
    }
    const capture = 'var __probe = { gopd: Object.getOwnPropertyDescriptor, t: {' +
        targets.map(([t], i) => JSON.stringify(String(i)) + ': ' + t).join(', ') + '} };';
    const check = '(function () { var bad = []; var keys = ' + JSON.stringify(targets.map(([, k]) => k)) + ';' +
        'for (var i = 0; i < keys.length; i++) { var d = __probe.gopd(__probe.t[String(i)], keys[i]);' +
        'if (!d || d.value !== undefined || d.writable !== false || d.configurable !== false) bad.push(i); }' +
        'return JSON.stringify(bad); })()';
    return JSON.parse(stripWith(capture, opts, check)).map(i => targets[i].join('.'));
}

describe('Sandbox strip neuters fail closed', function () {
    this.timeout(30000);

    it('neuters every listed proto method and constructor on this V8', function () {
        assert.deepStrictEqual(unneuteredAfterStrip({}), []);
        assert.deepStrictEqual(unneuteredAfterStrip({ stripWasm: true }), []);
    });

    it('throws when a STRIPPED_PROTO_METHODS entry was locked before setup', function () {
        const target = STRIPPED_PROTO_METHODS.find(p => p.method === 'normalize');
        assert.throws(() => stripWith(lockScript(target.proto + '.prototype', target.method), {}),
            /STRIPPED_PROTO_METHODS String: normalize was not neutered/);
    });

    it('throws when a STRIPPED_PROTO_METHODS entry was locked as a getter', function () {
        assert.throws(() => stripWith(lockScript('Number.prototype', 'toLocaleString', true), {}),
            /STRIPPED_PROTO_METHODS Number: toLocaleString was not neutered/);
    });

    it('throws when a NEUTERED_PROTO_CONSTRUCTORS entry was locked before setup', function () {
        assert.throws(() => stripWith(lockScript('Boolean.prototype', 'constructor'), {}),
            /NEUTERED_PROTO_CONSTRUCTORS Boolean: constructor was not neutered/);
    });

    it('throws when a BigInt surface method or constructor was locked, including as a getter', function () {
        assert.throws(() => stripWith(lockScript('DataView.prototype', 'getBigInt64'), { stripWasm: true }),
            /BIGINT_SURFACE_STRIPPED_PROTO_METHODS DataView: getBigInt64 was not neutered/);
        assert.throws(() => stripWith(lockScript('BigInt.prototype', 'constructor'), { stripWasm: true }),
            /BIGINT_SURFACE_NEUTERED_PROTO_CONSTRUCTORS BigInt: constructor was not neutered/);
        assert.throws(() => stripWith(lockScript('BigInt.prototype', 'constructor', true), { stripWasm: true }),
            /BIGINT_SURFACE_NEUTERED_PROTO_CONSTRUCTORS BigInt: constructor was not neutered/);
    });

    it('throws when a Function-family constructor was locked before setup', function () {
        assert.throws(() => stripWith(lockScript('Function.prototype', 'constructor'), {}),
            /Function\.prototype: constructor was not neutered/);
        assert.throws(() => stripWith(lockScript('Object.getPrototypeOf(function*(){})', 'constructor'), {}),
            /GeneratorFunction\.prototype: constructor was not neutered/);
        assert.throws(() => stripWith(lockScript('Object.getPrototypeOf(async function(){})', 'constructor'), {}),
            /AsyncFunction\.prototype: constructor was not neutered/);
    });
});
