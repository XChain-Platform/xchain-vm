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
 * XChain VM: harness selection
 *
 * Every activation that changes in-isolate harness text is a rule here, in a
 * fixed order. An execution computes one bit per rule from its own gates; with
 * no bit set it compiles HARNESS_SOURCE itself, byte for byte. Any other set of
 * bits compiles the harness derived for exactly those rules (derivation.js),
 * built once per set and kept with its own V8 cached data.
 ********************************************************************/
// @ts-nocheck
'use strict';

const { HARNESS_SOURCE } = require('../runtime/harness_source.js');
const { deriveHarness } = require('./derivation.js');
const resourceFaultSignal = require('./resource_fault_signal.js');
const hostErrorStackStrip = require('./host_error_stack_strip.js');
const hostCallBounds = require('./host_call_bounds.js');
const stringifyReentry = require('./json_stringify_reentry.js');
const perElementMeter = require('./per_element_meter.js');
const stringReceiverMeter = require('./string_receiver_meter.js');
const toStringSizeMeter = require('./tostring_size_meter.js');
const nativeStackTerminal = require('../native_stack/harness_rule.js');
const { isHostErrorStackStripActive } = require('../host_error_stack_strip_heights.js');
const { isHostCallBoundsActive } = require('../host_call_bounds.js');
const { isJsonStringifyReentryActive } = require('../json_stringify_reentry_heights.js');
const { isPerElementMeterActive } = require('../per_element_meter.js');
const { isStringReceiverMeterActive } = require('../string_receiver_meter.js');
const { isToStringSizeMeterActive } = require('../tostring_size_meter.js');

// The rules in their fixed order; a rule's bit is 1 << its index. The native stack
// rule is last so it can be dropped without moving any other bit.
const RULES = [resourceFaultSignal, hostErrorStackStrip, hostCallBounds, stringifyReentry, perElementMeter,
    stringReceiverMeter, toStringSizeMeter, nativeStackTerminal];
const bitOf = (rule) => 1 << RULES.indexOf(rule);

// Replace one exact span of a rule's helper text, refusing a text it no longer matches.
function rewriteOnce(label, text, from, to) {
    const hits = text.split(from).length - 1;
    if (hits !== 1) throw new Error('xchain-vm: ' + label + ' helper rewrite matched ' + hits + ' times: ' + from.trim());
    return text.replace(from, () => to);
}

// Rules whose helper text depends on another armed rule. The host-call bounds rule
// lends one depth level to a host call's argument array in wrap() and hands it to the
// JSON.stringify wrapper; armed beside it:
//   - the host error stack strip's __wrapArmed serializes the arguments for wrap(),
//     so it lends the same level;
//   - the re-entrant JSON.stringify wrapper replaces the legacy wrapper the host-call
//     bounds edits reach, so it takes and clears the allowance itself, and a nested
//     call from a toJSON, replacer or getter gets none.
const COUPLINGS = [
    {
        rule: hostErrorStackStrip, with: hostCallBounds,
        apply: (text) => rewriteOnce(hostErrorStackStrip.LABEL, text, hostErrorStackStrip.ARGUMENT_LINE,
            hostCallBounds.EDITS[0][1] + '\n'),
    },
    {
        rule: stringifyReentry, with: hostCallBounds,
        apply: (text) => rewriteOnce(stringifyReentry.LABEL, rewriteOnce(stringifyReentry.LABEL, text,
            '    function __rsfStringifyReentrant(value) {\n',
            '    function __rsfStringifyReentrant(value) {\n' +
            '        var allowance = __hostArgDepthAllowance; __hostArgDepthAllowance = 0;\n'),
            '            copy = __resolveForStringify(value, arguments[1]);\n',
            '            copy = __resolveForStringify(value, arguments[1], allowance);\n'),
    },
];

function rulesFor(mask) {
    const armed = RULES.filter((rule) => (mask & bitOf(rule)) !== 0);
    return armed.map((rule) => {
        let helpers = rule.HELPERS;
        for (const c of COUPLINGS)
            if (c.rule === rule && armed.includes(c.with)) helpers = c.apply(helpers);
        return { label: rule.LABEL, edits: rule.EDITS, helpers };
    });
}

