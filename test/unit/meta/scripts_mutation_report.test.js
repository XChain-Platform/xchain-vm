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
 *********************************************************************/

// Coverage for the scripts component
// (scripts/mutation-report.js). The report generator self-executes on load
// (it reads Stryker/custom JSON and writes reports/mutation/MUTATION_SUMMARY.md),
// so running it here would mutate the repo. This pins its structural contract
// by compiling and inspecting the source: it must read the two known mutant
// report inputs, emit the summary markdown, and stay offline.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '../../../scripts/mutation-report.js');
const source = fs.readFileSync(SRC, 'utf8').replace(/^#!.*\n/, '');

// main() self-executes on load and can process.exit(1), so the
// static-contract tests below never require() this file. To exercise the
// real TIERS lookup and computeFileStats() without that risk (or any
// fs.writeFileSync side effect), patch out the trailing main() call and run
// the rest of the source in a fresh vm context.
function loadReportInternals() {
    const patched = source.replace(/\nmain\(\);\s*$/, '\nmodule.exports = { TIERS, computeFileStats };\n');
    assert.notStrictEqual(patched, source, 'expected to patch out the trailing main() call');

    const sandbox = { module: { exports: {} }, require, __dirname: path.dirname(SRC), __filename: SRC, console, process };
    sandbox.exports = sandbox.module.exports;
    vm.createContext(sandbox);
    new vm.Script(patched, { filename: 'mutation-report.js' }).runInContext(sandbox);
    return sandbox.module.exports;
}

describe('scripts/mutation-report (static contract)', function () {
    it('is syntactically valid JavaScript (compiles without executing)', function () {
        assert.doesNotThrow(() => new vm.Script(source, { filename: 'mutation-report.js' }));
    });

    it('reads the Stryker and custom mutant report inputs', function () {
        assert.ok(/mutation-score\.json/.test(source), 'must read the Stryker report');
        assert.ok(/custom-mutant-results\.json/.test(source), 'must read the custom runner report');
    });

    it('emits the mutation summary markdown', function () {
        assert.ok(/MUTATION_SUMMARY\.md/.test(source));
    });

    it('performs no network I/O (report generation is offline)', function () {
        for (const mod of ['http', 'https', 'net', 'dns']) {
            assert.ok(!new RegExp(`require\\(\\s*['"]${mod}['"]`).test(source),
                `report generator must not require ${mod}`);
        }
    });

    it('keeps every pre-existing entry file at its declared tier', function () {
        const { TIERS } = loadReportInternals();
        assert.strictEqual(TIERS['src/index.js'].tier, 'Critical');
        assert.strictEqual(TIERS['src/index.js'].target, 95);
        assert.strictEqual(TIERS['src/gateway.js'].tier, 'High');
        assert.strictEqual(TIERS['src/gateway.js'].target, 90);
        assert.strictEqual(TIERS['src/gateway_emit.js'].tier, 'High');
        assert.strictEqual(TIERS['src/gateway_emit.js'].target, 90);
    });

    it('keys mutation tiers on the repo-relative path, so an entry-file split part inherits its entry tier', function () {
        const { computeFileStats } = loadReportInternals();

        // A part file carved out of the vm entry (src/index/*.js) inherits
        // the entry's Critical tier instead of falling to the Unknown/80
        // default a bare-filename lookup would give it.
        const indexPart = computeFileStats('src/index/install_methods.js', { mutants: [] });
        assert.strictEqual(indexPart.tierInfo.tier, 'Critical');
        assert.strictEqual(indexPart.tierInfo.target, 95);

        // A part file carved out of the gateway entries (src/gateway/*.js,
        // src/gateway_emit/*.js) inherits the gateway High tier.
        const gatewayPart = computeFileStats('src/gateway/accessors.js', { mutants: [] });
        assert.strictEqual(gatewayPart.tierInfo.tier, 'High');
        assert.strictEqual(gatewayPart.tierInfo.target, 90);
        const gatewayEmitPart = computeFileStats('src/gateway_emit/same_chain.js', { mutants: [] });
        assert.strictEqual(gatewayEmitPart.tierInfo.tier, 'High');
        assert.strictEqual(gatewayEmitPart.tierInfo.target, 90);
    });
});
