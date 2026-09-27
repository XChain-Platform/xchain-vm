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
 * Syntax validator lint-option forwarding
 ********************************************************************/
'use strict';

const assert = require('assert');

function withLintSourceStub(run) {
    const lintCorePath = require.resolve('../../../src/lint_core.js');
    const syntaxPath = require.resolve('../../../src/syntax.js');
    const cachedLintCore = require.cache[lintCorePath];
    const cachedSyntax = require.cache[syntaxPath];
    const realLintCore = cachedLintCore ? cachedLintCore.exports : require(lintCorePath);
    const calls = [];

    require.cache[lintCorePath] = {
        id: lintCorePath,
        filename: lintCorePath,
        loaded: true,
        exports: {
            ...realLintCore,
            lintSource(code, opts) {
                calls.push({ code, opts });
                return { errors: [] };
            }
        }
    };
    delete require.cache[syntaxPath];

    try {
        return run(require(syntaxPath).validateSyntax, calls);
    } finally {
        if (cachedLintCore) require.cache[lintCorePath] = cachedLintCore;
        else delete require.cache[lintCorePath];
        if (cachedSyntax) require.cache[syntaxPath] = cachedSyntax;
        else delete require.cache[syntaxPath];
    }
}

describe('validateSyntax lint-option forwarding', function () {
    it('forwards the optional-chain default and explicit values', function () {
        withLintSourceStub((validateSyntax, calls) => {
            validateSyntax('const a = 1;');
            validateSyntax('const a = 1;', { enforceLintOptionalChain: true });
            validateSyntax('const a = 1;', { enforceLintOptionalChain: false });

            assert.deepStrictEqual(calls.map((call) => call.opts.optionalChain),
                [true, true, false]);
        });
    });

    it('continues to forward the global-alias option independently', function () {
        withLintSourceStub((validateSyntax, calls) => {
            validateSyntax('const a = 1;', { enforceLintGlobalAlias: false });
            validateSyntax('const a = 1;', { enforceLintGlobalAlias: true });

            assert.deepStrictEqual(calls.map((call) => call.opts.globalAlias),
                [false, true]);
            assert.deepStrictEqual(calls.map((call) => call.opts.optionalChain),
                [true, true]);
        });
    });
});
