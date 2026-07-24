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

//  doctrine test-coverage program: coverage for the scripts component
// (scripts/mutation-report.js). The report generator self-executes on load
// (it reads Stryker/custom JSON and writes reports/mutation/MUTATION_SUMMARY.md),
// so running it here would mutate the repo. This pins its structural contract
// by compiling and inspecting the source: it must read the two known mutant
// report inputs, emit the summary markdown, and stay offline.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', '..', 'scripts', 'mutation-report.js');
const source = fs.readFileSync(SRC, 'utf8').replace(/^#!.*\n/, '');

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
});
