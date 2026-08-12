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
 *********************************************************************/

// engines.node must keep an upper bound below Node 23.
//
// isolated-vm 5.0.4 carries a native binding that node-gyp cannot build on
// Node 24: it uses `T::IsStackAllocatedTypeMarker`, a V8 API that major
// removed. A clean build probe compiles and loads on 22.22.3 and fails on
// 24.15.0, so the bound is measured rather than stylistic.
//
// The failure mode this pins is quiet: an `engines.node` of ">=22.0.0"
// ADMITS 24, so `npm install` proceeds normally right up to the compile,
// and preflight.test.js (the dlopen guard) only fires later, on a machine
// that got far enough to run tests at all. Declared policy has to state the
// constraint the dependency actually has.
//
// Deliberately requires nothing from src/: this file must stay green on a
// host where the native binding cannot load, which is exactly the host that
// most needs to be told the Node version is wrong.

const assert = require('assert');
const pkg = require('../../package.json');

/** The exclusive upper bound a single npm comparator implies, or null. */
function comparatorCeiling(token) {
    const parse = (raw) => {
        const m = /^v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?/.exec(String(raw).trim());
        if (!m) return null;
        const num = (s) => (s === undefined || s === 'x' || s === '*' ? 0 : Number(s));
        return [Number(m[1]), num(m[2]), num(m[3])];
    };
    const t = token.trim();
    let m = /^<=(.+)$/.exec(t);
    if (m) { const v = parse(m[1]); return v && [v[0], v[1], v[2] + 1]; }
    m = /^<(.+)$/.exec(t);
    if (m) return parse(m[1]);
    if (/^(>=?|\*)/.test(t)) return null;
    m = /^\^(.+)$/.exec(t);
    if (m) { const v = parse(m[1]); return v && [v[0] + 1, 0, 0]; }
    m = /^~(.+)$/.exec(t);
    if (m) { const v = parse(m[1]); return v && [v[0], v[1] + 1, 0]; }
    m = /^=?(\d+)(\.[x*])?$/.exec(t);
    if (m) return [Number(m[1]) + 1, 0, 0];
    return null;
}

const lte = (a, b) => a[0] !== b[0] ? a[0] < b[0]
    : a[1] !== b[1] ? a[1] < b[1]
        : a[2] <= b[2];

/** True only when EVERY `||` alternative is bounded at or below 23.0.0. */
function boundedBelow23(range) {
    if (typeof range !== 'string' || !range.trim()) return false;
    return range.split('||').every((alt) =>
        alt.trim().split(/\s+/).map(comparatorCeiling).filter(Boolean)
            .some((c) => lte(c, [23, 0, 0])));
}

describe('packaging: engines.node ceiling', function () {
    it('still depends on isolated-vm, so the ceiling is still load-bearing', function () {
        // If this ever fails, the constraint moved: re-derive the ceiling from
        // whatever the new native dependency supports, do not just widen it.
        assert.ok(pkg.dependencies && pkg.dependencies['isolated-vm'],
            'isolated-vm is no longer a direct dependency; revisit the engines ceiling');
    });

    it('declares an engines.node range', function () {
        assert.strictEqual(typeof (pkg.engines && pkg.engines.node), 'string',
            'engines.node must be declared: an absent range admits every Node major');
    });

    it('excludes Node 23 and above', function () {
        const range = pkg.engines.node;
        assert.ok(boundedBelow23(range),
            `engines.node="${range}" admits Node 23+, where isolated-vm cannot build. Use ">=22.0.0 <23".`);
    });

    it('still admits the pinned canonical runtime (.nvmrc: Node 22)', function () {
        const range = pkg.engines.node;
        assert.ok(/(^|\s)>=\s*22(\.|\s|$)/.test(range),
            `engines.node="${range}" no longer states the Node 22 floor the validator fleet runs`);
    });

    it('keeps a written reason next to the ceiling', function () {
        // The bound looks arbitrary six months from now; the comment is what
        // stops the next reader from "modernising" it back to open-ended.
        assert.match(String(pkg.engines.comment || ''), /isolated-vm/i,
            'engines.comment should say why the range is capped');
    });
});
