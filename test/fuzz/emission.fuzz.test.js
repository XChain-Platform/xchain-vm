/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Fuzz Tests — Emission Actions
 *
 * Tests that all 16 emit methods handle valid, malformed, and
 * adversarial parameters correctly without violating invariants.
 ********************************************************************/

const fc = require('fast-check');
const assert = require('assert');
const { XChainVM, createVM, execute, FC_OPTIONS, DEFAULT_LIMITS } = require('./harness');
const { checkResultShape, checkAtomicity, checkEmissionCap, checkNoPrototypePollution, checkAll } = require('./invariants');
const {
    EMIT_METHODS, buildValidParams, buildEmitContract, buildMultiEmitContract,
    validEmitContractArb, missingFieldEmitArb, nonObjectEmitArb,
    extraFieldEmitArb, multiEmitContractArb, emitContractArb
} = require('./generators/emission');

(XChainVM ? describe : describe.skip)('Fuzz: Emissions', function() {
    this.timeout(120000);
    let vm;

    before(function() { vm = createVM(); });

    it('valid emit params always succeed with exactly 1 action', async function() {
        await fc.assert(fc.asyncProperty(validEmitContractArb, async (code) => {
            const result = await execute(vm, code);
            checkResultShape(result);
            if (!result.success) {
                throw new Error('Valid emit should succeed, got: ' + result.error);
            }
            assert.strictEqual(result.emittedActions.length, 1,
                'Expected 1 emitted action, got ' + result.emittedActions.length);
        }), FC_OPTIONS);
    });

    it('missing required fields fail atomically', async function() {
        await fc.assert(fc.asyncProperty(missingFieldEmitArb, async (code) => {
            const result = await execute(vm, code);
            checkResultShape(result);
            checkAtomicity(result);
            if (result.success) {
                throw new Error('Missing required field should fail');
            }
        }), FC_OPTIONS);
    });

    it('non-object params fail without crashing', async function() {
        await fc.assert(fc.asyncProperty(nonObjectEmitArb, async (code) => {
            const result = await execute(vm, code);
            checkResultShape(result);
            checkAtomicity(result);
            checkNoPrototypePollution();
        }), FC_OPTIONS);
    });

    it('extra fields in params are preserved but do not break invariants', async function() {
        await fc.assert(fc.asyncProperty(extraFieldEmitArb, async (code) => {
            const result = await execute(vm, code);
            checkAll(result);
        }), FC_OPTIONS);
    });

    it('emission cap is enforced at boundary', async function() {
        await fc.assert(fc.asyncProperty(multiEmitContractArb, async (code) => {
            const result = await execute(vm, code);
            checkResultShape(result);
            checkAtomicity(result);
            checkEmissionCap(result, DEFAULT_LIMITS.maxEmissions);
        }), FC_OPTIONS);
    });

    it('exactly maxEmissions succeeds, maxEmissions+1 fails', async function() {
        const atLimit = buildMultiEmitContract(DEFAULT_LIMITS.maxEmissions);
        const overLimit = buildMultiEmitContract(DEFAULT_LIMITS.maxEmissions + 1);

        const atResult = await execute(vm, atLimit);
        checkResultShape(atResult);
        assert.strictEqual(atResult.success, true, 'Emit at limit should succeed');
        assert.strictEqual(atResult.emittedActions.length, DEFAULT_LIMITS.maxEmissions);

        const overResult = await execute(vm, overLimit);
        checkResultShape(overResult);
        assert.strictEqual(overResult.success, false, 'Emit over limit should fail');
        checkAtomicity(overResult);
    });

    it('all 16 action types are correctly labeled', async function() {
        for (const method of EMIT_METHODS) {
            const code = buildEmitContract(method.name, buildValidParams(method));
            const result = await execute(vm, code);
            if (!result.success) {
                throw new Error(method.name + ' failed: ' + result.error);
            }
            assert.strictEqual(result.emittedActions[0].action, method.name.toUpperCase(),
                method.name + ' action type mismatch');
        }
    });

    it('mixed emit contracts maintain all invariants', async function() {
        await fc.assert(fc.asyncProperty(emitContractArb, async (code) => {
            const result = await execute(vm, code);
            checkAll(result);
        }), FC_OPTIONS);
    });

    after(function() {
        checkNoPrototypePollution();
    });
});
