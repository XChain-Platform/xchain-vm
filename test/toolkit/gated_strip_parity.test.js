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
 * Toolkit: the height-gated BigInt surface strip is taught and warned on.
 *
 * The sandbox deletes BigInt64Array / BigUint64Array and the DataView BigInt
 * accessors once the BigInt surface strip is active. The authoring knowledge
 * and the static gate must cover that set too, or a model is told nothing, the
 * gate reports clean, and the contract throws on its first execution.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const { KNOWLEDGE } = require('../../src/toolkit/authoring.js');
const { runGate } = require('../../src/toolkit/gate.js');
const SHARED = require('../../src/stripped-globals.js');

// sandbox.js requires isolated-vm at the top level; load it defensively so the
// isolate-free checks below still run where the binding cannot dlopen.
let sandboxMod = null;
try { sandboxMod = require('../../src/sandbox.js'); } catch (e) { /* no isolate */ }

function wrap(body) {
    return 'module.exports = function(xchain) { ' + body + ' };';
}

function gatedHits(g) {
    return g.warnings.filter((w) => w.rule === 'gated-stripped-global');
}

function hitName(w) {
    const m = /^gated stripped name: (\S+) at line /.exec(w.message);
    return m ? m[1] : null;
}

describe('Toolkit authoring: gated BigInt surface strip', function () {
    it('teaches the gated stripped globals from the one shared definition', function () {
        assert.strictEqual(KNOWLEDGE.gatedStrippedGlobals, SHARED.BIGINT_SURFACE_STRIPPED_GLOBAL_NAMES,
            'the gated list must be the array stripped-globals.js froze, not a copy');
    });

    it('every gated stripped global and DataView BigInt method reaches the rendered hard rules', function () {
        const text = KNOWLEDGE.hardRules.join('\n');
        const names = [].concat(KNOWLEDGE.gatedStrippedGlobals, KNOWLEDGE.gatedStrippedProtoMethods);
        assert.ok(names.length >= 6, 'expected the two typed arrays and four DataView methods');
        for (const name of names) {
            assert.ok(new RegExp('\\b' + name + '\\b').test(text),
                'the hard rules never name the gated stripped name ' + name);
        }
    });

    it('the taught DataView methods equal sandbox.js BIGINT_SURFACE_STRIPPED_PROTO_METHODS', function () {
        if (!sandboxMod || !sandboxMod.BIGINT_SURFACE_STRIPPED_PROTO_METHODS) return this.skip();
        assert.deepStrictEqual(
            KNOWLEDGE.gatedStrippedProtoMethods.slice().sort(),
            sandboxMod.BIGINT_SURFACE_STRIPPED_PROTO_METHODS.map((m) => m.method).sort());
    });

    it('the taught global names cover every global the sandbox can delete', function () {
        if (!sandboxMod || !sandboxMod.STRIPPED_GLOBAL_NAMES) return this.skip();
        assert.deepStrictEqual(
            [].concat(KNOWLEDGE.strippedGlobals, KNOWLEDGE.gatedStrippedGlobals).sort(),
            [].concat(sandboxMod.STRIPPED_GLOBAL_NAMES, sandboxMod.BIGINT_SURFACE_STRIPPED_GLOBAL_NAMES).sort());
    });
});

describe('Toolkit gate: gated BigInt surface strip warnings', function () {
    it('warns on a BigInt typed-array global without changing the verdict', function () {
        const base = runGate(wrap('return xchain.state.get("a");'));
        const g = runGate(wrap('var a = new BigInt64Array(1); var b = BigUint64Array; return xchain.state.get("a");'));
        assert.strictEqual(g.ok, base.ok, 'the gated strip must stay a warning, never a blocking error');
        assert.deepStrictEqual(gatedHits(g).map((w) => hitName(w)).sort(),
            ['BigInt64Array', 'BigUint64Array']);
        assert.ok(gatedHits(g).every((w) => w.severity === 'warning' && w.line === 1));
    });

    it('warns on a DataView BigInt accessor', function () {
        const g = runGate(wrap('var dv = xchain.state.get("dv"); return dv.getBigInt64(0) + dv["setBigUint64"];'));
        assert.deepStrictEqual(gatedHits(g).map((w) => hitName(w)).sort(),
            ['getBigInt64', 'setBigUint64']);
    });

    it('does not warn on a contract-local binding of the same name', function () {
        const g = runGate(wrap('var BigInt64Array = 1; return BigInt64Array;'));
        assert.strictEqual(gatedHits(g).length, 0);
    });
});
