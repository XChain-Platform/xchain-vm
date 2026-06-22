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
 * Cross-architecture determinism scenarios
 *
 * The #1 catastrophic failure mode for a consensus VM is NOT a sandbox
 * escape. The real threat is NON-DETERMINISM: two honest validators executing the
 * same contract against the same inputs producing different results,
 * which halts or forks the chain.
 *
 * The existing determinism fuzz test runs two VM instances IN THE SAME
 * PROCESS on the SAME machine, so they can never disagree on the things
 * that actually split chains (CPU arch, V8 version, libc/Intl, GC
 * timing). This harness instead computes a portable GOLDEN HASH for a
 * fixed corpus of contracts. The manifest is generated on one machine
 * and VERIFIED on every other machine/arch/Node version. Dev runs ARM;
 * the validator fleet runs x86_64 node:22-bookworm, so checking the
 * same manifest on both CONTINUOUSLY PROVES cross-arch determinism.
 *
 * Each scenario is a PURE function of its declared inputs: a contract,
 * a method, fixed params, a pre-seeded state object, and deterministic
 * oracle/balance/token fixtures. No wall-clock, no randomness.
 *
 * Scenarios are tagged:
 *   - tier: 'invariant'  : MUST be byte-identical on every platform.
 *   - tier: 'resource'   : exercises a resource ceiling (gas/state/emit
 *                          /memory). Gas- and count-bounded ceilings are
 *                          deterministic; memory/wall-clock ceilings are
 *                          NOT guaranteed deterministic and are flagged.
 ********************************************************************/
// @ts-nocheck


const fs = require('fs');
const path = require('path');

const CONTRACTS_DIR = path.join(__dirname, '..', 'contracts');

function load(name) {
    return fs.readFileSync(path.join(CONTRACTS_DIR, name + '.js'), 'utf8');
}

// Deterministic fixtures shared across scenarios.
const BLOCK = { height: 850000, timestamp: 1700000000, hash: 'fixedblockhash000000000000000000' };
// The gateway calls oracleData.getPrice / getPriceAtRound / getSnapshotAge
// as functions (see src/gateway.js). In-process scenarios can pass real
// deterministic functions; the validator wires equivalent DB-backed ones.
const ORACLE = {
    getPrice: (pair) => (pair === 'BTC/USD' ? '65000.00000000' : null),
    getPriceAtRound: (pair, round) => (pair === 'BTC/USD' ? '64000.00000000' : null),
    getSnapshotAge: () => 5
};

/**
 * Scenario list. `state` is the pre-seeded contract state (post-init),
 * so each call is reproducible without ordering dependencies.
 */
