const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { CONTRACT_HOST_FIXTURES } = require('./contract-host-fixtures.js');

let XChainVM;
try {
    XChainVM = require('../../src/index.js');
} catch (e) {
    console.log('Skipping determinism-baseline tests — isolated-vm not available:', e);
}

// ---------------------------------------------------------------------------
// VM construction + result normalization — kept byte-identical to
// determinism.test.js so a digest pinned here means the same thing there.
// (determinism.test.js proves same-process run-twice-equal; THIS file pins a
//  committed baseline so a *semantic* change is caught even when it's still
//  internally deterministic.)
// ---------------------------------------------------------------------------
const GAS_SCHEDULE = {
    VM_COMPUTATION: 1, VM_STATE_READ: 100, VM_STATE_WRITE: 200,
    VM_STATE_DELETE: 100, VM_ORACLE_READ: 100, VM_CROSSCHAIN_READ: 100, VM_ATTEST_REQUEST: 5000,
    VM_EMISSION: 500
};

function createVM() {
    return new XChainVM({
        gasSchedule: GAS_SCHEDULE,
        gasCeiling: 1000000,
        limits: {
            maxCpuTimeMs: 5000, maxMemory: 8, maxEmissions: 50,
            maxStateKeys: 10000, maxStateValueSize: 65536, maxCodeSize: 65536
        }
    });
}

function hashResult(result) {
    // Normalize for comparison: sort state changes by key
    const normalized = {
        success: result.success,
        error: result.error,
        gasUsed: result.gasUsed,
        returnValue: result.returnValue,
        stateChanges: [...result.stateChanges].sort((a, b) => a.key.localeCompare(b.key)),
        stateDeletes: [...result.stateDeletes].sort(),
        emittedActions: result.emittedActions,
        logs: result.logs
    };
    return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

const baseOpts = {
    state: { counter: '5', owner: 'addr1' },
    method: 'default',
    params: ['arg1', 'arg2'],
    caller: 'addr1',
    contractAddress: 'C:BTC:100',
    blockContext: { height: 500, timestamp: 1700000000, hash: 'blockhash123' }
};

// ---------------------------------------------------------------------------
// Fixed contract corpus. `name` is the stable key in DETERMINISM_BASELINE.json
// — DO NOT rename without regenerating. File contracts live in test/contracts/;
// inline cases mirror the proven-good inline contracts in determinism.test.js.
// ---------------------------------------------------------------------------
const CORPUS = [
    { name: 'state_counter:increment', file: 'state_counter.js', method: 'increment', state: { counter: '5' } },
    { name: 'simple_send:send', file: 'simple_send.js', method: 'send', params: ['dest_addr', '100'], state: { owner: 'addr1', token: 'TEST' } },
    { name: 'amm_swap:swap', file: 'amm_swap.js', method: 'swap', params: ['100', 'TOKENA'], state: { tokenA: 'TOKENA', tokenB: 'TOKENB', reserveA: '10000', reserveB: '5000' } },
    {
        name: 'inline:math',
        code: `module.exports = function(xchain) {
            var a = xchain.math.divide('1', '3');
            var b = xchain.math.multiply(a, '3');
            var c = xchain.math.subtract(b, '1');
            return { a: a, b: b, c: c };
        };`
    },
    {
        name: 'inline:emit',
        code: `module.exports = function(xchain) {
            xchain.emit.send({ destination: 'addr1', tick: 'T', quantity: '100' });
            xchain.emit.send({ destination: 'addr2', tick: 'T', quantity: '200' });
            return 'done';
        };`
    },
    {
        name: 'inline:revert',
        code: `module.exports = function(xchain) {
            xchain.state.set('before', 'revert');
            xchain.revert('test failure');
        };`
    },
    {
        name: 'inline:state-math-loop',
        code: `module.exports = function(xchain) {
            for (var i = 0; i < 5; i++) {
                xchain.state.set('k' + i, xchain.math.multiply(String(i), '10'));
            }
            return 'done';
        };`,
        state: {}
    },
    // Contract-targeted staking + external attestation host methods. Shared with
    // determinism.test.js via contract-host-fixtures.js so the run-twice suite and
    // this pinned-baseline suite exercise byte-identical code + injected accessors.
    ...CONTRACT_HOST_FIXTURES
];

const BASELINE_PATH = path.join(__dirname, 'DETERMINISM_BASELINE.json');
const REGEN = process.env.REGEN_DETERMINISM_BASELINE === '1';

function optsFor(c) {
    const code = c.file
        ? fs.readFileSync(path.join(__dirname, '../contracts/', c.file), 'utf8')
        : c.code;
    return {
        ...baseOpts,
        code,
        method: ('method' in c) ? c.method : baseOpts.method,
        params: ('params' in c) ? c.params : baseOpts.params,
        state: ('state' in c) ? c.state : baseOpts.state,
        // Host-method fixtures inject accessor data (contractStakeData /
        // attestationData) plus stable txHash/contractIndex via `extra`.
        ...(c.extra || {})
    };
}

(XChainVM ? describe : describe.skip)('Determinism — committed baseline', function() {

    let vm;
    const actual = {};
    let baseline = {};

    before(async function() {
        vm = createVM();
        for (const c of CORPUS) {
            const result = await vm.execute(optsFor(c));
            actual[c.name] = hashResult(result);
        }

        if (REGEN || !fs.existsSync(BASELINE_PATH)) {
            // Sort keys so the committed file has a stable, reviewable order.
            const ordered = {};
            for (const c of CORPUS) ordered[c.name] = actual[c.name];
            fs.writeFileSync(BASELINE_PATH, JSON.stringify(ordered, null, 2) + '\n');
            console.log(`[determinism-baseline] wrote baseline (${REGEN ? 'REGEN' : 'file absent'}): ${BASELINE_PATH}`);
        }
        baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
    });

    CORPUS.forEach(function(c) {
        it(`pins digest: ${c.name}`, function() {
            assert.ok(
                baseline[c.name],
                `no baseline digest for "${c.name}" — regenerate with REGEN_DETERMINISM_BASELINE=1`
            );
            assert.strictEqual(
                actual[c.name],
                baseline[c.name],
                `determinism drift for "${c.name}": VM output no longer matches committed baseline. ` +
                `If this change is intended, regenerate with REGEN_DETERMINISM_BASELINE=1 and review the diff.`
            );
        });
    });

    it('baseline contains no stale keys (every pinned name is still in the corpus)', function() {
        const corpusNames = new Set(CORPUS.map(c => c.name));
        const stale = Object.keys(baseline).filter(k => !corpusNames.has(k));
        assert.deepStrictEqual(stale, [], `baseline has stale entries not in corpus: ${stale.join(', ')}`);
    });
});
