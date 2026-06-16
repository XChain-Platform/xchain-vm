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
 * Generate the canonical golden-hash manifest.
 *
 *   node test/determinism/generate-golden.js            # write golden-manifest.json
 *   node test/determinism/generate-golden.js --platform # write per-platform snapshot only
 *
 * The canonical golden-manifest.json carries ONLY the per-scenario
 * hashes (the invariant tier) plus gas observations. It is the source
 * of truth the mocha guard verifies against on every platform. Generate
 * it once on a reference machine; verify it everywhere.
 ********************************************************************/
// @ts-nocheck


const fs = require('fs');
const path = require('path');
const { runAll } = require('./runner');

async function main() {
    const platformOnly = process.argv.includes('--platform');
    const { platform, entries } = await runAll();

    if (platformOnly) {
        const out = path.join(__dirname, `snapshot.${platform}.json`);
        fs.writeFileSync(out, JSON.stringify({ platform, entries }, null, 2) + '\n');
        process.stdout.write(`wrote ${out}\n`);
        return;
    }

    // Canonical manifest: hashes are the contract; gas/error recorded for
    // human diffing. `generatedOn` documents the reference platform but is
    // NOT part of the verified contract.
    const manifest = {
        version: 1,
        generatedOn: platform,
        note: 'Verified by golden.determinism.test.js on every platform. ' +
              'Resource-tier hazards (memory ceiling) are observed, not asserted byte-equal.',
        scenarios: entries.map(e => ({
            id: e.id,
            tier: e.tier,
            hash: e.hash,
            gasUsed: e.gasUsed,
            error: e.error,
            ...(e.hazard ? { hazard: e.hazard } : {})
        }))
    };

    const out = path.join(__dirname, 'golden-manifest.json');
    fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
    process.stdout.write(`wrote ${out} (${manifest.scenarios.length} scenarios, ref=${platform})\n`);
}

main().then(() => process.exit(0)).catch(e => {
    process.stderr.write('generate-golden failed: ' + (e && e.stack || e) + '\n');
    process.exit(1);
});
