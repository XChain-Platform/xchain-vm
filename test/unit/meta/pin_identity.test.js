'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { PINNED_FILES, grade, notGradedFields } = require('../../../bin/pin_identity.js');

const ROOT = path.join(__dirname, '../../..');

function realPin() {
    const files = {};
    for (const rel of PINNED_FILES) {
        const buf = fs.readFileSync(path.join(ROOT, rel));
        files[rel] = { canonical: crypto.createHash('sha256').update(buf).digest('hex') };
    }
    return { algorithm: 'sha256', files };
}

describe('bin/pin_identity grade', () => {
    it('pins exactly the three vendored lint files', () => {
        assert.deepStrictEqual(PINNED_FILES, [
            'src/lint_core.js',
            'src/metering.js',
            'src/stripped_globals.js',
        ]);
    });

    it('holds for a pin built from the real current hashes', () => {
        assert.deepStrictEqual(grade(realPin()), []);
    });

    it('reports one digest mismatch naming the file when one hex char changes', () => {
        const pin = realPin();
        const target = 'src/metering.js';
        const c = pin.files[target].canonical;
        pin.files[target].canonical = (c[0] === '0' ? '1' : '0') + c.slice(1);
        const diffs = grade(pin);
        assert.strictEqual(diffs.length, 1);
        assert.ok(diffs[0].includes(target));
        assert.ok(diffs[0].includes('digest mismatch'));
    });

});

describe('bin/pin_identity grade entry set', () => {
    it('reports a dropped entry as missing from the pin', () => {
        const pin = realPin();
        delete pin.files['src/stripped_globals.js'];
        const diffs = grade(pin);
        assert.strictEqual(diffs.length, 1);
        assert.ok(diffs[0].includes('src/stripped_globals.js'));
        assert.ok(diffs[0].includes('missing from pin (dropped entry)'));
    });

    it('reports an added unknown entry while the real three still hold', () => {
        const pin = realPin();
        pin.files['package.json'] = { canonical: 'x' };
        const diffs = grade(pin);
        const added = diffs.filter((d) => d.includes('unknown to this tool (added entry)'));
        assert.strictEqual(added.length, 1);
        assert.ok(added[0].includes('package.json'));
        for (const rel of PINNED_FILES) {
            assert.strictEqual(diffs.some((d) => d.startsWith(`${rel}:`)), false);
        }
    });

    it('rejects a non-sha256 algorithm without hashing any file', () => {
        const pin = realPin();
        pin.algorithm = 'sha1';
        const original = fs.readFileSync;
        let reads = 0;
        fs.readFileSync = function (...args) {
            reads += 1;
            return original.apply(this, args);
        };
        let diffs;
        try {
            diffs = grade(pin);
        } finally {
            fs.readFileSync = original;
        }
        assert.strictEqual(reads, 0);
        assert.strictEqual(diffs.length, 1);
        assert.ok(diffs[0].includes('algorithm'));
        assert.ok(diffs[0].includes('sha1'));
    });
});

describe('bin/pin_identity notGradedFields', () => {
    it('lists prose and sdk fields but never canonical', () => {
        const out = notGradedFields({
            what: 'x',
            files: { 'src/lint_core.js': { canonical: 'abc', vendoredInSdk: true } },
        });
        assert.deepStrictEqual(out, ['what', 'files.src/lint_core.js.vendoredInSdk']);
    });
});
