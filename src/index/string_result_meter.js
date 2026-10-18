/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 ********************************************************************/
// @ts-nocheck

const { deriveHarness } = require('./armed_harness/derivation.js');

// Block-time activation for string-result metering. Null leaves a network
// unarmed, while zero activates the rule from genesis. Unknown networks fail
// closed.
const STRING_RESULT_METER_ACTIVATION = Object.seal({
    mainnet: null,
    testnet: 1792416600,
    regtest: 0,
});

function isStringResultMeterActive(network, blockTime) {
    const gate = STRING_RESULT_METER_ACTIVATION[network];
    return Number.isFinite(gate) &&
        (gate === 0 || (Number.isFinite(blockTime) && blockTime >= gate));
}

const APPLY_LENGTH_LINE =
    '    var __applyLengthMeterOn = globalThis.__APPLY_LENGTH_METER_ON === true;';
const HTML_WRAPPERS =
    "        var __meterStringResult = function(name) {\n" +
    "            var orig = String.prototype[name];\n" +
    "            if (typeof orig !== 'function') return;\n" +
    "            __lockMethod(String.prototype, name, function() {\n" +
    "                var r = orig.apply(this, arguments);\n" +
    "                __allocGas(r.length);\n" +
    "                return r;\n" +
    "            });\n" +
    "        };\n" +
    "        var __stringHtmlMethods = ['anchor', 'big', 'blink', 'bold', 'fixed',\n" +
    "            'fontcolor', 'fontsize', 'italics', 'link', 'small', 'strike', 'sub', 'sup'];\n" +
    "        for (var __shi = 0; __shi < __stringHtmlMethods.length; __shi++) {\n" +
    "            __meterStringResult(__stringHtmlMethods[__shi]);\n" +
    '        }';
const GATED_HTML_WRAPPERS =
    HTML_WRAPPERS.replace('        var __meterStringResult = ',
        '        var __meterStringResult, __stringHtmlAllocGas = __allocGas; ' +
        '{ let __allocGas = __stringResultMeterOn ? __stringHtmlAllocGas : function() {}; ' +
        '__meterStringResult = ') + ' }';
const RAW_WRAPPER = (guard) =>
    '        var __stringRaw = String.raw;\n' +
    `        ${guard} __lockMethod(String, 'raw', function() {\n` +
    '            var r = __stringRaw.apply(this, arguments);\n' +
    '            __allocGas(r.length);\n' +
    '            return r;\n' +
    '        });';
const GATED_RAW_WRAPPER = (guard) =>
    '        var __stringRaw = String.raw;\n' +
    '        var __stringRawAllocGas = __allocGas; { let __allocGas = ' +
    '__stringResultMeterOn ? __stringRawAllocGas : function() {}; ' +
    `${guard} __lockMethod(String, 'raw', function() {\n` +
    '            var r = __stringRaw.apply(this, arguments);\n' +
    '            __allocGas(r.length);\n' +
    '            return r;\n' +
    '        }); }';
const PER_ELEMENT_RAW_RESULT =
    '        __allocGas(r.length);\n' +
    '        return r;\n' +
    '    });\n' +
    '    // ----- end per-element meter -----';
const GATED_PER_ELEMENT_RAW_RESULT =
    '        if (__stringResultMeterOn) __allocGas(r.length);\n' +
    '        return r;\n' +
    '    });\n' +
    '    // ----- end per-element meter -----';

function buildStringResultMeterHarness(source) {
    // The per-element rule suppresses the legacy String.raw wrapper and installs
    // its own. Accept exactly that derived guard or the released plain guard.
    const plainGuard = "if (typeof __stringRaw === 'function')";
    const perElementGuard = "if (typeof __stringRaw === 'function' && !__pemArmed)";
    const rawGuard = source.includes(RAW_WRAPPER(perElementGuard)) ? perElementGuard : plainGuard;
    const edits = [
        [APPLY_LENGTH_LINE, APPLY_LENGTH_LINE +
            ' var __stringResultMeterOn = globalThis.__STRING_RESULT_METER_ON === true;'],
        [HTML_WRAPPERS, GATED_HTML_WRAPPERS],
        [RAW_WRAPPER(rawGuard), GATED_RAW_WRAPPER(rawGuard)],
    ];
    if (rawGuard === perElementGuard)
        edits.push([PER_ELEMENT_RAW_RESULT, GATED_PER_ELEMENT_RAW_RESULT]);
    return deriveHarness(source, [{
        label: 'string result meter',
        edits,
        helpers: '',
    }]);
}

function installStringResultMeterCompiler(selector) {
    if (selector.compileHarness.__stringResultMeterCompiler) return;
    // Derive after the selector has composed its other rules. This keeps the
    // selector's zero mask and released source intact while every execution gets
    // the network flag captured into its compiled wrapper closures.
    const sources = new Map();
    const sourceFor = (mask) => {
        let source = sources.get(mask);
        if (source === undefined) {
            source = buildStringResultMeterHarness(selector.harnessSourceFor(mask));
            sources.set(mask, source);
        }
        return source;
    };
    // Prove every rule combination at module load, matching the selector's own
    // refusal to start when an exact edit no longer matches.
    for (let mask = 0; mask < 1 << selector.RULES.length; mask++)
        buildStringResultMeterHarness(selector.harnessSourceFor(mask));
    const compileHarness = function(vm, isolate, mask) {
        const cache = mask === 0 ? vm._harnessCachedData :
            (vm._armedHarnessCache && vm._armedHarnessCache.get(mask)) || null;
        const script = vm.isolateManager.compileScript(isolate, sourceFor(mask), cache);
        if (!cache) {
            try {
                const data = vm.isolateManager.getCachedData(script);
                if (mask === 0) vm._harnessCachedData = data;
                else {
                    if (!vm._armedHarnessCache) vm._armedHarnessCache = new Map();
                    vm._armedHarnessCache.set(mask, data);
                }
            } catch (e) { /* non-fatal */ }
        }
        return script;
    };
    Object.defineProperty(compileHarness, '__stringResultMeterCompiler', { value: true });
    selector.compileHarness = compileHarness;
}

module.exports = {
    STRING_RESULT_METER_ACTIVATION,
    isStringResultMeterActive,
    buildStringResultMeterHarness,
    installStringResultMeterCompiler,
};