const SCENARIOS = [
    {
        id: 'simple_send/send',
        tier: 'invariant',
        code: load('simple_send'),
        method: 'send',
        params: ['DESTADDR000000000000000000000000', '100'],
        state: { owner: 'OWNER000000000000000000000000000', token: 'TEST' }
    },
    {
        id: 'state_counter/increment',
        tier: 'invariant',
        code: load('state_counter'),
        method: 'increment',
        params: [],
        state: { counter: '41', owner: 'OWNER000000000000000000000000000' }
    },
    {
        id: 'state_counter/decrement_at_zero_reverts',
        tier: 'invariant',
        code: load('state_counter'),
        method: 'decrement',
        params: [],
        state: { counter: '0', owner: 'OWNER000000000000000000000000000' }
    },
    {
        id: 'multi_method/increment',
        tier: 'invariant',
        code: load('multi_method'),
        method: 'increment',
        params: [],
        state: { counter: '7', owner: 'OWNER000000000000000000000000000', name: 'test-contract' }
    },
    {
        id: 'amm_swap/addLiquidity',
        tier: 'invariant',
        code: load('amm_swap'),
        method: 'addLiquidity',
        params: ['1000', '2000'],
        state: { tokenA: 'AAA', tokenB: 'BBB', reserveA: '0', reserveB: '0', owner: 'OWNER000000000000000000000000000' }
    },
    {
        id: 'bad_math/native_vs_safe',
        tier: 'invariant',
        // Native 0.1+0.2 is a deterministic IEEE-754 double on any conformant
        // platform; xchain.math.add is deterministic by construction. If this
        // hash ever drifts, a float path leaked into a consensus-visible value.
        code: load('bad_math'),
        method: 'default',
        params: [],
        state: {}
    },
    {
        id: 'sandbox_escape/all_blocked',
        tier: 'invariant',
        code: load('sandbox_escape'),
        method: 'default',
        params: [],
        state: {}
    },
    {
        id: 'compile_bomb/deep_nesting',
        tier: 'invariant',
        code: load('compile_bomb'),
        method: 'default',
        params: [],
        state: {}
    },
    {
        id: 'oracle_read/no_oracle',
        tier: 'invariant',
        code: load('oracle_read'),
        method: 'checkPrice',
        params: [],
        state: {}
        // no oracleData → price null, deterministic 'no oracle' path
    },
    {
        id: 'oracle_read/with_price',
        tier: 'invariant',
        code: load('oracle_read'),
        method: 'checkPrice',
        params: [],
        state: {},
        oracleData: ORACLE
    },
    // ---- resource-ceiling scenarios ----
    {
        id: 'infinite_loop/out_of_gas',
        tier: 'resource',
        // Gas-bounded: __gas(1) per loop iteration hits the 1M ceiling at a
        // FIXED iteration count → gasUsed and error MUST be identical
        // everywhere. If they aren't, gas metering is platform-dependent.
        code: load('infinite_loop'),
        method: 'default',
        params: [],
        state: {}
    },
    {
        id: 'emit_flood/emission_limit',
        tier: 'resource',
        // Count-bounded at the 51st emit → deterministic.
        code: load('emit_flood'),
        method: 'default',
        params: [],
        state: {}
    },
    {
        id: 'state_flood/key_limit',
        tier: 'resource',
        // Count-bounded at the 10001st key → deterministic.
        code: load('state_flood'),
        method: 'default',
        params: [],
        state: {}
    },
    {
        id: 'memory_bomb/memory_limit',
        tier: 'resource',
        // HAZARD: memory ceiling fires at a GC-timing-dependent point. gasUsed
        // at the moment of OOM may differ across V8 versions / arch. Tracked
        // here precisely to MEASURE whether the outcome is determinism-safe.
        hazard: 'memory-ceiling-nondeterminism',
        code: load('memory_bomb'),
        method: 'default',
        params: [],
        state: {}
    },
    // ---- G4 syntax-level allocation-metering scenarios (item #5013) ----
    // These pin the exact gasUsed for the __concat / __arrspread / __objspread
    // helpers and the __GROW_THRESHOLD = 256 constant. A change to the threshold,
    // the "grew beyond largest operand" formula, or the metering-rewrite pass
    // (metering.js) will alter gasUsed and redden this guard.
    {
        id: 'g4_alloc_metering/string_concat',
        tier: 'invariant',
        // A 300-char base string; base + base grows by 300 chars (> __GROW_THRESHOLD
        // of 256), so __concat charges 300 gas units. Result length 600 is stored
        // in state so the hash covers both gasUsed and the state write.
        code: load('g4_alloc_metering'),
        method: 'string_concat',
        params: ['x'.repeat(300)],
        state: {}
    },
    {
        id: 'g4_alloc_metering/arr_spread',
        tier: 'invariant',
        // Spreads a 300-element array plus [1,2,3]; total spread count = 303 >
        // __GROW_THRESHOLD, so __arrspread charges 303 gas units. The result
        // length (303) is written to state.
        code: load('g4_alloc_metering'),
        method: 'arr_spread',
        params: ['300'],
        state: {}
    },
    {
        id: 'g4_alloc_metering/obj_spread',
        tier: 'invariant',
        // Merges a 300-key object with {z:1}; total keys spread = 301 >
        // __GROW_THRESHOLD, so __objspread charges 301 gas units. Key count
        // written to state so the hash covers both paths.
        code: load('g4_alloc_metering'),
        method: 'obj_spread',
        params: ['300'],
        state: {}
    }
];

module.exports = { SCENARIOS, BLOCK, ORACLE };
