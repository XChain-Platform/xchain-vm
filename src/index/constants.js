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
 * from ./protocol/constants.js and gateway_emit.js, never re-declared as
 * literals; a part of the entry so the bounds read as one table.
 ********************************************************************/
// @ts-nocheck

// Maximum smart-contract code size (64 KiB). Vendored single source of truth:
// ./protocol/constants.js (byte-identical to xchain-documentation/protocol/
// constants.js, MAX_CODE_SIZE); kept equal to the SDK and indexer by the
// cross-service regression suite (exported at the bottom of this module).
const PROTO = require('../protocol/constants.js');
const MAX_CODE_SIZE = PROTO.MAX_CODE_SIZE;

// Cross-contract call protocol constants. Vendored from ./protocol/constants.js
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

// Musl-safe recursion bound. On a musl/Alpine 128KB pthread stack the
// native JSON.parse reviver walk and Array.prototype.join recurse in C++ to the
// value's nesting depth and overflow BELOW 512 (measured near ~292 reviver / ~379
// join), so a musl-built validator could fork from a glibc/macOS one on a value
// nested between the musl overflow onset and 512. The Package 3 bundle gate below
// (isPkg3SandboxActive) swaps the injected __DEPTH_LIMIT from MAX_STACK_DEPTH to
// this lower bound at/after the coordinated deploy window; 256 sits below the
// tightest musl onset with margin while leaving ample headroom for any plausible
// contract nesting. Both the intra-contract recursion guard and the F-NR native-
// depth guard read the single injected __DEPTH_LIMIT, so lowering it moves both.
const MAX_STACK_DEPTH_MUSL = 256;

// Cross-CHAIN call (XCALL) protocol constants. Canonical values:
// xchain-documentation/protocol/constants.js; the indexer re-validates
// host-side (execute/index.js processEmission + actions/xcall/index.js).
const XCALL_MIN_GAS             = PROTO.XCALL_MIN_GAS;     // = MIN_CALL_GAS
const XCALL_MAX_GAS             = PROTO.XCALL_MAX_GAS;     // target-side ceiling cap (the run is fee-less on the target chain)
// Single in-VM source of truth: gateway_emit.js declares the hop cap it
// ENFORCES (emit.crossExecute's hop gate) and this module re-exports it, so a
// future bump cannot leave the enforcer and the exported/parity-tested value
// disagreeing. (gateway_emit.js has no require-cycle back into this file.)
const XCALL_MAX_HOPS            = require('../gateway_emit.js').XCALL_MAX_HOPS;  // user→remote = 1, remote→back = 2
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
