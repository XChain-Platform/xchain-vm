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
 * The third leg of the chain's DEPLOY gate, judged over a vm.readManifest()
 * result: the permissions / maxTakeBps policy rows and the
 * CONTRACT_META_REQUIRED verdict ladder, in the order the indexer walks them
 * (xchain-indexer/src/actions/deploy/manifest.js and contract_meta.js). The
 * verdict strings are consensus tokens the chain writes into the action's
 * status, so each one here is the indexer's byte for byte;
 * test/determinism/simulator_manifest_gate_cross_repo.test.js compares them.
 ********************************************************************/
// @ts-nocheck

const {
    META_VERDICTS,
    META_NAME_MAX_BYTES,
    META_DESCRIPTION_MAX_BYTES,
    META_VERSION_MAX_BYTES,
    isValidMetaText
} = require('../gate/meta_validation.js');
const { CONTRACT_META_REQUIRED_TIMES } = require('./constants.js');

// Policy-row rejections, written verbatim into the DEPLOY status by applyManifestPolicy.
const MANIFEST_POLICY_VERDICTS = Object.freeze({
    PERMISSIONS_ARRAY:   'invalid: CONTRACT_MANIFEST (permissions must be an array)',
    PERMISSIONS_STRINGS: 'invalid: CONTRACT_MANIFEST (permissions must be action-type strings)',
    MAX_TAKE_BPS:        'invalid: CONTRACT_MANIFEST (maxTakeBps must be an integer in [0, 10000])'
});

/**
 * Whether CONTRACT_META_REQUIRED is armed at this block time. The indexer reads
 * median-time-past off mainnet; the simulator has only the block's own stamp.
 * @param {string} network
 * @param {number} blockTime - seconds
 * @returns {boolean}
 */
function isContractMetaRequiredActive(network, blockTime) {
    const known = Object.prototype.hasOwnProperty.call(CONTRACT_META_REQUIRED_TIMES, network);
    const at = CONTRACT_META_REQUIRED_TIMES[known ? network : 'mainnet'];
    return Number(blockTime) >= at;
}

/**
 * The permissions and maxTakeBps rows. Ungated on chain, and judged only over a
 * read that succeeded, exactly as applyManifestPolicy is.
 * @param {?object} read - vm.readManifest() result
 * @returns {?string} the chain's status string, or null when both rows pass
 */
function manifestPolicyError(read) {
    if (!read || !read.success || !read.manifest) return null;
    const m = read.manifest;
    if (m.permissionsType !== 'undefined') {
        if (m.permissionsType !== 'array' || !Array.isArray(m.permissions))
            return MANIFEST_POLICY_VERDICTS.PERMISSIONS_ARRAY;
        if (!m.permissions.every((p) => typeof p === 'string'))
            return MANIFEST_POLICY_VERDICTS.PERMISSIONS_STRINGS;
    }
    if (m.maxTakeBpsType !== 'undefined') {
        const mtb = m.maxTakeBps;
        if (m.maxTakeBpsType !== 'number' || !Number.isInteger(mtb) || mtb < 0 || mtb > 10000)
            return MANIFEST_POLICY_VERDICTS.MAX_TAKE_BPS;
    }
    return null;
}

/**
 * Rows 1 to 4 of the meta ladder, then the host's own parse of the reported
 * JSON; first failure wins, as in evaluateContractMeta.
 * @param {?object} read - vm.readManifest() result
 * @returns {?string} the chain's status string, or null for a conforming meta
 */
function contractMetaError(read) {
    if (!read || read.success !== true || !read.manifest) return META_VERDICTS.READ_FAILED;
    const m = read.manifest;
    const metaType = (m.metaType === undefined || m.metaType === null) ? 'undefined' : m.metaType;
    if (metaType === 'undefined') return META_VERDICTS.REQUIRED;
    if (metaType !== 'object' || m.metaError === true) return META_VERDICTS.NOT_OBJECT;
    if (m.metaOversize === true) return META_VERDICTS.OVERSIZE;
    let parsed = null;
    if (typeof m.metaJson === 'string') {
        try { parsed = JSON.parse(m.metaJson); } catch (e) { parsed = null; }
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
        return META_VERDICTS.NOT_OBJECT;
    return metaFieldsError(parsed);
}

// Rows 5 to 7: name, description, then version when the key is present at all.
function metaFieldsError(parsed) {
    if (!isValidMetaText(parsed.name, META_NAME_MAX_BYTES, false)) return META_VERDICTS.NAME;
    if (!isValidMetaText(parsed.description, META_DESCRIPTION_MAX_BYTES, true))
        return META_VERDICTS.DESCRIPTION;
    if (Object.prototype.hasOwnProperty.call(parsed, 'version') &&
        !isValidMetaText(parsed.version, META_VERSION_MAX_BYTES, false))
        return META_VERDICTS.VERSION;
    return null;
}

module.exports = {
    MANIFEST_POLICY_VERDICTS,
    isContractMetaRequiredActive,
    manifestPolicyError,
    contractMetaError
};
