'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const { CONTRACT_ECMA_VERSION } = require('../../../src/metering.js');

const fixturePath = path.join(__dirname, '../../fixtures/lint/optional_chain_active_corpus.json');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const allowedRules = new Set(['banned-async', 'banned-wasm', 'banned-math']);

describe('optional-chain active corpus fixture shape', function () {
    it('contains thirteen distinct, parseable cases with supported verdicts', function () {
        assert.strictEqual(typeof fixture.note, 'string');
        assert.ok(fixture.note.trim().length > 0);
        assert.ok(Array.isArray(fixture.cases));
        assert.strictEqual(fixture.cases.length, 13);

        const sources = new Set();
        for (const testCase of fixture.cases) {
            assert.strictEqual(typeof testCase.source, 'string');
            assert.ok(!sources.has(testCase.source), 'duplicate source: ' + testCase.source);
            sources.add(testCase.source);

            for (const key of ['activeRules', 'aliasOffRules']) {
                assert.ok(Array.isArray(testCase[key]), key + ' must be an array');
                assert.ok(testCase[key].every((rule) => allowedRules.has(rule)),
                    key + ' contains an unsupported rule');
            }

            acorn.parse(testCase.source, {
                ecmaVersion: CONTRACT_ECMA_VERSION,
                sourceType: 'script'
            });
        }
    });
});
