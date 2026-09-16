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
 * Toolkit: ContractSimulator end-to-end. Needs the isolated-vm binding, so
 * the require is guarded: on a host where it cannot dlopen (e.g. macOS dev
 * box) the suite SKIPS (mirrors the VM smoke-suite convention) instead of
 * crash-spamming. Runs for real on Node 22 / Linux (CI).
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');

// Guard the require itself: simulator.js -> src/index.js -> isolated-vm.
let ContractSimulator = null;
let GUARD_GAS_CEILING = null;
let GUARD_PARAM_ORDER = null;
try {
    ({ ContractSimulator, GUARD_GAS_CEILING, GUARD_PARAM_ORDER } =
        require('../../../src/toolkit/simulator.js'));
} catch (e) {
    console.log('Skipping toolkit simulator tests (isolated-vm unavailable):', e.message);
}

/*
 * Controller-guard mode and the read-only snapshot seeders.
 *
 * A CLOSED execute() option set gives a guard contract simulated in the only
 * mode available (an ordinary call) attestation.request and emit.crossExecute
 * AVAILABLE at the 1000000 default ceiling, while the indexer runs the identical
 * code with isGuard set (both of those throw) at VM_GUARD_GAS_CEILING = 200000:
 * the guard then simulates green on calls that revert on chain, at 5x the real
 * headroom. Each case below fails if the corresponding option stops reaching
 * the VM.
 */
// Calls the async framework the chain disables under isGuard.
const GUARD_ATTEST = `
module.exports = { guard: function(xchain) {
    xchain.attestation.request('http_get', 'https://example.com', 'cb', [], { redundancy: 1, deadlineBlocks: 10 });
    return 'allow';
} };`;

const GUARD_XCALL = `
module.exports = { guard: function(xchain) {
    xchain.emit.crossExecute({ targetChain: 'DOGE', contractIndex: 1, method: 'm',
        gasLimit: 50000, callbackMethod: 'cb' });
    return 'allow';
} };`;

// Echoes the seven positional guard params so their ORDER and their
// ''-for-absent coercion are asserted rather than assumed.
const GUARD_ECHO = `
module.exports = { guard: function(xchain) {
    return xchain.getInputParams().join('|');
} };`;

(ContractSimulator ? describe : describe.skip)('Toolkit ContractSimulator: guard mode + snapshots', function() {
    this.timeout(30000);

    it('a guard calling attestation.request fails under callGuard and succeeds under call', async function() {
        const sim = new ContractSimulator();
        try {
            const dep = await sim.deploy(GUARD_ATTEST);
            const guarded = await sim.callGuard(dep.contractIndex, { actionType: 'SEND' });
            assert.strictEqual(guarded.success, false, 'a guard must not reach attestation.request');
            assert.match(String(guarded.error), /not available to a controller guard/);

            const plain = await sim.call(dep.contractIndex, 'guard', ['SEND', '', '', '', '', '', '']);
            assert.strictEqual(plain.success, true, plain.error);
        } finally { await sim.close(); }
    });

    it('a guard calling emit.crossExecute fails under callGuard and succeeds under call', async function() {
        const sim = new ContractSimulator();
        try {
            const dep = await sim.deploy(GUARD_XCALL);
            const guarded = await sim.callGuard(dep.contractIndex, { actionType: 'SEND' });
            assert.strictEqual(guarded.success, false, 'a guard must not reach emit.crossExecute');
            assert.match(String(guarded.error), /not available to a controller guard/);

            const plain = await sim.call(dep.contractIndex, 'guard', ['SEND', '', '', '', '', '', '']);
            assert.strictEqual(plain.success, true, plain.error);
        } finally { await sim.close(); }
    });

    it('callGuard passes the seven guard params in consensus order, absent as empty string', async function() {
        const sim = new ContractSimulator();
        try {
            const dep = await sim.deploy(GUARD_ECHO);
            const r = await sim.callGuard(dep.contractIndex, {
                actionType: 'SEND', from: 'alice', to: 'bob', tick: 'GOLD', amount: 5
            });
            assert.strictEqual(r.success, true, r.error);
            // price and proceedsTick were omitted -> trailing empties, not undefined.
            assert.strictEqual(JSON.parse(r.returnValue), 'SEND|alice|bob|GOLD|5||');
            assert.deepStrictEqual([...GUARD_PARAM_ORDER],
                ['actionType', 'from', 'to', 'tick', 'amount', 'price', 'proceedsTick']);
        } finally { await sim.close(); }
    });

});

