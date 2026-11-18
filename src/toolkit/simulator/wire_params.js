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
 ********************************************************************/
// @ts-nocheck

/**
 * The arguments a contract receives from a user-submitted EXECUTE or a DEPLOY
 * constructor. The chain carries them as one '|'-joined string and the VM gets
 * that string split back, so every argument is a string, a '|' inside an element
 * becomes two arguments, and an empty join means zero arguments rather than one
 * empty one. null and undefined elements join as the empty string.
 *
 * @param {Array|string|null|undefined} given
 * @returns {string[]}
 */
function wireParams(given) {
    if (given === undefined || given === null) return [];
    const joined = Array.isArray(given) ? given.join('|') : String(given);
    return joined === '' ? [] : joined.split('|');
}

// Mirrors CALLBACK_ARGS_EXACT, the indexer rule that a framework-injected callback (an ATTEST
// response or expiry, an XCALL result, a binding VOTE) runs with the argument array its
// injector built instead of a '|' join split again. No VM twin exists, so
// test/determinism/simulator_wire_params_cross_repo.test.js pins these against the
// protocol_changes/changes_5.js row. Unarmed on mainnet, armed on testnet, genesis on regtest;
// an unnamed network resolves like mainnet.
const CALLBACK_ARGS_EXACT_TIMES = Object.freeze({
    mainnet: 9999999999,
    testnet: 1792303200,
    regtest: 0
});

/**
 * Whether CALLBACK_ARGS_EXACT is armed at this block time.
 * @param {string} network
 * @param {number} blockTime - seconds
 * @returns {boolean}
 */
function isCallbackArgsExactActive(network, blockTime) {
    const known = Object.prototype.hasOwnProperty.call(CALLBACK_ARGS_EXACT_TIMES, network);
    return Number(blockTime) >= CALLBACK_ARGS_EXACT_TIMES[known ? network : 'mainnet'];
}

/**
 * The arguments a contract receives for a method the framework calls back. Past
 * CALLBACK_ARGS_EXACT the injector's array arrives as is, each element converted the way
 * join() converts it (null and undefined become the empty string), so a '|' inside one
 * stays inside its own argument. Below the flag the callback runs on the wire form.
 *
 * @param {Array|string|null|undefined} given
 * @param {string} network
 * @param {number} blockTime - seconds
 * @returns {string[]}
 */
function callbackParams(given, network, blockTime) {
    if (!isCallbackArgsExactActive(network, blockTime)) return wireParams(given);
    if (!Array.isArray(given)) return wireParams(given);
    return given.map((v) => (v === null || v === undefined) ? '' : String(v));
}

/**
 * Whether the arguments a contract receives differ from what the caller passed.
 * @param {*} given
 * @param {string[]} delivered
 * @returns {boolean}
 */
function paramsReshaped(given, delivered) {
    if (!Array.isArray(given)) return given !== undefined && given !== null;
    return given.length !== delivered.length || given.some((v, i) => v !== delivered[i]);
}

module.exports = {
    wireParams,
    callbackParams,
    isCallbackArgsExactActive,
    paramsReshaped,
    CALLBACK_ARGS_EXACT_TIMES
};
