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
 * SCOPE, stated so nobody reads this guard as broader than it is: the resource
 * LIMITS are covered by the golden layer and by the VM-side single-sourcing
 * only. The production VM's limits live as inline literals inside the
 * `limits: { ... }` object in xchain-indexer/src/actions.js, which is not a
 * requireable data table, and a regex scrape of it would need re-pointing every
 * time that block moves. maxCpuTimeMs is cross-checked against the VM's own
 * CONSENSUS_MAX_WALL_MS, which the indexer documents itself as keeping equal;
 * the rest of that indexer-side block is NOT guarded here.
 ********************************************************************/

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const { DEFAULT_GAS_SCHEDULE, DEFAULT_LIMITS } = require('../../src/toolkit/simulator.js');
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
            // VM_DEPLOY_PER_BYTE, VM_GUARD_GAS_CEILING and the non-VM actions), so
            // a key-set comparison would fail on correct data. What must hold is
            // that every key the simulator quotes is priced identically on chain.
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
        });
    }
});