(ContractSimulator ? describe : describe.skip)('Toolkit ContractSimulator: guard mode + snapshots', function() {
    this.timeout(30000);

    it('a guard runs at GUARD_GAS_CEILING, not the simulator default', async function() {
        // Allocation is charged by length above the metering flag-day (the
        // simulator's default block time), so 300000 elements sits between the
        // 200000 guard ceiling and the 1000000 default: out of gas as a guard,
        // fine as an ordinary call. If the ceiling stopped being applied, the
        // first assertion goes green-and-successful and this test fails.
        assert.strictEqual(GUARD_GAS_CEILING, 200000,
            'guard ceiling must track GAS_SCHEDULE.VM_GUARD_GAS_CEILING in the indexer coin configs');
        const sim = new ContractSimulator();
        try {
            const dep = await sim.deploy(
                'module.exports = { guard: function(xchain){ var a = new Array(300000).fill(0); return String(a.length); } };');
            const guarded = await sim.callGuard(dep.contractIndex, { actionType: 'SEND' });
            assert.strictEqual(guarded.success, false, 'guard must run out of gas at the 200000 ceiling');
            assert.match(String(guarded.error), /^out_of_gas:/);

            const plain = await sim.call(dep.contractIndex, 'guard', ['SEND', '', '', '', '', '', '']);
            assert.strictEqual(plain.success, true, plain.error);
            assert.ok(plain.gasUsed > GUARD_GAS_CEILING,
                'the same work must cost more than the guard ceiling for this test to mean anything, got ' + plain.gasUsed);
        } finally { await sim.close(); }
    });

});

(ContractSimulator ? describe : describe.skip)('Toolkit ContractSimulator: guard mode + snapshots', function() {
    this.timeout(30000);

    it('seeded attestation / poll / stake snapshots are readable; unseeded reads stay empty', async function() {
        const READER = `
        module.exports = { default: function(xchain) {
            var poll = xchain.getPollResult('7');
            return JSON.stringify({
                resp:    xchain.attestation.getResponse('req-1'),
                missing: xchain.attestation.getResponse('req-nope'),
                poll:    poll ? poll.winning_option : null,
                stake:   xchain.contract.getStake('a'.repeat(64), 'GOLD'),
                total:   xchain.contract.getTotalStaked('GOLD'),
                nostake: xchain.contract.getStake('b'.repeat(64), 'GOLD'),
                stakers: xchain.contract.getStakers('GOLD').length
            });
        } };`;
        const sim = new ContractSimulator();
        try {
            const dep = await sim.deploy(READER);
            const bare = await sim.call(dep.contractIndex, 'default', []);
            assert.strictEqual(bare.success, true, bare.error);
            const before = JSON.parse(JSON.parse(bare.returnValue));
            assert.deepStrictEqual(before,
                { resp: null, missing: null, poll: null, stake: '0', total: '0', nostake: '0', stakers: 0 },
                'an unseeded simulator must read back exactly what it did before the seeders existed');

            sim.setAttestationResponse('req-1', 'the-answer')
               .setPollResult('7', { status: 'finalized', winning_option: '2' })
               .setStake('a'.repeat(64), 'GOLD', '400')
               .setStake('c'.repeat(64), 'GOLD', '600');
            const seeded = await sim.call(dep.contractIndex, 'default', []);
            const after = JSON.parse(JSON.parse(seeded.returnValue));
            assert.deepStrictEqual(after,
                { resp: 'the-answer', missing: null, poll: '2', stake: '400', total: '1000', nostake: '0', stakers: 2 });
            // stakersByTick is returned verbatim, so its sort must already be right.
            assert.strictEqual(sim.contractStakeData.stakersByTick.GOLD[0].amount, '600');
        } finally { await sim.close(); }
    });

});

