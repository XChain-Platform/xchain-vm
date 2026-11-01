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
 * owns the rule. The toolkit carries second copies of five consensus facts:
 * the CONTRACT_MANIFEST verdict strings, the policy-row strings, the
 * CONTRACT_META_REQUIRED flag times, the DEPLOY_INIT_STRICT instants that
 * decide when a DEPLOY runs its constructor, and the meta text grammar with
 * its byte caps. Each is compared here against the
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

const { siblingCheckout, skipOrFail } = require('../helpers/sibling_checkout.js');
const {
    META_VERDICTS, META_NAME_MAX_BYTES, META_DESCRIPTION_MAX_BYTES, META_VERSION_MAX_BYTES, isValidMetaText
} = require('../../src/toolkit/gate/meta_validation.js');

// Build every meta text case the grammar can disagree on: code points by position, caps, non-strings.
function metaTextCases() {
    const cases = [];
    const caps = [META_NAME_MAX_BYTES, META_DESCRIPTION_MAX_BYTES, META_VERSION_MAX_BYTES];
    const positioned = (ch) => [ch, 'a' + ch + 'a', ch + 'a', 'a' + ch];
    const points = [];
    for (let cp = 0; cp <= 0xFFFF; cp++) if (cp < 0xD800 || cp > 0xDFFF) points.push(cp);
    points.push(0x10000, 0x1F600, 0xE0001, 0x10FFFF);
    for (const cp of points) {
        for (const s of positioned(String.fromCodePoint(cp))) cases.push([s, META_NAME_MAX_BYTES, 'U+' + cp.toString(16)]);
    }
    for (const s of ['\uD800', '\uDFFF', 'a\uD800b', '\uDC00\uD800', '']) cases.push([s, META_NAME_MAX_BYTES, 'surrogate/empty']);
    for (const cap of caps) {
        for (const ch of ['a', 'é', '€', '\u{1F600}']) {
            const width = Buffer.byteLength(ch, 'utf8');
            for (const target of [cap - 1, cap, cap + 1]) {
                const n = Math.floor(target / width);
                cases.push([ch.repeat(n) + 'a'.repeat(target - n * width), cap, 'cap ' + cap + ' at ' + target + ' bytes']);
            }
        }
    }
    for (const v of [undefined, null, 0, 1, {}, [], true]) cases.push([v, META_NAME_MAX_BYTES, 'non-string']);
    return cases;
}

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
// Resolves a sibling path, skipping (or failing under XCHAIN_REQUIRE_SIBLINGS) when absent or lane-symlinked.
function siblingOrSkip(ctx, rel) {
    const verdict = siblingCheckout(__dirname, path.join(PLATFORM_ROOT, rel));
    return skipOrFail(ctx, verdict, 'manifest-gate parity (' + rel + ')') ? verdict.path : null;
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

    it('arms DEPLOY_INIT_STRICT at the indexer registry instants', function () {
        if (!simConstants) this.skip();
        const rowFile = siblingOrSkip(this, path.join('xchain-indexer', 'src', 'protocol_changes', 'changes_3.js'));
        if (!rowFile) return;
        const row = fs.readFileSync(rowFile, 'utf8').match(
            /\['DEPLOY_INIT_STRICT',\s*'[^']*',\s*(\d+),\s*(\d+),\s*(\d+)/);
        assert.ok(row, 'DEPLOY_INIT_STRICT row not found in ' + rowFile + '; re-point this scrape');
        assert.deepStrictEqual(Object.assign({}, simConstants.DEPLOY_INIT_STRICT_TIMES), {
            mainnet: Number(row[1]),
            testnet: Number(row[2]),
            regtest: Number(row[3])
        }, 'the simulator runs the constructor under a different trigger instant than the chain');
    });
});

describe('simulator meta text grammar agrees with the indexer', function () {

    it('carries the indexer meta byte caps', function () {
        const file = siblingOrSkip(this, path.join('xchain-indexer', 'src', 'actions', 'deploy', 'contract_meta.js'));
        if (!file) return;
        const chain = require(file);
        assert.deepStrictEqual(
            [META_NAME_MAX_BYTES, META_DESCRIPTION_MAX_BYTES, META_VERSION_MAX_BYTES],
            [chain.META_NAME_MAX_BYTES, chain.META_DESCRIPTION_MAX_BYTES, chain.META_VERSION_MAX_BYTES],
            'toolkit meta byte caps drifted from the caps the indexer enforces');
    });

    it('applies the indexer meta text grammar code point for code point', function () {
        const file = siblingOrSkip(this, path.join('xchain-indexer', 'src', 'actions', 'deploy', 'contract_meta.js'));
        if (!file) return;
        const chain = require(file).isValidMetaText;
        assert.strictEqual(typeof chain, 'function', 'contract_meta.js no longer exports isValidMetaText');
        const cases = metaTextCases();
        const drift = [];
        for (const [s, cap, label] of cases) {
            for (const allowLf of [false, true]) {
                const ours = isValidMetaText(s, cap, allowLf);
                const theirs = chain(s, cap, allowLf);
                if (ours !== theirs) drift.push(label + ' ' + JSON.stringify(s).slice(0, 24) + ' lf=' + allowLf +
                    ' toolkit=' + ours + ' chain=' + theirs);
            }
        }
        assert.ok(cases.length > 250000, 'case table shrank to ' + cases.length);
        assert.deepStrictEqual(drift.slice(0, 20), [],
            drift.length + ' meta text verdicts differ from the chain grammar');
    });
});
