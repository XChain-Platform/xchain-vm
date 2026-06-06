// @ts-nocheck
// 
// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

const assert = require('assert');
const { ContractRevertError, GasExhaustedError } = require('../../src/errors.js');

describe('Error Classes', function() {

    describe('ContractRevertError', function() {
        it('should be an instance of Error', function() {
            const err = new ContractRevertError('test reason');
            assert(err instanceof Error);
        });

        it('should have name ContractRevertError', function() {
            const err = new ContractRevertError('test');
            assert.strictEqual(err.name, 'ContractRevertError');
        });

        it('should use reason as message', function() {
            const err = new ContractRevertError('not enough tokens');
            assert.strictEqual(err.message, 'not enough tokens');
        });

        it('should have a stack trace', function() {
            const err = new ContractRevertError('test');
            assert(typeof err.stack === 'string');
            assert(err.stack.includes('ContractRevertError'));
        });

        it('should handle undefined reason', function() {
            const err = new ContractRevertError();
            assert.strictEqual(err.message, '');
            assert.strictEqual(err.name, 'ContractRevertError');
        });

        it('should handle empty string reason', function() {
            const err = new ContractRevertError('');
            assert.strictEqual(err.message, '');
        });
    });

    describe('GasExhaustedError', function() {
        it('should be an instance of Error', function() {
            const err = new GasExhaustedError(1500, 1000);
            assert(err instanceof Error);
        });

        it('should have name GasExhaustedError', function() {
            const err = new GasExhaustedError(1500, 1000);
            assert.strictEqual(err.name, 'GasExhaustedError');
        });

        it('should format message with used and ceiling', function() {
            const err = new GasExhaustedError(1500, 1000);
            assert.strictEqual(err.message, 'gas exhausted: used 1500 of 1000');
        });

        it('should expose used property', function() {
            const err = new GasExhaustedError(1500, 1000);
            assert.strictEqual(err.used, 1500);
        });

        it('should expose ceiling property', function() {
            const err = new GasExhaustedError(1500, 1000);
            assert.strictEqual(err.ceiling, 1000);
        });

        it('should have a stack trace', function() {
            const err = new GasExhaustedError(100, 50);
            assert(typeof err.stack === 'string');
        });
    });
});
