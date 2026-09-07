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
 * Parity gate for the toolkit simulator's DEFAULT gas schedule and limits.
 *
 * `src/toolkit/simulator.js` is the gas-truth oracle a contract author sees:
 * `xchain-foundry simulate`, every scaffolded test suite and the README example
 * all quote its numbers. Its DEFAULT_GAS_SCHEDULE is a transcription of the
 * indexer's per-coin VM fee rows (`xchain-indexer/src/coins/{BTC,LTC,DOGE}.js`),
 * which are the values the chain actually charges. Nothing tied the two
 * together, so a re-pricing on the indexer side would leave the simulator
 * quoting stale gas with every in-repo suite green.
 *
 * Two layers, deliberately, mirroring xcall-constants-cross-repo.test.js:
 *   1. an in-repo layer that runs everywhere, including a standalone clone with
 *      no siblings: the golden values, the CANONICAL_GAS_KEYS key set, and the
 *      three limits that are single-sourced from VM modules; and
 *   2. the sibling reads, which prove the indexer's coin configs still agree.
 * Layer 1 exists because layer 2 skips when the sibling is absent. Where it IS
 * provided (bin/ci-all.sh exports XCHAIN_REQUIRE_SIBLINGS=1 and runs
 * `npm run ci`, which globs this directory) a missing sibling is a hard failure
 * rather than a silent skip, so the gate cannot pass green-by-skip there.
 *
 * The resource LIMITS get the same two layers. The production VM's limits live
 * as inline literals inside the `limits: { ... }` object in
 * xchain-indexer/src/actions.js, which is not a requireable data table, so layer
 * 2 SCRAPES that one block. The scrape is shape-coupled by necessity and says so
 * loudly: a block that moved or was reshaped fails with a re-point message
 * instead of silently matching nothing and passing. maxCpuTimeMs is additionally
 * cross-checked against the VM's own CONSENSUS_MAX_WALL_MS, which the indexer
 * documents itself as keeping equal.
 *
 * The simulator's DEFAULT BLOCK HEIGHT belongs here for the same reason its gas
 * schedule does: it is a default that has to agree with a consensus authority,
 * and an un-derived one silently simulates the wrong rule set. It is derived as
 * the MAX armed per-coin activation height across the VM's exported height-gate
 * maps, so `network: 'mainnet'` runs the Package-3 sandbox the live chain runs
 * rather than the pre-activation rule set a literal `1` selected. Layer 2 for
 * that number is the indexer's deploy-half twin
 * (src/vm_deploy_lint_pkg3_activation.js), which must carry identical heights or
 * the deploy verdict forks from the runtime strip.
 *
 * SCOPE, stated so nobody reads this guard as broader than it is: it covers the
 * numbers the SIMULATOR quotes. maxCodeSize is excluded from the indexer scrape
 * because both sides single-source it (deploy.MAX_CODE_SIZE / lint-core.js), so
 * there is no literal to compare, and the EXEC_LINT / LINT_GLOBAL_ALIAS twins are
 * pinned by consensus-params.test.js in each repo rather than here.
 ********************************************************************/

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const { ContractSimulator, DEFAULT_GAS_SCHEDULE, DEFAULT_LIMITS, GUARD_GAS_CEILING } =
    require('../../src/toolkit/simulator.js');
const XChainVM = require('../../src/index.js');
const { CANONICAL_GAS_KEYS } = require('../../src/gas.js');
const { MAX_CODE_SIZE } = require('../../src/lint-core.js');
const { VM_MAX_CALL_DEPTH, VM_MIN_CALL_GAS } = require('../../src/protocol/constants.js');
const { CONSENSUS_MAX_WALL_MS } = require('../../src/consensus-wall-clock.js');

// The frozen values. Editing one here without moving the indexer coin configs
// (and the VM constants the limits are single-sourced from) is the exact mistake
// this guard exists to catch.
const GOLDEN_GAS = {
    VM_COMPUTATION:     1,
    VM_STATE_READ:      100,
    VM_STATE_WRITE:     200,
    VM_STATE_DELETE:    100,
    VM_ORACLE_READ:     100,
    VM_CROSSCHAIN_READ: 100,
    VM_ATTEST_REQUEST:  5000,
    VM_EMISSION:        500,
    VM_XCALL_REQUEST:   2000,
    VM_XCALL_CALLBACK:  20000
};

