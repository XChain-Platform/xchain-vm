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
 * Toolkit gate: the contract-identity rule (`contract-meta`).
 *
 * CONTRACT_META_REQUIRED makes meta.name / meta.description a deploy verdict, so
 * the gate must refuse a nameless contract BEFORE the author pays a fee, with the
 * same string the chain would write. Static (acorn only), so this suite runs on
 * any OS/CPU like the rest of the gate suite.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
// Directly, not via the toolkit index: gate.js pulls in acorn and lint-core only,
// so this stays runnable where isolated-vm cannot dlopen.
const { runGate, getExportedMeta, isValidMetaText } = require('../../src/toolkit/gate.js');

// The consensus strings, retyped here rather than imported, so a silent edit to
// gate.js's copy fails this suite instead of moving with it. They are frozen
// tokens: the chain writes exactly these into the action status (spec 2.3).
const REQUIRED = 'invalid: CONTRACT_MANIFEST (meta required)';
const NAME_BAD = 'invalid: CONTRACT_MANIFEST (meta.name must be a string of 1..64 bytes, printable, trimmed)';
const DESC_BAD = 'invalid: CONTRACT_MANIFEST (meta.description must be a string of 1..512 bytes, printable, trimmed)';
const VERSION_BAD = 'invalid: CONTRACT_MANIFEST (meta.version must be a string of 1..32 bytes, printable, trimmed)';

// An object-export contract with the given meta block spliced in (or none).
function contractWith(metaLiteral) {
    return 'module.exports = {\n' +
        (metaLiteral ? '    meta: ' + metaLiteral + ',\n' : '') +
        '    initialize: function (xchain) { xchain.state.set("n", "0"); },\n' +
        '    bump: function (xchain) { xchain.state.set("n", xchain.math.add(xchain.state.get("n"), "1")); }\n' +
        '};\n';
}

const VALID_META = '{ name: "Escrow", description: "Two-party escrow with an arbiter.", version: "1.0.0" }';

function metaErrors(gate) {
    return gate.errors.filter((e) => e.rule === 'contract-meta');
}

