'use strict';

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
 * Parity gate for the simulator's lint leg of the DEPLOY gate against the
 * indexer that owns it. The indexer builds the validateSyntax flag set in
 * actions/deploy/lint.js resolveLintFlags; the simulator builds its own in
 * deployGateVerdict. A flag the indexer passes and the simulator omits is not
 * neutral, because syntax.js reads a missing flag as ON. This file holds the
 * two flag sets equal, and holds the mirrored delimiter-nesting heights equal
 * to the registry row the indexer reads them from.
 *
 * Sibling reads skip when the sibling is absent, except where
 * XCHAIN_REQUIRE_SIBLINGS=1 is exported (bin/ci-all.sh), where a missing
 * sibling is a hard failure rather than a green-by-skip.
 ********************************************************************/

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const { siblingCheckout, skipOrFail } = require('../helpers/sibling_checkout.js');
const { resolveSyntaxDepthActive } = require('../../src/index/lint_syntax_depth_heights.js');

// The simulator loads the VM (isolated-vm), so its checks skip with it.
let ContractSimulator = null;
let simConstants = null;
try {
    ({ ContractSimulator } = require('../../src/toolkit/simulator.js'));
    simConstants = require('../../src/toolkit/simulator/constants.js');
} catch (e) {
    console.log('Skipping simulator deploy-lint parity (isolated-vm unavailable):', e.message);
}

const PLATFORM_ROOT = path.resolve(__dirname, '..', '..', '..');
const NESTING_KEY = 'vm_lint_nesting_depth_activation.VM_LINT_NESTING_DEPTH_ACTIVATION';

// Resolve a sibling path, skipping (or failing under XCHAIN_REQUIRE_SIBLINGS) when absent or lane-symlinked.
function siblingOrSkip(ctx, rel) {
    const verdict = siblingCheckout(__dirname, path.join(PLATFORM_ROOT, rel));
    return skipOrFail(ctx, verdict, 'deploy-lint parity (' + rel + ')') ? verdict.path : null;
}

// Load a sibling module fresh so an edit between runs is never read from the require cache.
function loadFresh(absPath) {
    const resolved = require.resolve(absPath);
    delete require.cache[resolved];
    return require(resolved);
}

// Read the key names of resolveLintFlags' single shorthand return literal; throw on any other shape.
function scrapeIndexerFlagKeys(src, file) {
    const start = src.indexOf('function resolveLintFlags');
    assert.ok(start >= 0, 'resolveLintFlags not found in ' + file + '; re-point this scrape');
    const ret = src.slice(start).match(/return\s*\{([^}]*)\};/);
    assert.ok(ret, 'resolveLintFlags in ' + file + ' no longer ends in one `return { ... };` literal');
    const keys = ret[1].split(',').map((s) => s.trim()).filter(Boolean);
    for (const k of keys)
        assert.match(k, /^[A-Za-z_$][\w$]*$/, 'resolveLintFlags return entry `' + k + '` is not a bare identifier');
    assert.ok(keys.length > 0, 'resolveLintFlags returned no keys in ' + file);
    return keys;
}

// The own property names deployGateVerdict hands validateSyntax for one simulator.
async function simulatorFlagKeys(network) {
    const sim = new ContractSimulator({ coin: 'BTC', network });
    const seen = [];
    const real = sim.vm.validateSyntax;
    sim.vm.validateSyntax = (src, opts) => { seen.push(Object.getOwnPropertyNames(opts)); return { valid: true }; };
    try {
        sim.deployGateVerdict('module.exports = function(){ return "x"; };');
    } finally { sim.vm.validateSyntax = real; await sim.close(); }
    assert.strictEqual(seen.length, 1, 'deployGateVerdict did not reach validateSyntax exactly once');
    return seen[0];
}

describe('simulator deploy-gate lint leg agrees with the indexer', function () {
    this.timeout(30000);

    it('passes exactly the flag set the indexer resolveLintFlags returns', async function () {
        if (!ContractSimulator) this.skip();
        const file = siblingOrSkip(this, path.join('xchain-indexer', 'src', 'actions', 'deploy', 'lint.js'));
        if (!file) return;
        const indexer = scrapeIndexerFlagKeys(fs.readFileSync(file, 'utf8'), file).sort();
        for (const network of ['mainnet', 'testnet', 'regtest']) {
            const ours = (await simulatorFlagKeys(network)).sort();
            const missing = indexer.filter((k) => !ours.includes(k));
            const extra = ours.filter((k) => !indexer.includes(k));
            assert.deepStrictEqual({ missing, extra }, { missing: [], extra: [] },
                network + ': deployGateVerdict and the indexer resolveLintFlags pass different flags; ' +
                'a flag missing here reads as ON in syntax.js');
        }
    });

    it('mirrors the indexer delimiter-nesting registry row slot for slot', function () {
        if (!simConstants) this.skip();
        const regFile = siblingOrSkip(this, path.join('xchain-indexer', 'src', 'consensus', 'gate_registry.js'));
        if (!regFile) return;
        const coreFile = siblingOrSkip(this, path.join('xchain-indexer', 'src', 'protocol_changes', 'core.js'));
        if (!coreFile) return;
        const row = loadFresh(regFile).get(NESTING_KEY);
        const { UNARMED } = loadFresh(coreFile);
        const ours = simConstants.LINT_NESTING_DEPTH_HEIGHTS;
        const coinKeys = Object.keys(row).filter((k) => k.includes(':')).sort();
        assert.deepStrictEqual(Object.keys(ours).sort(), coinKeys,
            'LINT_NESTING_DEPTH_HEIGHTS and the ' + NESTING_KEY + ' row name different coin slots');
        for (const slot of coinKeys) {
            const expected = ours[slot] === null ? UNARMED : ours[slot];
            assert.strictEqual(row[slot], expected, slot + ': the simulator arms delimiter nesting at ' +
                ours[slot] + ' but the indexer row says ' + row[slot]);
        }
    });

    it('resolves delimiter nesting exactly as the indexer registry does at every boundary', function () {
        if (!simConstants) this.skip();
        const regFile = siblingOrSkip(this, path.join('xchain-indexer', 'src', 'consensus', 'gate_registry.js'));
        if (!regFile) return;
        const registry = loadFresh(regFile);
        const ours = simConstants.LINT_NESTING_DEPTH_HEIGHTS;
        let checked = 0;
        for (const coin of ['BTC', 'LTC', 'DOGE']) {
            for (const network of ['mainnet', 'testnet', 'regtest']) {
                const t = ours[coin + ':' + network];
                const heights = [0, 1, 99999999].concat(Number.isFinite(t) ? [t - 1, t] : []);
                for (const h of heights) {
                    assert.strictEqual(resolveSyntaxDepthActive(ours, network, coin, h),
                        registry.activeAt(NESTING_KEY, network, coin, h, null),
                        coin + ':' + network + '@' + h + ': simulator and indexer disagree on delimiter nesting');
                    checked++;
                }
            }
        }
        assert.ok(checked >= 33, 'boundary sweep checked only ' + checked + ' cases');
    });
});
