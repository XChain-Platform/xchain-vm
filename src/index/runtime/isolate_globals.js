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
 * XChain VM: isolate globals
 *
 * The per-execution globals injected ahead of the harness.
 ********************************************************************/
// @ts-nocheck

const { MAX_STACK_DEPTH_MUSL } = require('../constants.js');
const { BINARY_ALLOC_GATE_BLOCK_TIME, jsonStringifyHookGateTime, isIterSetMeterActive } = require('./activations.js');
const { isApplyLengthMeterActive } = require('../apply_length_meter.js');

function injectExecutionGlobals(context, opts, pkg3SandboxOn, limits) {
        // Inject the deterministic recursion bound. The harness captures this
        // into a closure and enforces it on the metering-injected depth hooks,
        // so a contract that catches a stack fault cannot observe a
        // platform-dependent native depth (see MAX_STACK_DEPTH). Package 3:
        // at/after the per-coin ~961000 height window (isPkg3SandboxActive) the
        // bound drops to MAX_STACK_DEPTH_MUSL, so a musl validator's native
        // reviver/join walk cannot overflow below the bound; below the window the
        // injected value is limits.maxStackDepth (the 512 default),
        // byte-identical to today. The one injected __DEPTH_LIMIT is read by BOTH
        // the intra-contract recursion guard and the F-NR native-depth guard, so
        // gating it here moves both consistently. The coin is derived from the
        // C:<COIN>:<idx> contract address so LTC/DOGE mainnet (tips already past a
        // bare BTC 961000) stay pre-activation until their own calendar height.
        const __effectiveDepthLimit = pkg3SandboxOn
            ? MAX_STACK_DEPTH_MUSL
            : limits.maxStackDepth;
        context.global.setSync('__DEPTH_LIMIT', __effectiveDepthLimit);
        // Clamp the F-NR native sinks to the musl-safe bound whatever the height
        // gate says. The native guard's ON/OFF rides the block-TIME binary-alloc
        // gate while __DEPTH_LIMIT rides the per-coin block-HEIGHT gate, so a coin
        // that has not yet reached its PKG3_SANDBOX_ACTIVATION height when the
        // block-time gate arms would otherwise run the guard at 512, above the
        // measured musl native onset (~292 reviver / ~379 join) and back inside the
        // heterogeneous-OS fork the guard exists to close. Nothing enforces that
        // ordering in code, and a chain running behind its projected height is the
        // ordinary way it breaks. This is a no-op wherever the height gate is
        // already active (min(256, 256)), and no history exists with the native
        // guard on, so replay is unaffected. The intra-contract __depth_enter guard
        // keeps reading the unclamped __DEPTH_LIMIT: it is ungated by time and
        // already tracks the height gate correctly.
        context.global.setSync('__NR_DEPTH_LIMIT',
            Math.min(__effectiveDepthLimit, MAX_STACK_DEPTH_MUSL));
        // Package 3 bundle activation flag for the in-isolate harness (Set/Map
        // collection-constructor metering). Captured into the harness closure
        // before the __-prefixed globals are stripped; false below the gate so the
        // collection ctors stay unmetered exactly as pre-activation nodes leave them.
        context.global.setSync('__PKG3_SANDBOX_ON', pkg3SandboxOn);

        // Inject this execution's block time + the binary-alloc metering
        // flag-day so the harness can gate the F3-binary byte-length charge on
        // the coordinated activation (see BINARY_ALLOC_GATE_BLOCK_TIME). The
        // block time is the same value the indexer threads through as
        // blockContext.timestamp. Coerce to a finite number; a missing/garbage
        // timestamp resolves to 0 → below the flag day → constructors left
        // unmetered (pre-activation behavior), so an un-timestamped caller can
        // never accidentally enable the new charge. Both names are stripped by
        // the harness cleanup pass, so contract code never sees them.
        const __blockTime = opts.blockContext && Number(opts.blockContext.timestamp);
        context.global.setSync('__blockTime', Number.isFinite(__blockTime) ? __blockTime : 0);
        context.global.setSync('__BINARY_ALLOC_GATE_BLOCK_TIME', BINARY_ALLOC_GATE_BLOCK_TIME);
        // Gate JSON.stringify value-hook resolution after the binary allocation gate.
        // The stripped resolver yields 0 on regtest, 1791061097 (2026-10-03 20:58:17 UTC)
        // on testnet, and the unarmed mainnet literal elsewhere, hidden from contracts.
        context.global.setSync('__JSON_STRINGIFY_HOOK_GATE_BLOCK_TIME', jsonStringifyHookGateTime(opts.network));
        const __iterSetMeterOn = isIterSetMeterActive(opts.network, __blockTime);
        context.global.setSync('__ITER_SET_METER_ON', __iterSetMeterOn);
        context.global.setSync('__APPLY_LENGTH_METER_ON', isApplyLengthMeterActive(opts.network, __blockTime));
        return __iterSetMeterOn;
}

module.exports = { injectExecutionGlobals };
