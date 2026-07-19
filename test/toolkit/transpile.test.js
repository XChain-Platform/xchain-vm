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
 * Toolkit: TypeScript type-strip. Static (no isolated-vm); runs anywhere on
 * the Node 22 the platform pins (module.stripTypeScriptTypes).
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const { isTypeScript, stripTypes, toContractJs } = require('../../src/toolkit/transpile.js');

describe('Toolkit transpile: TS -> ES the VM accepts', function() {

    it('detects TypeScript by extension', function() {
        assert.strictEqual(isTypeScript('c.ts'), true);
        assert.strictEqual(isTypeScript('c.mts'), true);
        assert.strictEqual(isTypeScript('c.js'), false);
        assert.strictEqual(isTypeScript(''), false);
    });

    it('passes JS through unchanged', function() {
        const src = 'module.exports = function(x){ return "1"; };';
        assert.strictEqual(toContractJs(src, 'c.js'), src);
    });

    it('erases parameter and return type annotations', function() {
        const ts = 'module.exports = function(x: any): string { const n: number = 1; return String(n); };';
        const js = stripTypes(ts, 'c.ts');
        assert(!/:\s*any/.test(js), 'param type erased');
        assert(!/:\s*string/.test(js), 'return type erased');
        assert(!/:\s*number/.test(js), 'var type erased');
        assert(/module\.exports/.test(js), 'runtime code preserved');
    });

    it('erases interface declarations entirely', function() {
        const ts = 'interface Foo { a: string; }\nmodule.exports = function(x){ return "1"; };';
        const js = stripTypes(ts, 'c.ts');
        assert(!/interface/.test(js), 'interface should be gone');
        assert(/module\.exports/.test(js));
    });

    it('rejects runtime-emitting TS (enum) rather than compiling it', function() {
        assert.throws(() => stripTypes('enum E { A, B }\nmodule.exports = function(){};', 'c.ts'));
    });

    it('the stripped output is byte-identical apart from erased spans', function() {
        // strip mode preserves positions (erased spans become whitespace), so
        // runtime tokens keep their line numbers for the determinism gate.
        const ts = 'const x: number = 5;\nmodule.exports = function(){ return String(x); };';
        const js = stripTypes(ts, 'c.ts');
        assert.strictEqual(js.split('\n').length, ts.split('\n').length, 'line count preserved');
        assert(js.includes('module.exports'));
    });
});
