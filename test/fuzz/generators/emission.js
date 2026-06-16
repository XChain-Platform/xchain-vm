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
 * Fuzz Generators — Emission Actions
 *
 * Generates contracts that call xchain.emit.* with valid, malformed,
 * and adversarial parameters.
 ********************************************************************/
// @ts-nocheck

// 


const fc = require('fast-check');

const EMIT_METHODS = [
    { name: 'send',      required: ['destination', 'tick', 'quantity'] },
    { name: 'destroy',   required: ['tick', 'quantity'] },
    { name: 'issue',     required: ['tick'] },
    { name: 'mint',      required: ['tick', 'quantity'] },
    { name: 'order',     required: ['giveAmount', 'getAmount'] },
    { name: 'dispenser', required: [] },
    { name: 'dividend',  required: ['tick', 'dividendTick', 'quantity'] },
    { name: 'airdrop',   required: ['tick', 'quantity', 'listActionIndex'] },
    { name: 'callback',  required: ['tick'] },
    { name: 'file',      required: [] },
    { name: 'list',      required: [] },
    { name: 'coinpay',   required: ['orderMatchActionIndex'] },
    { name: 'sweep',     required: ['destination'] },
    { name: 'link',      required: ['coin1', 'coin1ActionIndex', 'coin2', 'coin2ActionIndex'] },
    { name: 'broadcast', required: [] },
    { name: 'message',   required: ['destination'] }
];

function buildValidParams(method) {
    const params = {};
    for (const field of method.required) {
        if (field.includes('Index')) params[field] = 0;
        else if (field === 'quantity' || field === 'giveAmount' || field === 'getAmount') params[field] = '100';
        else if (field === 'destination') params[field] = 'test_destination';
        else if (field === 'tick' || field === 'dividendTick') params[field] = 'TOKEN';
        else if (field === 'coin1' || field === 'coin2') params[field] = 'BTC';
        else params[field] = 'test_value';
    }
    return params;
}

function buildEmitContract(methodName, params) {
    return 'module.exports = function(xchain) {\n' +
        '    xchain.emit.' + methodName + '(' + JSON.stringify(params) + ');\n' +
        '};';
}

function buildMultiEmitContract(count) {
    const lines = ['module.exports = function(xchain) {'];
    for (let i = 0; i < count; i++) {
        lines.push('    xchain.emit.send({ destination: "addr' + i + '", tick: "T", quantity: "1" });');
    }
    lines.push('};');
    return lines.join('\n');
}

// Valid emit contract for each method
const validEmitContractArb = fc.constantFrom(...EMIT_METHODS).map(method =>
    buildEmitContract(method.name, buildValidParams(method))
);

// Malformed emit contracts — missing required fields
const missingFieldEmitArb = fc.constantFrom(
    ...EMIT_METHODS.filter(m => m.required.length > 0).map(method => {
        const params = buildValidParams(method);
        // Remove first required field
        delete params[method.required[0]];
        return buildEmitContract(method.name, params);
    })
);

// Non-object params to emit methods
const nonObjectEmitArb = fc.constantFrom(
    ...EMIT_METHODS.map(m => buildEmitContract(m.name, null)),
    ...EMIT_METHODS.map(m => buildEmitContract(m.name, 'string')),
    ...EMIT_METHODS.map(m => buildEmitContract(m.name, 42)),
    ...[
        'module.exports = function(xchain) { xchain.emit.send([1,2,3]); };',
        'module.exports = function(xchain) { xchain.emit.send(true); };',
    ]
);

// Extra/adversarial fields in params
const extraFieldEmitArb = fc.constantFrom(...EMIT_METHODS).chain(method => {
    return fc.constantFrom(
        '__proto__', 'constructor', 'toString', 'valueOf', 'action', 'type'
    ).map(extraKey => {
        const params = buildValidParams(method);
        params[extraKey] = 'injected';
        return buildEmitContract(method.name, params);
    });
});

// Multi-emit contract testing emission cap boundary
const multiEmitContractArb = fc.integer({ min: 1, max: 60 }).map(count =>
    buildMultiEmitContract(count)
);

// Combined
const emitContractArb = fc.oneof(
    { weight: 3, arbitrary: validEmitContractArb },
    { weight: 2, arbitrary: missingFieldEmitArb },
    { weight: 2, arbitrary: nonObjectEmitArb },
    { weight: 2, arbitrary: extraFieldEmitArb },
    { weight: 1, arbitrary: multiEmitContractArb }
);

module.exports = {
    EMIT_METHODS,
    buildValidParams,
    buildEmitContract,
    buildMultiEmitContract,
    validEmitContractArb,
    missingFieldEmitArb,
    nonObjectEmitArb,
    extraFieldEmitArb,
    multiEmitContractArb,
    emitContractArb
};