(ContractSimulator ? describe : describe.skip)('Toolkit ContractSimulator: guard mode + snapshots', function() {
    this.timeout(30000);

    it('a guard cannot read a seeded attestation response (the chain passes attestationData null)', async function() {
        const sim = new ContractSimulator();
        try {
            const dep = await sim.deploy(
                'module.exports = { guard: function(xchain){ return String(xchain.attestation.getResponse("req-1")); } };');
            sim.setAttestationResponse('req-1', 'the-answer');
            const plain = await sim.call(dep.contractIndex, 'guard', ['SEND', '', '', '', '', '', '']);
            assert.strictEqual(JSON.parse(plain.returnValue), 'the-answer');
            const guarded = await sim.callGuard(dep.contractIndex, { actionType: 'SEND' });
            assert.strictEqual(guarded.success, true, guarded.error);
            assert.strictEqual(JSON.parse(guarded.returnValue), 'null',
                'guard mode must not widen the read surface the chain keeps narrow');
        } finally { await sim.close(); }
    });

    it('seeded cross-chain attestation / settled / call result are readable', async function() {
        const READER = `
        module.exports = { default: function(xchain) {
            var r = xchain.crossChain.getCallResult('AABB');
            return JSON.stringify({
                att:     xchain.crossChain.getAttestation('DOGE', '9'),
                settled: xchain.crossChain.isSettled('DOGE', '9'),
                status:  r ? r.status : null
            });
        } };`;
        const sim = new ContractSimulator();
        try {
            const dep = await sim.deploy(READER);
            sim.setCrossChainAttestation('DOGE', '9', 'proof')
               .setCrossChainSettled('DOGE', '9')
               .setCallResult('AABB', { status: 'success', payload: 'ok' });
            const r = await sim.call(dep.contractIndex, 'default', []);
            assert.strictEqual(r.success, true, r.error);
            assert.deepStrictEqual(JSON.parse(JSON.parse(r.returnValue)),
                { att: 'proof', settled: true, status: 'success' });
        } finally { await sim.close(); }
    });

});

(ContractSimulator ? describe : describe.skip)('Toolkit ContractSimulator: guard mode + snapshots', function() {
    this.timeout(30000);

    it('identity pass-throughs change the derived request_id', async function() {
        const REQ = `
        module.exports = { default: function(xchain) {
            return xchain.attestation.request('http_get', 'https://example.com', 'cb', [], { redundancy: 1, deadlineBlocks: 10 });
        } };`;
        const sim = new ContractSimulator();
        try {
            const dep = await sim.deploy(REQ);
            const dflt = await sim.call(dep.contractIndex, 'default', []);
            const withId = await sim.call(dep.contractIndex, 'default', [], {
                txHash: 'f'.repeat(64), rootActionIndex: '3.1', callPath: '1>0'
            });
            assert.strictEqual(dflt.success, true, dflt.error);
            assert.strictEqual(withId.success, true, withId.error);
            assert.notStrictEqual(JSON.parse(dflt.returnValue), JSON.parse(withId.returnValue),
                'txHash / rootActionIndex / callPath must reach the request_id preimage');
        } finally { await sim.close(); }
    });

    // Drift guard. The gap this whole describe exists for was that execOpts was
    // a closed set silently narrower than the indexer's. Pin the exact key set
    // so widening or narrowing it is a deliberate, test-breaking act.
    it('pins the exact execute() option key set call() and callGuard() build', async function() {
        const EXPECTED = [
            'attestationData', 'actionIndex', 'balances', 'blockContext', 'callDepth', 'callPath',
            'caller', 'code', 'contractAddress', 'contractIndex', 'contractStakeData',
            'crossChainData', 'method', 'network', 'oracleData', 'params', 'pollData',
            'providerDeadlines', 'rootActionIndex', 'state', 'tokenInfo', 'txHash'
        ].sort();
        const sim = new ContractSimulator();
        try {
            const dep = await sim.deploy('module.exports = function(){ return "x"; };');
            const seen = [];
            const real = sim.vm.execute.bind(sim.vm);
            sim.vm.execute = (o) => { seen.push(Object.keys(o).sort()); return real(o); };

            await sim.call(dep.contractIndex, 'default', []);
            assert.deepStrictEqual(seen[0], EXPECTED, 'call() option set drifted');

            await sim.callGuard(dep.contractIndex, { actionType: 'SEND' });
            assert.deepStrictEqual(seen[1], EXPECTED.concat(['gasCeiling', 'isGuard']).sort(),
                'callGuard() option set drifted');
        } finally { await sim.close(); }
    });
});
