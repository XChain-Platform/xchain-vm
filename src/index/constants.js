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
 * XChain VM: size and protocol constants
 *
 * The code-size, call, recursion and cross-chain (XCALL) bounds the VM
 * enforces and re-exports for the cross-service parity suites. Vendored
 * from ../protocol/constants.js and ../gateway-emit.js, never re-declared as
 * literals; a part of the entry so the bounds read as one table.
 ********************************************************************/
// @ts-nocheck

// Maximum smart-contract code size (64 KiB), read from the vendored ../protocol/constants.js.
// test/determinism/xcall-constants-cross-repo.test.js checks its value against the
// SDK, indexer and documentation copies (exported at the bottom of this module).
const PROTO = require('../protocol/constants.js');
const MAX_CODE_SIZE = PROTO.MAX_CODE_SIZE;

// Cross-contract call protocol constants. Vendored from ../protocol/constants.js
// (VM_MAX_CALL_DEPTH / VM_MIN_CALL_GAS); the indexer re-validates both host-side
// (xchain-indexer/src/actions/execute/index.js) so an older bundled VM cannot
// bypass them. Exported below for the cross-service regression suite.
const MAX_CALL_DEPTH = PROTO.VM_MAX_CALL_DEPTH;
const MIN_CALL_GAS   = PROTO.VM_MIN_CALL_GAS;

// Deterministic intra-contract recursion bound. DISTINCT from MAX_CALL_DEPTH
// (which bounds cross-contract emit.execute chains): this caps how deep a single
// contract may recurse WITHIN one isolate before the metering-injected depth guard
// throws a deterministic out_of_stack fault. The value is a fixed, conservative
// constant chosen well below the smallest native V8 stack limit across every
// supported architecture (linux/arm64 + linux/amd64) and across the host stack
// remaining at runSync entry, so the guard always fires before V8's own
// architecture-dependent RangeError. That makes the maximum recursion depth a
// contract can observe identical on every validator. A contract that catches the
// fault can no longer commit a platform-variable depth into hashed state. Purely an
// in-isolate execution bound (the host never re-validates it), so it lives here
// rather than in the cross-service protocol constants; all validators agree on it
// via the pinned consensus runtime version.
const MAX_STACK_DEPTH = 512;

// Musl-safe recursion bound. A musl/Alpine validator runs contracts on a 128KB
// pthread stack, so the native-recursive sinks (JSON.stringify, Array.prototype.join
// and flat, the JSON.parse reviver walk) overflow at a shallower nesting depth than
// on glibc or macOS, and a value nested past that onset could fork a musl validator
// from the rest of the fleet.
//
// What is measured: drills on real aarch64 musl put the guard-off native onset near
// 2000 for join, 4000 for JSON.stringify and 6000 for flat, with every depth up to
// 512 clean under the guard, so for those three sinks 256 is a conservative margin.
// What is not: the reviver walk has never been run on musl, and neither has x86-64
// musl. Node 22 probes on reduced thread stacks (not musl) put the reviver onset near
// 200 at 100KB and near 290 at 128KB, and isolated-vm leaves a musl pool thread about
// 104KB usable, so whether 256 clears it on musl is unmeasured. The ~290 figure in
// runtime/harness_part_2.js is that probe, not a musl run; it stays byte-identical
// because the harness text is compiled ahead of contract code. Do not raise this
// bound without a real-musl reviver-walk drill.
//
// The Package 3 bundle gate (isPkg3SandboxActive, runtime/activation_heights.js)
// swaps the injected __DEPTH_LIMIT from MAX_STACK_DEPTH to this bound at/after the
// coordinated deploy window; __DEPTH_LIMIT is what the intra-contract recursion
// guard reads. The F-NR native-depth guard reads __NR_DEPTH_LIMIT instead, which
// runtime/isolate_globals.js sets to Math.min(__DEPTH_LIMIT, MAX_STACK_DEPTH_MUSL),
// so it stays at or below this bound even when its block-time gate arms before a
// coin reaches its height. Do not collapse __NR_DEPTH_LIMIT back to __DEPTH_LIMIT.
const MAX_STACK_DEPTH_MUSL = 256;

// Cross-CHAIN call (XCALL) protocol constants. Canonical values:
// xchain-documentation/protocol/constants.js; the indexer re-validates
// host-side (execute/index.js processEmission + actions/xcall/index.js).
const XCALL_MIN_GAS             = PROTO.XCALL_MIN_GAS;     // = MIN_CALL_GAS
const XCALL_MAX_GAS             = PROTO.XCALL_MAX_GAS;     // target-side ceiling cap (the run is fee-less on the target chain)
// Single in-VM source of truth: gateway-emit.js declares the hop cap it
// ENFORCES (emit.crossExecute's hop gate) and this module re-exports it, so a
// future bump cannot leave the enforcer and the exported/parity-tested value
// disagreeing. (gateway-emit.js has no require-cycle back into this file.)
const XCALL_MAX_HOPS            = require('../gateway-emit.js').XCALL_MAX_HOPS;  // user→remote = 1, remote→back = 2
const XCALL_MIN_DEADLINE_BLOCKS = PROTO.XCALL_MIN_DEADLINE_BLOCKS;
const XCALL_MAX_DEADLINE_BLOCKS = PROTO.XCALL_MAX_DEADLINE_BLOCKS;
const XCALL_MAX_RETURN_BYTES    = PROTO.XCALL_MAX_RETURN_BYTES;

module.exports = {
    MAX_CODE_SIZE,
    MAX_CALL_DEPTH,
    MIN_CALL_GAS,
    MAX_STACK_DEPTH,
    MAX_STACK_DEPTH_MUSL,
    XCALL_MIN_GAS,
    XCALL_MAX_GAS,
    XCALL_MAX_HOPS,
    XCALL_MIN_DEADLINE_BLOCKS,
    XCALL_MAX_DEADLINE_BLOCKS,
    XCALL_MAX_RETURN_BYTES,
};