const GOLDEN_LIMITS = {
    maxCpuTimeMs:      30000,
    maxMemory:         8,
    maxEmissions:      50,
    maxStateKeys:      10000,
    maxStateValueSize: 65536,
    maxCodeSize:       65536,
    maxCallDepth:      4,
    minCallGas:        5000
};

const COINS = ['BTC', 'LTC', 'DOGE'];

// Every limit the indexer states as a bare literal. maxCodeSize is left out on
// purpose: both sides single-source it, so there is no literal to compare.
const SCRAPED_LIMIT_KEYS = [
    'maxCpuTimeMs', 'maxMemory', 'maxEmissions', 'maxStateKeys', 'maxStateValueSize'
];

/**
 * Pull the indexer's VM `limits: { ... }` literals out of actions.js source.
 * Fails loud on a shape it does not recognize, because the failure mode this
 * whole layer exists to close is a scrape that quietly matches nothing.
 */
function scrapeIndexerLimits(src, rel) {
    const blocks = [...src.matchAll(/limits:\s*\{([\s\S]*?)^\s*\}/gm)];
    assert.strictEqual(blocks.length, 1,
        rel + ': expected exactly one `limits: {` VM-construction block, found ' + blocks.length +
        '. The block moved, split or gained a sibling; re-point this scrape rather than ' +
        'deleting it, or the simulator quotes limits nothing checks');
    const body = blocks[0][1];
    const out = {};
    for (const key of SCRAPED_LIMIT_KEYS) {
        const m = new RegExp('(?:^|\\n)\\s*' + key + '\\s*:\\s*(\\d+)\\s*,').exec(body);
        assert.ok(m, rel + ': the limits block no longer states `' + key + ': <number>`. It was ' +
            'renamed, moved out, or made an expression; re-point this scrape');
        out[key] = Number(m[1]);
    }
    return out;
}

// Walk up to the nearest package.json rather than counting '..' hops, so the
// file survives being moved between test directories.
const REPO_ROOT = (function () {
    let dir = __dirname;
    while (!fs.existsSync(path.join(dir, 'package.json'))) {
        const up = path.dirname(dir);
        if (up === dir) throw new Error('no package.json above ' + __dirname);
        dir = up;
    }
    return dir;
})();
const PLATFORM_ROOT = path.dirname(REPO_ROOT);

const REQUIRE_SIBLINGS = process.env.XCHAIN_REQUIRE_SIBLINGS === '1';
function siblingOrSkip(ctx, absPath, what) {
    if (fs.existsSync(absPath)) return true;
    if (REQUIRE_SIBLINGS) {
        assert.fail('simulator defaults parity gate cannot run: ' + what + ' missing at ' +
            absPath + '; XCHAIN_REQUIRE_SIBLINGS=1 forbids the green-by-skip');
    }
    ctx.skip();
    return false;
}

// Fresh read per call: the coin configs are dependency-free data tables, but a
// cached module from an earlier suite would hide an on-disk edit.
function loadFresh(absPath) {
    const resolved = require.resolve(absPath);
    delete require.cache[resolved];
    return require(resolved);
}

