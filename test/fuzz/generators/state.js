/*********************************************************************
 * Fuzz Generators — State Operations
 *
 * Generates adversarial keys, values, initial state, and contracts
 * that exercise state CRUD in adversarial ways.
 ********************************************************************/

const fc = require('fast-check');

const stateKeyArb = fc.oneof(
    fc.string({ minLength: 1, maxLength: 50 }),
    fc.constantFrom(
        '',
        '__proto__',
        'constructor',
        'hasOwnProperty',
        'toString',
        'valueOf',
        '__defineGetter__',
        '__lookupGetter__',
        'isPrototypeOf',
        'propertyIsEnumerable',
        '\x00',
        '\x00key',
        'a'.repeat(1024),       // exactly at limit
        'a'.repeat(1025),       // 1 byte over limit
        'a'.repeat(2048),       // well over limit
        '\u{1F600}'.repeat(300) // multi-byte unicode at boundary
    )
);

const stateValueArb = fc.oneof(
    fc.string(),
    fc.integer(),
    fc.boolean(),
    fc.constantFrom(true, false, 0, 1, -1, '', 'hello'),
    fc.constant({ nested: { deep: 'value' } }),
    fc.constant([1, 2, 3]),
    fc.constant({ a: 'x'.repeat(100) })
);

// Values that should be rejected by StateManager
const invalidStateValueArb = fc.constantFrom(
    null,
    undefined
);

const initialStateArb = fc.dictionary(
    fc.string({ minLength: 1, maxLength: 20 }),
    fc.string({ maxLength: 100 }),
    { maxKeys: 20 }
);

function buildStateContract(key, value) {
    return 'module.exports = function(xchain) {\n' +
        '    xchain.state.set(' + JSON.stringify(key) + ', ' + JSON.stringify(value) + ');\n' +
        '    return xchain.state.get(' + JSON.stringify(key) + ');\n' +
        '};';
}

function buildDeleteSetCycleContract(key, cycles) {
    const lines = ['module.exports = function(xchain) {'];
    lines.push('    xchain.state.set(' + JSON.stringify(key) + ', "initial");');
    for (let i = 0; i < cycles; i++) {
        lines.push('    xchain.state.delete(' + JSON.stringify(key) + ');');
        lines.push('    xchain.state.set(' + JSON.stringify(key) + ', "cycle_' + i + '");');
    }
    lines.push('    return xchain.state.get(' + JSON.stringify(key) + ');');
    lines.push('};');
    return lines.join('\n');
}

function buildStateFloodContract(count) {
    const lines = ['module.exports = function(xchain) {'];
    for (let i = 0; i < count; i++) {
        lines.push('    xchain.state.set("key_' + i + '", "val_' + i + '");');
    }
    lines.push('    return ' + count + ';');
    lines.push('};');
    return lines.join('\n');
}

function buildLargeValueContract(size) {
    return 'module.exports = function(xchain) {\n' +
        '    xchain.state.set("large", "' + 'x'.repeat(size) + '");\n' +
        '};';
}

const stateContractArb = fc.tuple(
    stateKeyArb,
    stateValueArb
).map(([key, value]) => buildStateContract(key, value));

const deleteSetCycleArb = fc.tuple(
    fc.string({ minLength: 1, maxLength: 20 }),
    fc.integer({ min: 1, max: 20 })
).map(([key, cycles]) => buildDeleteSetCycleContract(key, cycles));

const stateFloodContractArb = fc.integer({ min: 1, max: 200 }).map(count =>
    buildStateFloodContract(count)
);

const largeValueContractArb = fc.integer({ min: 1, max: 131072 }).map(size =>
    buildLargeValueContract(size)
);

module.exports = {
    stateKeyArb,
    stateValueArb,
    invalidStateValueArb,
    initialStateArb,
    stateContractArb,
    deleteSetCycleArb,
    stateFloodContractArb,
    largeValueContractArb,
    buildStateContract,
    buildStateFloodContract,
    buildLargeValueContract
};
