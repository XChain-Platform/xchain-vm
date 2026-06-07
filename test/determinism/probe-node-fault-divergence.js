/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Red-team: the FABRICATE node-fault stance can silently fork ONE node.
 *
 * The out-of-process executor (src/process-executor.js) answers ANY host
 * termination — crash, hang/watchdog, or a worker that can never start
 * (_broken) — with a deterministic `hostTerminatedResult` (out_of_resource,
 * gasUsed = ceiling) and lets the block ADVANCE. This is correct and
 * necessary when the termination is a DETERMINISTIC property of the
 * contract: every validator's worker aborts identically, so every validator
 * fabricates the same result and the chain stays consistent. It is also what
 * prevents a poisoned contract from halting the whole chain (a DoS).
 *
 * But the executor cannot tell a deterministic abort from a LOCAL fault —
 * this machine's worker hung under CPU contention / GC, or isolated-vm
 * failed to load on this box — on work that HEALTHY nodes complete normally.
 * In that case the faulted node fabricates `out_of_resource` while the fleet
 * records `valid` / `out_of_gas`. The status_id is hashed into contract_hash
 * (xchain-indexer db.getBlockHashes), so the faulted node commits a
 * different block hash → it UNILATERALLY FORKS off the fleet, silently,
 * while continuing to "produce".
 *
 * This probe makes the divergence concrete: the SAME contract that succeeds
 * on a healthy executor yields a fabricated host-termination on a faulted
 * one. Two honest nodes, same input, different consensus result.
 *
 *   node test/determinism/probe-node-fault-divergence.js
 ********************************************************************/
// @ts-nocheck

const XChainVM = require('../../src/index.js');

// Mirror of xchain-indexer/src/utility.js vmFailureStatus (the hashed token).
function vmFailureStatus(vmError) {
    const msg = String(vmError || '');
    if (msg.startsWith('revert:')) return 'reverted';
    if (/^(out_of_gas|timeout|out_of_memory|out_of_stack|out_of_resource)\b/.test(msg)) return 'out_of_resource';
    return 'failed';
}
// The indexer records 'valid' when vmResult.success is true and no pre-VM error.
const consensusStatus = (r) => (r && r.success ? 'valid' : vmFailureStatus(r && r.error));

const GAS_SCHEDULE = {
    VM_COMPUTATION: 1, VM_STATE_READ: 100, VM_STATE_WRITE: 200, VM_STATE_DELETE: 100,
    VM_ORACLE_READ: 100, VM_CROSSCHAIN_READ: 100, VM_ATTEST_REQUEST: 5000, VM_EMISSION: 500
};
const LIMITS = { maxCpuTimeMs: 2000, maxMemory: 8, maxEmissions: 50, maxStateKeys: 10000, maxStateValueSize: 65536, maxCodeSize: 65536 };
const CFG = { execution: 'subprocess', gasSchedule: GAS_SCHEDULE, gasCeiling: 1000000, limits: LIMITS };

const CONTRACT = `module.exports = function(xchain){ return 21 * 2; };`;
const runOpts = (code) => ({ code, method: 'default', params: [], state: {}, contractAddress: 'C:BTC:1', contractIndex: 1 });

async function onHealthyNode() {
    const vm = new XChainVM(CFG);
    vm.beginBlock();
    const r = await vm.execute(runOpts(CONTRACT));
    vm.endBlock(); await vm.shutdown();
    return r;
}

async function onLocallyFaultedNode() {
    // Simulate a machine where the worker can never start (isolated-vm load
    // failure, fork EAGAIN under resource pressure, …): the executor trips its
    // _broken latch and fabricates a host-termination for every execution.
    const vm = new XChainVM(CFG);
    vm.beginBlock();
    vm._executor._broken = true;           // the permanent-fault state the executor enters after repeated spawn failures
    const r = await vm.execute(runOpts(CONTRACT));
    vm.endBlock(); await vm.shutdown();
    return r;
}

async function main() {
    process.stdout.write(`Node-fault divergence probe (FABRICATE stance)\n${'='.repeat(78)}\n`);
    const healthy = await onHealthyNode();
    const faulted = await onLocallyFaultedNode();

    const hStatus = consensusStatus(healthy);
    const fStatus = consensusStatus(faulted);
    process.stdout.write(`\nHEALTHY node:  success=${healthy.success} return=${JSON.stringify(healthy.returnValue)} ` +
        `gasUsed=${healthy.gasUsed} → STATUS=${hStatus}\n`);
    process.stdout.write(`FAULTED node:  success=${faulted.success} error=${JSON.stringify(faulted.error)} ` +
        `gasUsed=${faulted.gasUsed} → STATUS=${fStatus}\n`);

    const diverged = hStatus !== fStatus || healthy.success !== faulted.success;
    process.stdout.write(`\n${'='.repeat(78)}\n`);
    process.stdout.write(`consensus STATUS diverges: ${diverged ? 'YES *** UNILATERAL FORK ***' : 'no'} ` +
        `(${hStatus} vs ${fStatus})\n`);
    if (diverged) {
        process.stdout.write(`\nFINDING: a locally-faulted node fabricates out_of_resource for a contract\n` +
            `the fleet completes → different status_id → different contract_hash → the\n` +
            `faulted node forks off the fleet while still producing. Fabricate favors\n` +
            `liveness; safety needs a HALT path (executor _broken → indexer halt + alert,\n` +
            `and/or consensus-layer state-root divergence → halt) instead of silent commit.\n`);
    }
    process.exit(diverged ? 2 : 0);
}

main().catch(e => { process.stderr.write('probe failed: ' + (e && e.stack || e) + '\n'); process.exit(1); });
