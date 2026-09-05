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
        require('../../src/toolkit/simulator.js'));
} catch (e) {
    console.log('Skipping toolkit simulator tests (isolated-vm unavailable):', e.message);
}

const COUNTER = `
module.exports = {
    initialize: function(xchain) {
        var start = xchain.getInputParam(0);
        if (start === null || start === undefined) start = '0';
        xchain.state.set('count', start);
        return start;
    },
    increment: function(xchain) {
        var by = xchain.getInputParam(0) || '1';
        xchain.require(xchain.math.gt(by, '0'), 'must be positive');
        var next = xchain.math.add(xchain.state.get('count') || '0', by);
        xchain.state.set('count', next);
        return next;
    },
    get: function(xchain) { return xchain.state.get('count') || '0'; }
};`;

(ContractSimulator ? describe : describe.skip)('Toolkit ContractSimulator', function() {
    this.timeout(30000);

    it('deploys, runs the constructor, and reads state back', async function() {
        const sim = new ContractSimulator({ coin: 'BTC' });
        try {
            const dep = await sim.deploy(COUNTER, { constructorParams: ['5'] });
            assert.strictEqual(dep.initResult.success, true);
            const res = await sim.call(dep.contractIndex, 'get', []);
            assert.strictEqual(JSON.parse(res.returnValue), '5');
        } finally { await sim.close(); }
    });

    it('persists committed state across calls (in-memory indexer mock)', async function() {
        const sim = new ContractSimulator();
        try {
            const dep = await sim.deploy(COUNTER, { constructorParams: ['0'] });
            await sim.call(dep.contractIndex, 'increment', ['3']);
            const res = await sim.call(dep.contractIndex, 'increment', ['4']);
            assert.strictEqual(JSON.parse(res.returnValue), '7');
            assert.strictEqual(sim.getStateValue(dep.contractIndex, 'count'), '7');
            assert(res.gasUsed > 0);
        } finally { await sim.close(); }
    });

    it('does not commit state on revert (atomicity)', async function() {
        const sim = new ContractSimulator();
        try {
            const dep = await sim.deploy(COUNTER, { constructorParams: ['2'] });
            const before = sim.getStateValue(dep.contractIndex, 'count');
            const res = await sim.call(dep.contractIndex, 'increment', ['0']);
            assert.strictEqual(res.success, false);
            assert.strictEqual(sim.getStateValue(dep.contractIndex, 'count'), before);
        } finally { await sim.close(); }
    });

    it('exposes seeded balances to getBalance', async function() {
        const sim = new ContractSimulator({ coin: 'BTC' });
        sim.setBalance('alice', 'GOLD', '1000');
        try {
            const dep = await sim.deploy(
                'module.exports = function(xchain){ return xchain.getBalance("alice","GOLD"); };');
            const res = await sim.call(dep.contractIndex, 'default', []);
            assert.strictEqual(JSON.parse(res.returnValue), '1000');
        } finally { await sim.close(); }
    });

    it('exposes seeded oracle prices to oracle.getPrice', async function() {
        const sim = new ContractSimulator();
        sim.setPrice('BTC/USD', '65000');
        try {
            const dep = await sim.deploy(
                'module.exports = function(xchain){ var p = xchain.oracle.getPrice("BTC/USD"); return p ? String(p.price) : "none"; };');
            const res = await sim.call(dep.contractIndex, 'default', []);
            assert.strictEqual(JSON.parse(res.returnValue), '65000');
        } finally { await sim.close(); }
    });

    it('captures emitted actions without applying them to the ledger', async function() {
        const sim = new ContractSimulator({ coin: 'BTC' });
        try {
            const dep = await sim.deploy(
                'module.exports = function(xchain){ xchain.emit.send({ destination: "bob", tick: "GOLD", quantity: "10" }); return "sent"; };');
            const res = await sim.call(dep.contractIndex, 'default', []);
            assert.strictEqual(res.success, true);
            assert.strictEqual(res.emittedActions.length, 1);
            assert.strictEqual(res.emittedActions[0].action, 'SEND');
            // ledger untouched: getBalance still reads only what was seeded (nothing)
            assert.strictEqual(sim.getBalance('bob', 'GOLD'), null);
        } finally { await sim.close(); }
    });

    it('advances blocks and threads the new block context', async function() {
        const sim = new ContractSimulator();
        try {
            const dep = await sim.deploy(
                'module.exports = function(xchain){ return String(xchain.getBlockHeight()); };');
            const r1 = await sim.call(dep.contractIndex, 'default', []);
            assert.strictEqual(JSON.parse(r1.returnValue), '1');
            sim.advanceBlock();
            const r2 = await sim.call(dep.contractIndex, 'default', []);
            assert.strictEqual(JSON.parse(r2.returnValue), '2');
        } finally { await sim.close(); }
    });

    it('reports the chain deploy verdict, on mainnet too, where nothing else lints', async function() {
        // A mainnet-configured simulator gets NO source lint anywhere else: the VM's
        // execute-time re-lint rides EXEC_LINT_ACTIVATION, whose mainnet entries are
        // the unarmed null sentinel, so without this gate a deploy-rejected source is
        // reported only if some RUNTIME strip happens to catch it too. This one is
        // caught (banned-math also strips Math.sqrt, so call() errors), which is why
        // it is the readable case to assert on; the classes with no runtime twin run
        // green end to end, measured on a default mainnet simulator: `2 ** 3` returns
        // "8", a `__setconcat` binding returns "5", and a generator yields 1, each of
        // them CODE_ENCODING on chain. The gate is what reports all four alike.
        const sim = new ContractSimulator({ coin: 'BTC', network: 'mainnet' });
        const warned = [];
        const real = console.warn;
        console.warn = (...a) => warned.push(a.join(' '));
        try {
            const dep = await sim.deploy(
                'module.exports = { run: function(xchain){ return String(Math.sqrt(4)); } };');
            assert.strictEqual(dep.deployGate.valid, false,
                'a mainnet simulator must still report the banned-math deploy rejection');
            assert.match(String(dep.deployGate.error), /Math\.sqrt/);
            // Advisory by design: the contract is still registered, so a fixture that
            // deliberately simulates a chain-rejected source keeps working.
            assert.strictEqual(sim.contracts.size, 1);
            // Warned once, not once per deploy.
            await sim.deploy(
                'module.exports = { run: function(xchain){ return String(Math.pow(2, 3)); } };');
            const gateWarnings = warned.filter((l) => /DEPLOY gate rejects/.test(l));
            assert.strictEqual(gateWarnings.length, 1, JSON.stringify(warned));
        } finally { console.warn = real; await sim.close(); }
    });

    it('passes a clean contract through the deploy gate on both networks', async function() {
        const dflt = new ContractSimulator();
        const main = new ContractSimulator({ coin: 'BTC', network: 'mainnet' });
        try {
            for (const sim of [dflt, main]) {
                const dep = await sim.deploy(COUNTER, { constructorParams: ['1'] });
                assert.deepStrictEqual(dep.deployGate, { valid: true });
                assert.strictEqual(dep.initResult.success, true, dep.initResult.error);
            }
        } finally { await dflt.close(); await main.close(); }
    });

    it('resolves the gate flags at the configured epoch, not hardcoded on', async function() {
        // The point of resolving from (network, coin, block) rather than passing
        // literal `true`: a mainnet simulator pinned BELOW the Pkg-3 activation must
        // accept a source whose only violation rides that unarmed gate, exactly as
        // the chain accepted it at that height. Hardcoding the flags would reject it
        // and teach the author their historical contract was never deployable.
        const WASM = 'module.exports = { probe: function(xchain){ return typeof WebAssembly; } };';
        const pre = new ContractSimulator({ coin: 'BTC', network: 'mainnet', block: { height: 1 } });
        const at  = new ContractSimulator({ coin: 'BTC', network: 'mainnet' });
        const real = console.warn;
        console.warn = () => {};
        try {
            assert.strictEqual((await pre.deploy(WASM)).deployGate.valid, true,
                'below the Pkg-3 height the banned-wasm rule is not enforced on chain either');
            const atGate = await at.deploy(WASM);
            assert.strictEqual(atGate.deployGate.valid, false,
                'at the armed height the chain rejects WebAssembly at deploy');
            assert.match(String(atGate.deployGate.error), /WebAssembly/);
        } finally { console.warn = real; await pre.close(); await at.close(); }
    });

    it('runs a TypeScript contract via the strip step', async function() {
        const sim = new ContractSimulator();
        try {
            const ts = 'module.exports = function(xchain: any): string { const n: string = "42"; xchain.state.set("v", n); return n; };';
            const dep = await sim.deploy(ts, { filename: 'c.ts' });
            const res = await sim.call(dep.contractIndex, 'default', []);
            assert.strictEqual(JSON.parse(res.returnValue), '42');
            assert.strictEqual(sim.getStateValue(dep.contractIndex, 'v'), '42');
        } finally { await sim.close(); }
    });
});

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
(ContractSimulator ? describe : describe.skip)('Toolkit ContractSimulator: guard mode + snapshots', function() {
    this.timeout(30000);

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
