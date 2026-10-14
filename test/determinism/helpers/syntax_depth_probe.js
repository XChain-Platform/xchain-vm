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
 * One fresh-process reading for the syntax-depth determinism test. argv: <shape> <N>.
 * Prints the deploy verdict and the regtest execute outcome cold, then again after
 * the parser and the VM are warmed by ordinary traffic, as a long-running node is.
 ********************************************************************/
'use strict';

const { validateSyntax } = require('../../../src/syntax.js');
const { createVM, execute } = require('../../fuzz/helpers/harness.js');
const { SHAPES, wrap } = require('./syntax_depth_shapes.js');

const [shape, nStr] = process.argv.slice(2);
const code = wrap(SHAPES[shape](Number(nStr)));
const REGTEST = { network: 'regtest', contractAddress: 'C:BTC:1', blockContext: { height: 100, timestamp: 4000000000, hash: 'h' } };
const DEPLOY = { enforceLintNestingDepth: true, enforceLintSyntaxDepth: true };

function deploy() {
    try {
        const r = validateSyntax(code, DEPLOY);
        return r.valid ? 'valid' : r.error;
    } catch (e) {
        return 'host fault: ' + e.name;
    }
}

async function run() {
    const vm = createVM({ maxCpuTimeMs: 5000 });
    vm.beginBlock();
    try {
        const r = await execute(vm, code, REGTEST);
        return [r.success, r.error, r.gasUsed];
    } catch (e) {
        return ['host fault', e.name];
    } finally {
        vm.endBlock();
    }
}

(async () => {
    const out = { deployCold: deploy(), execCold: await run() };
    const warmVm = createVM({ maxCpuTimeMs: 5000 });
    warmVm.beginBlock();
    for (let i = 0; i < 200; i++) {
        validateSyntax('module.exports = function(){ var x = ' + '!'.repeat(40 + (i % 50)) + '1; var y = 1 + 2 + ' + i + '; return x; };');
        if (i % 4 === 0) await execute(warmVm, 'module.exports = function(){ var a = 1; return ' + 'a ? 1 : '.repeat(40) + '1; };', REGTEST);
    }
    warmVm.endBlock();
    out.deployWarm = deploy();
    out.execWarm = await run();
    console.log(JSON.stringify(out));
})();
