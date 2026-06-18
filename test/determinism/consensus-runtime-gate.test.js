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
 * Cross-Node/V8 consensus-runtime gate.
 *
 * Asserts the engine THIS process runs on matches the pinned consensus
 * runtime (src/consensus-runtime.js). Running in `ci` on every Node/V8 a
 * validator may use, this fails LOUDLY on any validator built against a
 * different V8/ICU. The deployment-side mitigation for the not-in-VM-
 * fixable native-error-text / ICU-primitive residual. A pinned engine is
 * the only thing that makes those contract-observable-but-unspeccable bytes
 * deterministic fleet-wide.
 *
 * The gate must have TEETH, not be a tautology, so this file also proves
 * the checker REJECTS a mismatched engine and ACCEPTS the exact pin.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const {
    PINNED, REFERENCE_NODE, checkConsensusRuntime, describeMismatch
} = require('../../src/consensus-runtime.js');

describe('consensus-runtime gate', function () {

    it('THIS engine matches the pinned consensus runtime (else this validator would FORK)', function () {
        const result = checkConsensusRuntime();
        assert.ok(result.ok, describeMismatch(result) +
            `\n(reference release: ${REFERENCE_NODE}; running: ${process.version})`);
    });

    it('the checker REJECTS a mismatched engine (gate has teeth)', function () {
        // Flip one pinned field (a validator on an older V8 whose native
        // error wording differs). Must be caught.
        const bad = { ...process.versions, v8: '11.0.000.0-node.0' };
        const result = checkConsensusRuntime(bad);
        assert.strictEqual(result.ok, false, 'a wrong V8 must not pass the gate');
        assert.ok(result.mismatches.some(m => m.key === 'v8'),
            'the v8 mismatch must be reported');
        assert.ok(/FORK/.test(describeMismatch(result)),
            'the operator message must name the fork risk');
    });

    it('the checker REJECTS a mismatched ICU/Unicode/CLDR (locale-primitive surface)', function () {
        for (const key of ['icu', 'unicode', 'cldr']) {
            const bad = { ...process.versions, [key]: '0.0' };
            const result = checkConsensusRuntime(bad);
            assert.strictEqual(result.ok, false, `a wrong ${key} must not pass the gate`);
            assert.ok(result.mismatches.some(m => m.key === key),
                `the ${key} mismatch must be reported`);
        }
    });

    it('the checker ACCEPTS the exact pin (no false negative)', function () {
        const result = checkConsensusRuntime({ ...PINNED });
        assert.ok(result.ok, 'the exact pinned runtime must pass');
        assert.strictEqual(result.mismatches.length, 0);
    });

    it('a Node patch carrying the same engine versions is consensus-equivalent (not over-strict)', function () {
        // Only engine versions are pinned, never the Node release string, so
        // a different patch with identical v8/icu/unicode/cldr/modules passes.
        const sameEngineDifferentNode = { ...process.versions, ...PINNED, node: '22.99.99' };
        assert.ok(checkConsensusRuntime(sameEngineDifferentNode).ok,
            'pinning must key on engine versions, not the Node release string');
    });
});
