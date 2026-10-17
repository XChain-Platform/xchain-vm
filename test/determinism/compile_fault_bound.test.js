// @ts-nocheck
//
// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', 'src');
const EXECUTE = path.join(ROOT, 'index', 'runtime', 'execute.js');

function sourceFiles(dir = ROOT) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const absolute = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...sourceFiles(absolute));
        else if (entry.name.endsWith('.js')) out.push(absolute);
    }
    return out;
}

describe('wrapper compile host-fault halt boundary', function () {
    it('loads the activation only at the entry and wrapper execution boundary', function () {
        const consumers = sourceFiles()
            .filter((file) => fs.readFileSync(file, 'utf8').includes('host_fault_halt_heights.js'))
            .map((file) => path.relative(ROOT, file))
            .sort();

        assert.deepStrictEqual(consumers, ['index.js', 'index/runtime/execute.js']);
    });

    it('keeps the overflow throw and host-fault halt throw separate and ordered', function () {
        const source = fs.readFileSync(EXECUTE, 'utf8');
        const ordered = [
            "                if (__overflowIsHostFault && isHostStackOverflow(e))",
            "                    throw new HostFaultError('compilation stack overflow: ' + e.message);",
            "                if (isHostFaultHaltActive(opts.network, __pkg3Coin, __pkg3Height))",
            "                    throw new HostFaultError('wrapper compilation failed: ' + e.message);",
            "                return this.errorResult(gasTracker, emissionCollector, 'error: compilation failed: ' + e.message);",
        ].join('\n');

        assert.ok(source.includes(ordered), 'wrapper compile catch no longer has the bounded throw sequence');
        assert.strictEqual(source.split("HostFaultError('wrapper compilation failed: '").length - 1, 1);
    });
});