describe('Toolkit gate: contract identity (contract-meta)', function () {

    it('blocks a nameless object-export contract with the consensus string', function () {
        const g = runGate(contractWith(null));
        assert.strictEqual(g.ok, false, 'a contract with no meta must not pass the gate');
        const errs = metaErrors(g);
        assert.strictEqual(errs.length, 1, 'exactly one contract-meta error: ' + JSON.stringify(g.errors));
        assert(errs[0].message.startsWith(REQUIRED),
            'the error must carry the chain\'s verdict string, got: ' + errs[0].message);
        assert(!g.advisories.some((e) => e.rule === 'contract-meta'),
            'contract-meta must be blocking, never demoted to an advisory');
    });

    it('passes a contract carrying a valid meta', function () {
        const g = runGate(contractWith(VALID_META));
        assert.strictEqual(g.ok, true, 'valid meta must pass: ' + JSON.stringify(g.errors));
        assert.strictEqual(metaErrors(g).length, 0);
        assert.strictEqual(g.advisories.filter((e) => e.rule === 'contract-meta-undecidable').length, 0,
            'a literal meta must be decided, not advised');
    });

    it('passes a function-export contract that attaches fn.meta (spec R1)', function () {
        const src = 'function contract(xchain) { return xchain.state.get("a"); }\n' +
            'contract.meta = { name: "Ping", description: "Returns the stored value.", version: "1.0.0" };\n' +
            'module.exports = contract;\n';
        const g = runGate(src);
        assert.strictEqual(g.ok, true, 'fn.meta must satisfy the rule: ' + JSON.stringify(g.errors));
        assert.deepStrictEqual(getExportedMeta(src), {
            status: 'present',
            name: 'Ping',
            description: 'Returns the stored value.',
            version: '1.0.0',
            computed: [],
            nonStringLiteral: [],
            line: 2
        });
    });

    it('blocks a function-export contract with no fn.meta assignment', function () {
        const src = 'function contract(xchain) { return "1"; }\n' +
            'module.exports = contract;\n';
        assert.deepStrictEqual(getExportedMeta(src), { status: 'absent' });
        const g = runGate(src);
        assert.strictEqual(g.ok, false);
        assert(metaErrors(g).some((e) => e.message.startsWith(REQUIRED)));
    });

    it('advises (never blocks) when meta is computed rather than a literal', function () {
        const src = 'var META = { name: "Escrow", description: "d" };\n' + contractWith('META');
        assert.deepStrictEqual(getExportedMeta(src), { status: 'undecidable' });
        const g = runGate(src);
        assert.strictEqual(g.ok, true, 'an undecidable read must not block a contract the chain may accept');
        assert.strictEqual(metaErrors(g).length, 0);
        const adv = g.advisories.filter((e) => e.rule === 'contract-meta-undecidable');
        assert.strictEqual(adv.length, 1, 'the undecidable read must surface as an advisory');
        assert(/evaluates meta at deploy/.test(adv[0].message));
    });

    it('advises on an anonymous function export (no literal export shape to read)', function () {
        // The historic single-entry shape: the chain reads meta off the evaluated
        // module, and a static walk cannot see a property that is never assigned.
        const g = runGate('module.exports = function (xchain) { return xchain.state.get("a"); };');
        assert.strictEqual(g.ok, true);
        assert(g.advisories.some((e) => e.rule === 'contract-meta-undecidable'));
    });

    it('advises on an export object using a spread', function () {
        const src = 'var base = { a: 1 };\nmodule.exports = { ...base, meta: ' + VALID_META + ' };\n';
        assert.deepStrictEqual(getExportedMeta(src), { status: 'undecidable' });
    });

    describe('the text grammar, through the gate', function () {
        // The invisible code points are written as \u escapes INSIDE the contract
        // source string, so acorn decodes them into the literal exactly as an
        // author's pasted character would while this file stays readable.
        const CASES = [
            ['a missing name', '{ description: "A description." }', NAME_BAD],
            ['an empty name', '{ name: "", description: "A description." }', NAME_BAD],
            ['a 65-byte name (cap is 64)', '{ name: "' + 'A'.repeat(65) + '", description: "A description." }', NAME_BAD],
            ['a name with a leading space', '{ name: " Escrow", description: "A description." }', NAME_BAD],
            ['a name with a trailing NBSP', '{ name: "Escrow\\u00A0", description: "A description." }', NAME_BAD],
            ['a name with a C0 control', '{ name: "Esc\\u0001row", description: "A description." }', NAME_BAD],
            ['a name with a C1 control', '{ name: "Esc\\u0085row", description: "A description." }', NAME_BAD],
            ['a name with a bidi override (U+202E)', '{ name: "Esc\\u202Erow", description: "A description." }', NAME_BAD],
            ['a name with a zero-width space', '{ name: "Esc\\u200Brow", description: "A description." }', NAME_BAD],
            ['a missing description', '{ name: "Escrow" }', DESC_BAD],
            ['an empty description', '{ name: "Escrow", description: "" }', DESC_BAD],
            ['a 513-byte description (cap is 512)', '{ name: "Escrow", description: "' + 'd'.repeat(513) + '" }', DESC_BAD],
            ['a description with a C0 control', '{ name: "Escrow", description: "A\\u0007description." }', DESC_BAD],
            ['an empty version', '{ name: "Escrow", description: "A description.", version: "" }', VERSION_BAD],
            ['a 33-byte version (cap is 32)', '{ name: "Escrow", description: "A description.", version: "' + 'v'.repeat(33) + '" }', VERSION_BAD],
            // A LITERAL that is not a string is a value the gate can see, and the
            // chain rejects it; only a non-literal expression is computed meta.
            ['a non-string version literal', '{ name: "Escrow", description: "A description.", version: 1 }', VERSION_BAD],
            ['a null name literal', '{ name: null, description: "A description." }', NAME_BAD]
        ];
        for (const [label, meta, expected] of CASES) {
            it('blocks ' + label, function () {
                const g = runGate(contractWith(meta));
                assert.strictEqual(g.ok, false, label + ' must block');
                const messages = metaErrors(g).map((e) => e.message);
                assert(messages.includes(expected),
                    label + ' should report ' + JSON.stringify(expected) + ', got ' + JSON.stringify(messages));
            });
        }

        it('accepts an LF inside a description but not inside a name', function () {
            const withLf = runGate(contractWith('{ name: "Escrow", description: "Line one.\\nLine two." }'));
            assert.strictEqual(withLf.ok, true, 'LF is legal inside a description: ' + JSON.stringify(withLf.errors));
            const nameLf = runGate(contractWith('{ name: "Es\\ncrow", description: "A description." }'));
            assert.strictEqual(nameLf.ok, false);
            assert(metaErrors(nameLf).some((e) => e.message === NAME_BAD));
        });

        it('accepts a multi-byte name inside the byte cap and refuses it past it', function () {
            // 21 three-byte code points = 63 bytes; 22 = 66, over the 64-byte cap,
            // which is what proves the cap is bytes and not characters.
            const wide = '你';
            const ok = runGate(contractWith('{ name: "' + wide.repeat(21) + '", description: "A description." }'));
            assert.strictEqual(ok.ok, true, JSON.stringify(ok.errors));
            const over = runGate(contractWith('{ name: "' + wide.repeat(22) + '", description: "A description." }'));
            assert.strictEqual(over.ok, false);
            assert(metaErrors(over).some((e) => e.message === NAME_BAD));
        });

        it('advises on a computed name and never blocks it (seam S6, amended)', function () {
            // The chain EVALUATES meta in the isolate, so 'Escrow ' + suffix is a name
            // it accepts. A static gate that refused it would block a deploy the chain
            // would take, which is the one thing this rule must not do.
            const src = 'var suffix = "1";\n' +
                contractWith('{ name: "Escrow " + suffix, description: "A description." }');
            const g = runGate(src);
            assert.strictEqual(g.ok, true, 'a computed name must not block: ' + JSON.stringify(g.errors));
            assert.strictEqual(metaErrors(g).length, 0);
            const adv = g.advisories.filter((e) => e.rule === 'contract-meta-undecidable');
            assert.strictEqual(adv.length, 1);
            assert(/meta\.name is a computed expression/.test(adv[0].message), adv[0].message);
            // The read reports WHICH field it could not resolve, so a caller can say so.
            const read = getExportedMeta(src);
            assert.strictEqual(read.status, 'present');
            assert.deepStrictEqual(read.computed, ['name']);
            assert.strictEqual(read.name, null, 'a computed value has no literal to report');
            assert.strictEqual(read.description, 'A description.');
        });

        it('advises on a computed description and on a computed version', function () {
            for (const [field, meta] of [
                ['description', '{ name: "Escrow", description: DESC }'],
                ['version', '{ name: "Escrow", description: "A description.", version: v }']
            ]) {
                const g = runGate('var DESC = "d"; var v = "1.0.0";\n' + contractWith(meta));
                assert.strictEqual(g.ok, true, field + ' computed must not block: ' + JSON.stringify(g.errors));
                assert(g.advisories.some((e) => e.rule === 'contract-meta-undecidable' &&
                    e.message.indexOf('meta.' + field) !== -1), field + ' must be named in the advisory');
            }
        });

        it('still blocks the literal half when another field is computed', function () {
            // A computed name buys no amnesty for a missing description: the chain
            // rejects that one, and the gate can see it.
            const g = runGate('var suffix = "1";\n' + contractWith('{ name: "Escrow " + suffix }'));
            assert.strictEqual(g.ok, false);
            assert.deepStrictEqual(metaErrors(g).map((e) => e.message), [DESC_BAD]);
            assert(g.advisories.some((e) => e.rule === 'contract-meta-undecidable'));
        });

        it('treats a template literal as computed, not as a literal string', function () {
            const g = runGate(contractWith('{ name: `Escrow`, description: "A description." }'));
            assert.strictEqual(g.ok, true);
            assert.strictEqual(metaErrors(g).length, 0);
            assert(g.advisories.some((e) => e.rule === 'contract-meta-undecidable'));
        });
    });

    describe('isValidMetaText', function () {
        const wide = '你';

        it('measures the cap in UTF-8 bytes, not code units', function () {
            assert.strictEqual(isValidMetaText(wide.repeat(21), 64, false), true);   // 63 bytes
            assert.strictEqual(isValidMetaText(wide.repeat(22), 64, false), false);  // 66 bytes
        });

        it('refuses a lone surrogate', function () {
            assert.strictEqual(isValidMetaText('Escrow\uD800', 64, false), false);
        });

        it('refuses a non-string and the empty string', function () {
            assert.strictEqual(isValidMetaText(undefined, 64, false), false);
            assert.strictEqual(isValidMetaText(42, 64, false), false);
            assert.strictEqual(isValidMetaText('', 64, false), false);
        });

        it('allows interior punctuation and a trailing period', function () {
            assert.strictEqual(isValidMetaText('Two-party escrow (v2), with an arbiter.', 512, true), true);
        });

        it('treats an LF edge as untrimmed even where LF is allowed', function () {
            assert.strictEqual(isValidMetaText('\nA description.', 512, true), false);
            assert.strictEqual(isValidMetaText('A description.\n', 512, true), false);
            assert.strictEqual(isValidMetaText('A\ndescription.', 512, true), true);
        });
    });
});
