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
 * Toolkit: AI-assisted contract authoring harness (Tier 3).
 *
 * Pure/static: the `complete` LLM client is injected (fake), and validation
 * runs the acorn-only deploy gate, so this suite needs no isolated-vm and runs
 * on any OS/CPU. Require the module DIRECTLY (not the toolkit index) to keep it
 * runnable where isolated-vm cannot dlopen.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const { extractContractCode } = require('../../../src/toolkit/authoring.js');

// A gate-clean counter contract used as the model's "good" answer. It carries
// `meta` because CONTRACT_META_REQUIRED makes identity a deploy verdict: a
// nameless contract is gate-BLOCKED, which is what NAMELESS_CONTRACT below drives.
const CLEAN_CONTRACT = `// SPDX-License-Identifier: MIT
module.exports = {
    meta: { name: 'Counter', description: 'A counter anyone may increment.', version: '1.0.0' },
    initialize: function (xchain) {
        xchain.state.set('count', '0');
    },
    increment: function (xchain) {
        var c = xchain.state.get('count') || '0';
        xchain.state.set('count', xchain.math.add(c, '1'));
        return xchain.state.get('count');
    }
};`;

// Wrap contract source in a model-style fenced reply, optionally with notes.
function reply(code, lang, notes) {
    let out = '```' + (lang || 'javascript') + '\n' + code + '\n```';
    if (notes) out += '\n\nNotes:\n' + notes;
    return out;
}

describe('Toolkit authoring: response extraction', function () {
    it('pulls the first fenced block and separates trailing notes', function () {
        const r = reply(CLEAN_CONTRACT, 'javascript', 'value enters via DEPOSIT, not msg.value.');
        const ex = extractContractCode(r);
        assert.strictEqual(ex.hadFence, true);
        assert(/module\.exports/.test(ex.code));
        assert(/DEPOSIT/.test(ex.notes));
        assert(!/```/.test(ex.notes), 'notes must not include the fence');
    });

    it('reads the fence language tag', function () {
        const ex = extractContractCode(reply('const x = 1;', 'typescript'));
        assert.strictEqual(ex.lang, 'typescript');
    });

    it('falls back to raw text when there is no fence', function () {
        const ex = extractContractCode('module.exports = function (xchain) { return "1"; };');
        assert.strictEqual(ex.hadFence, false);
        assert(/module\.exports/.test(ex.code));
    });

    it('returns null code for empty input', function () {
        assert.strictEqual(extractContractCode('').code, null);
        assert.strictEqual(extractContractCode(null).code, null);
    });
});
