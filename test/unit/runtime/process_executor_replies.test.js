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
 * The executor's pure reply checks and termination outcome, without a
 * worker: which replies answer the dispatch in flight, which payloads are
 * well-formed results, and which worker deaths a contract caused.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const { newDispatchToken, isResultShape, replyFault } = require('../../../src/process_executor/frames.js');
const { isSelfInflicted, hostTerminatedResult } = require('../../../src/process_executor/termination.js');
const XChainVM = require('../../../src/index.js');

const GOOD = { success: true, error: null, gasUsed: 12, returnValue: '"x"',
    stateChanges: [], stateDeletes: [], emittedActions: [], logs: [] };

describe('process executor reply checks', function () {
    it('dispatch tokens are fresh hex strings', function () {
        const a = newDispatchToken();
        const b = newDispatchToken();
        assert.match(a, /^[0-9a-f]{16}$/);
        assert.notStrictEqual(a, b);
    });

    it('accepts every result shape the VM builds, success and failure alike', async function () {
        assert.strictEqual(isResultShape(GOOD), true);
        assert.strictEqual(isResultShape(hostTerminatedResult(1000, 'exit 1')), true);
        assert.strictEqual(isResultShape(Object.assign({}, GOOD, { returnValue: undefined, extra: 1 })), true);
        const gasSchedule = {
            VM_COMPUTATION: 1, VM_STATE_READ: 100, VM_STATE_WRITE: 200, VM_STATE_DELETE: 100,
            VM_ORACLE_READ: 100, VM_CROSSCHAIN_READ: 100, VM_ATTEST_REQUEST: 5000, VM_EMISSION: 500,
            VM_XCALL_REQUEST: 2000, VM_XCALL_CALLBACK: 20000
        };
        const vm = new XChainVM({ gasSchedule, gasCeiling: 100000, execution: 'in-process' });
        const base = { state: {}, method: 'default', params: [], caller: 'a', contractAddress: 'C:BTC:1',
            contractIndex: 1, blockContext: { height: 1, timestamp: 1700000000, hash: 'h' } };
        vm.beginBlock();
        try {
            for (const code of ['module.exports = function(){ return 1; };',
                'module.exports = function(){ throw new Error("x"); };', 'not js (']) {
                const r = JSON.parse(JSON.stringify(await vm.execute(Object.assign({}, base, { code }))));
                assert.strictEqual(isResultShape(r), true, 'refused a real result: ' + JSON.stringify(r));
            }
        } finally { vm.endBlock(); }
    });

    it('rejects payloads the worker never emits', function () {
        for (const bad of [undefined, null, 42, 'str', [], { success: true },
            Object.assign({}, GOOD, { success: 'yes' }), Object.assign({}, GOOD, { error: 5 }),
            Object.assign({}, GOOD, { gasUsed: -1 }), Object.assign({}, GOOD, { gasUsed: '1' }),
            Object.assign({}, GOOD, { gasUsed: Infinity }), Object.assign({}, GOOD, { logs: null })]) {
            assert.strictEqual(isResultShape(bad), false, JSON.stringify(bad));
        }
    });

    it('a reply must echo the in-flight token, and a result reply must carry a result', function () {
        assert.strictEqual(replyFault({ type: 'result', id: 1, token: 't', result: GOOD }, 't'), null);
        assert.strictEqual(replyFault({ type: 'hostfault', id: 1, token: 't', reason: 'r' }, 't'), null);
        assert.match(replyFault({ type: 'result', id: 1, result: GOOD }, 't'), /does not answer/);
        assert.match(replyFault({ type: 'result', id: 1, token: 'u', result: GOOD }, 't'), /does not answer/);
        assert.match(replyFault({ type: 'hostfault', id: 1, token: 'u' }, 't'), /does not answer/);
        assert.match(replyFault({ type: 'result', id: 1, token: undefined, result: GOOD }, undefined), /does not answer/);
        assert.match(replyFault({ type: 'result', id: 1, token: 't' }, 't'), /malformed/);
    });
});

describe('process executor termination outcome', function () {
    it('classifies a contract-caused death apart from an outside one', function () {
        assert.strictEqual(isSelfInflicted(1, null), true);
        assert.strictEqual(isSelfInflicted(0, null), false);
        assert.strictEqual(isSelfInflicted(null, 'SIGABRT'), true);
        assert.strictEqual(isSelfInflicted(null, 'SIGKILL'), false);
        assert.strictEqual(isSelfInflicted(null, null), false);
    });

    it('clamps a host termination to the given ceiling', function () {
        const r = hostTerminatedResult(5000, 'signal SIGABRT');
        assert.strictEqual(r.gasUsed, 5000);
        assert.strictEqual(r.success, false);
        assert.strictEqual(r.error, 'out_of_resource: execution host terminated (signal SIGABRT)');
    });
});
