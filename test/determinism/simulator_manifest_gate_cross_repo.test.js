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
 * Parity gate for the simulator's third DEPLOY leg against the indexer that
 * owns the rule. The toolkit carries second copies of three consensus facts:
 * the CONTRACT_MANIFEST verdict strings, the policy-row strings, and the
 * CONTRACT_META_REQUIRED flag times. Each is compared here against the
 * sibling xchain-indexer, so a change on that side reddens this repo instead
 * of leaving the simulator quoting a status the chain no longer writes.
 *
 * Sibling reads skip when the sibling is absent, except where
 * XCHAIN_REQUIRE_SIBLINGS=1 is exported (bin/ci-all.sh), where a missing
 * sibling is a hard failure rather than a green-by-skip.
 ********************************************************************/

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const { META_VERDICTS } = require('../../src/toolkit/gate/meta_validation.js');

// constants.js loads the VM, so the flag-time and policy checks skip with it.
let simConstants = null;
let manifestGate = null;
try {
    simConstants = require('../../src/toolkit/simulator/constants.js');
    manifestGate = require('../../src/toolkit/simulator/manifest_gate.js');
} catch (e) {
    console.log('Skipping simulator manifest-gate parity (isolated-vm unavailable):', e.message);
}

const PLATFORM_ROOT = path.resolve(__dirname, '..', '..', '..');
const REQUIRE_SIBLINGS = process.env.XCHAIN_REQUIRE_SIBLINGS === '1';

// Resolves a sibling path, skipping (or failing under XCHAIN_REQUIRE_SIBLINGS) when absent.
function siblingOrSkip(ctx, rel) {
    const abs = path.join(PLATFORM_ROOT, rel);
    if (fs.existsSync(abs)) return abs;
    if (REQUIRE_SIBLINGS) {
        assert.fail('manifest-gate parity cannot run: ' + rel + ' missing at ' + abs +
            '; XCHAIN_REQUIRE_SIBLINGS=1 forbids the green-by-skip');
    }
    ctx.skip();
    return null;
}

describe('simulator deploy-gate manifest leg agrees with the indexer', function () {

    it('carries the indexer contract_meta VERDICTS byte for byte', function () {
        const file = siblingOrSkip(this, path.join('xchain-indexer', 'src', 'actions', 'deploy', 'contract_meta.js'));
        if (!file) return;
        const { VERDICTS } = require(file);
        assert.deepStrictEqual(Object.assign({}, META_VERDICTS), Object.assign({}, VERDICTS),
            'toolkit META_VERDICTS drifted from the consensus strings the indexer writes');
    });

    it('carries every manifest policy string the indexer writes', function () {
        if (!manifestGate) this.skip();
        const file = siblingOrSkip(this, path.join('xchain-indexer', 'src', 'actions', 'deploy', 'manifest.js'));
        if (!file) return;
        const src = fs.readFileSync(file, 'utf8');
        const written = src.match(/'invalid: CONTRACT_MANIFEST \([^']*\)'/g) || [];
        assert.ok(written.length > 0, 'no CONTRACT_MANIFEST literal found in ' + file + '; re-point this scrape');
        const ours = Object.values(manifestGate.MANIFEST_POLICY_VERDICTS).map((s) => "'" + s + "'");
        assert.deepStrictEqual(ours.slice().sort(), written.slice().sort(),
            'the policy strings in manifest.js and MANIFEST_POLICY_VERDICTS differ');
    });

    it('arms CONTRACT_META_REQUIRED at the indexer flag times', function () {
        if (!simConstants) this.skip();
        const flagFile = siblingOrSkip(this, path.join('xchain-indexer', 'src', 'protocol_changes', 'flag_times.js'));
        if (!flagFile) return;
        const rowFile = siblingOrSkip(this, path.join('xchain-indexer', 'src', 'protocol_changes', 'changes_4.js'));
        if (!rowFile) return;
        const flags = require(flagFile);
        const row = fs.readFileSync(rowFile, 'utf8').match(
            /\['CONTRACT_META_REQUIRED',\s*'[^']*',\s*CONTRACT_META_REQUIRED_MAINNET_TIME,\s*CONTRACT_META_REQUIRED_TESTNET_TIME,\s*(\d+)/);
        assert.ok(row, 'CONTRACT_META_REQUIRED row not found in ' + rowFile + '; re-point this scrape');
        assert.deepStrictEqual(Object.assign({}, simConstants.CONTRACT_META_REQUIRED_TIMES), {
            mainnet: flags.CONTRACT_META_REQUIRED_MAINNET_TIME,
            testnet: flags.CONTRACT_META_REQUIRED_TESTNET_TIME,
            regtest: Number(row[1])
        }, 'the simulator arms the meta rule at a different instant than the chain');
    });
});