describe('toolkit simulator defaults agree with the chain that charges them', function () {

    it('pins the gas schedule at the golden values', function () {
        assert.deepStrictEqual(
            Object.assign({}, DEFAULT_GAS_SCHEDULE), GOLDEN_GAS,
            'the simulator gas schedule drifted from the frozen values; a re-pricing must move ' +
            'the indexer coin configs and this simulator together, or contract authors are ' +
            'quoted gas the chain does not charge');
    });

    it('pins the resource limits at the golden values', function () {
        assert.deepStrictEqual(Object.assign({}, DEFAULT_LIMITS), GOLDEN_LIMITS);
    });

    it('charges exactly the keys the VM declares canonical', function () {
        // Catches the other direction: a newly-charged VM gas key that never
        // reached the simulator would make every simulate() throw on a missing
        // schedule entry, and a stale key here is dead weight nobody notices.
        assert.deepStrictEqual(
            Object.keys(DEFAULT_GAS_SCHEDULE).slice().sort(),
            CANONICAL_GAS_KEYS.slice().sort(),
            'DEFAULT_GAS_SCHEDULE and src/gas.js CANONICAL_GAS_KEYS disagree on which keys the ' +
            'VM charges');
    });

    it('single-sources the limits that live in VM modules', function () {
        // These four are imported rather than retyped, so this test is a guard on
        // the imports staying imports, not on four more literals.
        assert.strictEqual(DEFAULT_LIMITS.maxCodeSize, MAX_CODE_SIZE);
        assert.strictEqual(DEFAULT_LIMITS.maxCallDepth, VM_MAX_CALL_DEPTH);
        assert.strictEqual(DEFAULT_LIMITS.minCallGas, VM_MIN_CALL_GAS);
        // Not an import (the simulator's wall budget is a plain limit), but the
        // indexer documents its own maxCpuTimeMs as kept equal to this constant,
        // and at/after the flag-day it is the value every node actually runs.
        assert.strictEqual(DEFAULT_LIMITS.maxCpuTimeMs, CONSENSUS_MAX_WALL_MS,
            'the simulator wall budget no longer matches the consensus wall-clock constant');
    });

    for (const coin of COINS) {
        it('sibling xchain-indexer ' + coin + ' coin config charges the same gas', function () {
            const rel  = path.join('xchain-indexer', 'src', 'coins', coin + '.js');
            const file = path.join(PLATFORM_ROOT, rel);
            if (!siblingOrSkip(this, file, rel)) return;

            const cfg = loadFresh(file);
            const schedule = cfg.GAS_SCHEDULE;
            assert.ok(schedule && typeof schedule === 'object',
                rel + ' no longer exports a GAS_SCHEDULE object; re-point this guard');

            // SUBSET equality, deliberately: the indexer legitimately carries fee
            // rows the VM never charges (VM_EXECUTE_BASE, VM_DEPLOY_BASE,
            // VM_DEPLOY_PER_BYTE and the non-VM actions), so a key-set comparison
            // would fail on correct data. What must hold is that every key the
            // simulator quotes is priced identically on chain. VM_GUARD_GAS_CEILING
            // is not a schedule key the simulator charges, so it is not in this
            // loop, but it IS a number the simulator mirrors: compared explicitly
            // below.
            for (const key of Object.keys(DEFAULT_GAS_SCHEDULE)) {
                assert.ok(key in schedule,
                    rel + ': GAS_SCHEDULE is missing ' + key + ', which the simulator quotes to ' +
                    'contract authors');
                assert.strictEqual(schedule[key], DEFAULT_GAS_SCHEDULE[key],
                    rel + ': ' + key + ' = ' + schedule[key] + ' on chain but ' +
                    DEFAULT_GAS_SCHEDULE[key] + ' in the simulator. A re-pricing must move both, ' +
                    'or `xchain-foundry simulate` under-reports and a contract that passed ' +
                    'locally runs out of gas on chain');
            }

            // The guard ceiling: callGuard() runs a controller guard at the
            // simulator's GUARD_GAS_CEILING, a hand-copied second home for this
            // row. The indexer refuses to default it (utility.resolveGuardGasCeiling
            // throws when it is missing), so the coin config is the only authority
            // and this is the only thing comparing the two.
            assert.ok('VM_GUARD_GAS_CEILING' in schedule,
                rel + ': GAS_SCHEDULE no longer carries VM_GUARD_GAS_CEILING, which the toolkit ' +
                'simulator mirrors as GUARD_GAS_CEILING; re-point this guard rather than ' +
                'deleting it');
            assert.strictEqual(schedule.VM_GUARD_GAS_CEILING, GUARD_GAS_CEILING,
                rel + ': VM_GUARD_GAS_CEILING = ' + schedule.VM_GUARD_GAS_CEILING + ' on chain ' +
                'but GUARD_GAS_CEILING = ' + GUARD_GAS_CEILING + ' in the toolkit simulator. ' +
                'callGuard() would simulate a controller guard at the wrong headroom, so a guard ' +
                'that passes `xchain-foundry simulate` can run out of gas on chain; move both, ' +
                'or move neither');
        });
    }

    it('sibling xchain-indexer actions.js enforces the same VM resource limits', function () {
        const rel  = path.join('xchain-indexer', 'src', 'actions.js');
        const file = path.join(PLATFORM_ROOT, rel);
        if (!siblingOrSkip(this, file, rel)) return;

        const onChain = scrapeIndexerLimits(fs.readFileSync(file, 'utf8'), rel);
        for (const key of SCRAPED_LIMIT_KEYS) {
            assert.strictEqual(onChain[key], DEFAULT_LIMITS[key],
                rel + ': ' + key + ' = ' + onChain[key] + ' on chain but ' + DEFAULT_LIMITS[key] +
                ' in the simulator. These are the caps `xchain-foundry simulate` enforces for a ' +
                'contract author, so a one-sided change makes the simulator quote a cap the ' +
                'chain no longer applies; move both, or move neither');
        }
    });

    // ---- the default block HEIGHT and the authority it comes from -------------

    it('derives the default block height from the exported per-coin gate maps', function () {
        const armed = XChainVM.PKG3_SANDBOX_ACTIVATION;
        assert.ok(armed && typeof armed === 'object',
            'the VM stopped exporting PKG3_SANDBOX_ACTIVATION; the simulator default height ' +
            'can no longer be derived from it and has fallen back to a literal');

        for (const coin of COINS) {
            const threshold = armed[coin + ':mainnet'];
            assert.ok(Number.isFinite(threshold),
                'PKG3_SANDBOX_ACTIVATION has no armed ' + coin + ':mainnet height');
            const sim = new ContractSimulator({ coin, network: 'mainnet' });
            assert.ok(sim.block.height >= threshold,
                'a default mainnet simulator for ' + coin + ' sits at height ' + sim.block.height +
                ', below the Pkg-3 sandbox activation ' + threshold + ': it would run the ' +
                'PRE-activation rule set (WebAssembly present, the legacy recursion bound) and ' +
                'pass contracts the live chain rejects');
            // The derived default must clear the height gate by the VM's own predicate,
            // not merely by this test's arithmetic.
            assert.strictEqual(
                XChainVM.isPkg3SandboxActive('mainnet', coin, sim.block.height), true);
        }
    });

    it('keeps genesis-active networks at height 1 and lets an explicit height win', function () {
        // regtest/testnet activate every height gate from genesis, so there is no
        // threshold to reach and the historical default stands.
        assert.strictEqual(new ContractSimulator().block.height, 1);
        assert.strictEqual(new ContractSimulator({ network: 'testnet' }).block.height, 1);
        // A deliberate below-gate run stays possible: the author's height wins.
        assert.strictEqual(
            new ContractSimulator({ network: 'mainnet', block: { height: 5 } }).block.height, 5);
    });

    it('sibling xchain-indexer pkg3 deploy twin carries the same activation heights', function () {
        // The height the simulator now defaults to IS this map, so the map is a
        // cross-repo authority like the coin gas schedules above. The indexer's
        // deploy half must agree with the VM's runtime half or a contract deploys
        // clean on one side and has the sandbox applied under it on the other.
        const rel  = path.join('xchain-indexer', 'src', 'vm_deploy_lint_pkg3_activation.js');
        const file = path.join(PLATFORM_ROOT, rel);
        if (!siblingOrSkip(this, file, rel)) return;

        const twin = loadFresh(file).VM_DEPLOY_LINT_PKG3_ACTIVATION;
        assert.ok(twin && typeof twin === 'object',
            rel + ' no longer exports VM_DEPLOY_LINT_PKG3_ACTIVATION; re-point this guard');

        // SUBSET equality over the coin/network keys, deliberately: the indexer twin
        // additionally carries bare `testnet`/`regtest` genesis keys the VM expresses
        // as a predicate branch, so a key-set comparison would fail on correct data.
        for (const key of Object.keys(XChainVM.PKG3_SANDBOX_ACTIVATION)) {
            assert.strictEqual(twin[key], XChainVM.PKG3_SANDBOX_ACTIVATION[key],
                rel + ': ' + key + ' activates at ' + twin[key] + ' on the indexer deploy half ' +
                'but ' + XChainVM.PKG3_SANDBOX_ACTIVATION[key] + ' in the VM. The two halves are ' +
                'one gate; a divergence forks the deploy verdict from the runtime strip, and it ' +
                'is now also the height a default mainnet simulation runs at');
        }
    });
});
