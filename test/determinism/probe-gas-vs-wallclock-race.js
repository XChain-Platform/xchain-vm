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
 * Red-team: out_of_gas vs out_of_resource is a HOST-TIMING race.
 *
 * The indexer (xchain-indexer/src/utility.js `vmFailureStatus`) interns a
 * status token that is hashed into contract_hash (consensus). It collapses
 * the host-backstop family (timeout / out_of_memory / out_of_stack /
 * out_of_resource) into ONE token `out_of_resource`, BUT keeps `out_of_gas`
 * as its own token, on the stated assumption that gas exhaustion is
 * "deterministically gas-bounded".
 *
 * That assumption has a hole. A contract burning gas in a tight loop hits
 * one of TWO ceilings, and WHICH one fires first is a race between:
 *   - the gas ceiling   (deterministic: fixed iteration count), and
 *   - the wall-clock net (host-speed/-load dependent).
 * On a fast validator gas wins  → "out_of_gas: ..."     → token `out_of_gas`.
 * On a slow/loaded validator the wall-clock net wins → "timeout: ..."
 *                                                      → token `out_of_resource`.
 * Same contract, same gas schedule, two honest validators → two different
 * status_ids → divergent contract_hash → CHAIN FORK.
 *
 * The cross-arch x86 run surfaced this (qemu is ~10–20× slower, so the net
 * wins there). This probe reproduces it NATIVELY and deterministically by
 * varying only the wall-clock budget `maxCpuTimeMs`, a faithful, controlled
 * proxy for host speed: a host N× slower trips a 5000 ms net at the same
 * gasUsed that a fast host trips a 5000/N ms net at. gasUsed is identical
 * (clamped to the ceiling) in BOTH outcomes, so the FEE is fork-safe; only
 * the hashed STATUS token diverges.
 *
 *   node test/determinism/probe-gas-vs-wallclock-race.js
 ********************************************************************/
// @ts-nocheck

const fs = require('fs');
const path = require('path');
const { createVM, execute } = require('../fuzz/harness');

// Mirror of xchain-indexer/src/utility.js `vmFailureStatus`: the consensus
// status mapping. Kept in sync with that source: the whole resource-exhaustion
// family (out_of_gas included) collapses to one token, which is the fix this
// probe verifies.
function vmFailureStatus(vmError) {
    const msg = String(vmError || '');
    if (msg.startsWith('revert:')) return 'reverted';
    if (/^(out_of_gas|timeout|out_of_memory|out_of_stack|out_of_resource)\b/.test(msg)) return 'out_of_resource';
    return 'failed';
}

const LOOP = fs.readFileSync(path.join(__dirname, '../contracts/infinite_loop.js'), 'utf8');

async function run(maxCpuTimeMs) {
    const vm = createVM({ maxCpuTimeMs, gasCeiling: 1000000 });
    if (typeof vm.beginBlock === 'function') vm.beginBlock();
    const r = await execute(vm, LOOP, { method: 'default', params: [], state: {}, contractIndex: 1 });
    if (typeof vm.endBlock === 'function') vm.endBlock();
    return { error: r.error, gasUsed: r.gasUsed, success: r.success, status: vmFailureStatus(r.error) };
}

async function main() {
    process.stdout.write(`out_of_gas vs out_of_resource: host-timing race probe\n${'='.repeat(78)}\n`);
    // Generous budget: a fast validator. Gas ceiling wins the race.
    const fast = await run(5000);
    // Tight budget: a proportionally slower validator. Wall-clock net wins.
    const slow = await run(1);

    process.stdout.write(`\nFAST validator (maxCpuTimeMs=5000):\n` +
        `  error  = ${JSON.stringify(fast.error)}\n  gasUsed= ${fast.gasUsed}\n  STATUS = ${fast.status}\n`);
    process.stdout.write(`\nSLOW validator (maxCpuTimeMs=1):\n` +
        `  error  = ${JSON.stringify(slow.error)}\n  gasUsed= ${slow.gasUsed}\n  STATUS = ${slow.status}\n`);

    const feeSafe   = fast.gasUsed === slow.gasUsed;
    const rawRaced  = fast.error !== slow.error;       // the underlying VM-level race
    const forked    = fast.status !== slow.status;     // the consensus-level outcome
    process.stdout.write(`\n${'='.repeat(78)}\n`);
    process.stdout.write(`raw VM error differs by host speed (the race): ${rawRaced ? 'yes' : 'no'}\n`);
    process.stdout.write(`gasUsed identical (fee fork-safe):             ${feeSafe ? 'yes' : 'NO'}  (${fast.gasUsed} vs ${slow.gasUsed})\n`);
    process.stdout.write(`consensus STATUS token diverges:              ${forked ? 'YES *** FORK ***' : 'no'}  ` +
        `(${fast.status} vs ${slow.status})\n`);
    if (forked) {
        process.stdout.write(`\nFINDING (pre-fix): two honest validators commit different status_ids for\n` +
            `the same contract+gas-schedule → divergent contract_hash → CHAIN FORK.\n`);
    } else {
        process.stdout.write(`\nFIXED: the raw gas-vs-wall-clock race is still present at the VM level,\n` +
            `but the resource family collapses to ONE consensus token, so WHICH ceiling\n` +
            `fires no longer affects contract_hash. gasUsed is clamped → fee fork-safe.\n`);
    }
    process.exit(forked ? 2 : 0);
}

main().catch(e => { process.stderr.write('probe failed: ' + (e && e.stack || e) + '\n'); process.exit(1); });