const SOURCES = new Map([[0, HARNESS_SOURCE]]);

function harnessSourceFor(mask) {
    let source = SOURCES.get(mask);
    if (source === undefined) {
        source = deriveHarness(HARNESS_SOURCE, rulesFor(mask));
        SOURCES.set(mask, source);
    }
    return source;
}

// Load-time proof over every combination: each one derives (no two rules edit the
// same harness line, every edit and coupling still matches), and the empty one is
// the unarmed harness itself. Only the combinations an execution asks for are kept.
for (let mask = 1; mask < 1 << RULES.length; mask++) deriveHarness(HARNESS_SOURCE, rulesFor(mask));
if (deriveHarness(HARNESS_SOURCE, []) !== HARNESS_SOURCE) throw new Error('xchain-vm: the unarmed harness is not HARNESS_SOURCE');

// One bit per rule, from the gates the execution resolved.
function harnessMask(gates) {
    return (gates.resourceFaultSignal ? bitOf(resourceFaultSignal) : 0) |
        (gates.hostErrorStackStrip ? bitOf(hostErrorStackStrip) : 0) |
        (gates.hostCallBounds ? bitOf(hostCallBounds) : 0) |
        (gates.stringifyReentry ? bitOf(stringifyReentry) : 0) |
        (gates.perElementMeter ? bitOf(perElementMeter) : 0) |
        (gates.stringReceiverMeter ? bitOf(stringReceiverMeter) : 0) |
        (gates.toStringSizeMeter ? bitOf(toStringSizeMeter) : 0) |
        (gates.nativeStackTerminal ? bitOf(nativeStackTerminal) : 0);
}

// The mask for one execution: the per-coin height gates at its coin and height, the
// block-time gates at its block time, and the two gates the caller already resolved
// for other uses (the resource fault signal for the classifier, the native stack rule
// for the metering transform), so no execution can disagree with itself.
function executionHarnessMask(opts, coin, height, resourceFaultSignalOn, nativeStackTerminalOn) {
    const blockTime = opts.blockContext && Number(opts.blockContext.timestamp);
    return harnessMask({
        resourceFaultSignal: resourceFaultSignalOn === true,
        hostErrorStackStrip: isHostErrorStackStripActive(opts.network, coin, height),
        hostCallBounds: isHostCallBoundsActive(opts.network, blockTime),
        stringifyReentry: isJsonStringifyReentryActive(opts.network, coin, height),
        perElementMeter: isPerElementMeterActive(opts.network, blockTime),
        stringReceiverMeter: isStringReceiverMeterActive(opts.network, blockTime),
        toStringSizeMeter: isToStringSizeMeterActive(opts.network, blockTime),
        nativeStackTerminal: nativeStackTerminalOn === true,
    });
}

// Compile the harness for this mask. Mask 0 keeps the instance's own unarmed source
// and cached data (vm._harnessSource, vm._harnessCachedData); every other mask keeps
// its cached data in vm._armedHarnessCache.
function compileHarness(vm, isolate, mask) {
    if (mask === 0) {
        const script = vm.isolateManager.compileScript(isolate, vm._harnessSource, vm._harnessCachedData);
        if (!vm._harnessCachedData) {
            try { vm._harnessCachedData = vm.isolateManager.getCachedData(script); } catch (e) { /* non-fatal */ }
        }
        return script;
    }
    if (!vm._armedHarnessCache) vm._armedHarnessCache = new Map();
    const cached = vm._armedHarnessCache.get(mask) || null;
    const script = vm.isolateManager.compileScript(isolate, harnessSourceFor(mask), cached);
    if (!cached) {
        try { vm._armedHarnessCache.set(mask, vm.isolateManager.getCachedData(script)); } catch (e) { /* non-fatal */ }
    }
    return script;
}

module.exports = { RULES, COUPLINGS, harnessSourceFor, harnessMask, executionHarnessMask, compileHarness };
