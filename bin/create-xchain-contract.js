#!/usr/bin/env node
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
 * create-xchain-contract: the `npm create` on-ramp. Scaffolds a new XChain
 * contract project (contract + simulator test + README). Thin front door to
 * `xchain-foundry new`; kept as its own bin so `npm create xchain-contract
 * <name>` works.
 *
 *   create-xchain-contract <name> [--ts] [--dir DIR] [--force]
 ********************************************************************/
// @ts-nocheck

const path = require('path');
const { writeScaffold } = require('../src/toolkit/scaffold.js');

function parseArgs(argv) {
    const flags = {};
    const positional = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) {
            const eq = a.indexOf('=');
            if (eq >= 0) { flags[a.slice(2, eq)] = a.slice(eq + 1); }
            else {
                const key = a.slice(2);
                const next = argv[i + 1];
                if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i++; }
                else flags[key] = true;
            }
        } else positional.push(a);
    }
    return { _: positional, flags };
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const name = args._[0];
    if (!name) {
        process.stderr.write('Usage: create-xchain-contract <name> [--ts] [--dir DIR] [--force]\n');
        process.exit(2);
    }
    const useTs = !!(args.flags.ts || args.flags.typescript);
    const dir = args.flags.dir ? String(args.flags.dir) : path.join(process.cwd(), name);
    let res;
    try {
        res = writeScaffold(dir, { name, typescript: useTs, force: !!args.flags.force });
    } catch (e) {
        process.stderr.write('error: ' + e.message + '\n');
        process.exit(1);
    }
    process.stdout.write('Created ' + name + (useTs ? ' (TypeScript)' : '') + ' at ' + res.dir + '\n');
    for (const f of res.written) process.stdout.write('  ' + f + '\n');
    process.stdout.write('\nNext:\n  cd ' + name + '\n' +
        '  xchain-foundry lint contracts/' + res.contractFile + '\n  npm install && npm test\n');
    process.exit(0);
}

main();
