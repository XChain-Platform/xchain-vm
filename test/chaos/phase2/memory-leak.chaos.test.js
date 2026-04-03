/*********************************************************************
 * Chaos Experiment 8: Host Process Memory Leak
 *
 * Runs 1000+ sequential execute-dispose cycles and tracks host process
 * memory to detect leaks. Uses process.memoryUsage() sampling and
 * optional global.gc() (available with --expose-gc flag).
 *
 * Run with GC exposure for best results:
 *   node --expose-gc node_modules/.bin/mocha test/chaos/phase2/memory-leak.chaos.test.js
 ********************************************************************/

const assert = require('assert');
const { XChainVM, createVM, execute, MemoryTracker } = require('../helpers/harness');
const { checkResultShape } = require('../../fuzz/invariants');

(XChainVM ? describe : describe.skip)('Chaos: Host Process Memory Leak (Exp 8)', function() {

    it('CHAOS-801: 1000 sequential executions show no monotonic heap growth', async function() {
        this.timeout(120000);
        const vm = createVM();
        const tracker = new MemoryTracker();
        const ITERATIONS = 1000;
        const SAMPLE_INTERVAL = 100;
        const WARMUP = 100;

        const code = `module.exports = function(xchain) {
            xchain.state.set('counter', xchain.getInputParam(0));
            return 'done';
        };`;

        // Warmup phase — let V8/Node stabilize
        for (let i = 0; i < WARMUP; i++) {
            await execute(vm, code, { params: [String(i)] });
        }

        if (global.gc) global.gc();
        tracker.snapshot('post_warmup');

        // Main measurement phase
        for (let i = 0; i < ITERATIONS; i++) {
            await execute(vm, code, { params: [String(i)] });
            if ((i + 1) % SAMPLE_INTERVAL === 0) {
                if (global.gc) global.gc();
                tracker.snapshot('iter_' + (i + 1));
            }
        }

        if (global.gc) global.gc();
        tracker.snapshot('end');

        // Check for stability
        const growthMB = tracker.getHeapGrowth() / (1024 * 1024);
        const tolerance = global.gc ? 10 : 20; // Tighter tolerance with deterministic GC

        assert(tracker.isStable(tolerance * 1024 * 1024),
            'Memory grew by ' + growthMB.toFixed(1) + 'MB over ' + ITERATIONS +
            ' iterations (tolerance: ' + tolerance + 'MB)' +
            (global.gc ? '' : ' — run with --expose-gc for tighter bounds'));
    });

    it('CHAOS-802: 500 executions with emissions show no leak', async function() {
        this.timeout(120000);
        const vm = createVM();
        const tracker = new MemoryTracker();

        const code = `module.exports = function(xchain) {
            xchain.state.set('k', 'v');
            xchain.emit.send({ destination: 'test', tick: 'T', quantity: '1' });
            xchain.log('iteration');
            return 'done';
        };`;

        // Warmup
        for (let i = 0; i < 50; i++) await execute(vm, code);
        if (global.gc) global.gc();
        tracker.snapshot('start');

        for (let i = 0; i < 500; i++) {
            await execute(vm, code);
            if ((i + 1) % 100 === 0) {
                if (global.gc) global.gc();
                tracker.snapshot('iter_' + (i + 1));
            }
        }

        if (global.gc) global.gc();
        tracker.snapshot('end');

        const tolerance = global.gc ? 10 : 20;
        assert(tracker.isStable(tolerance * 1024 * 1024),
            'Memory leak detected with emissions: grew ' +
            (tracker.getHeapGrowth() / (1024 * 1024)).toFixed(1) + 'MB');
    });

    it('CHAOS-803: 500 mixed success/failure executions show no leak', async function() {
        this.timeout(120000);
        const vm = createVM({ gasCeiling: 500 });
        const tracker = new MemoryTracker();

        const goodCode = `module.exports = function(xchain) { return 'ok'; };`;
        const badCode = `module.exports = function(xchain) { while(true) {} };`;

        // Warmup
        for (let i = 0; i < 50; i++) {
            await execute(vm, i % 2 === 0 ? goodCode : badCode);
        }
        if (global.gc) global.gc();
        tracker.snapshot('start');

        for (let i = 0; i < 500; i++) {
            await execute(vm, i % 2 === 0 ? goodCode : badCode);
            if ((i + 1) % 100 === 0) {
                if (global.gc) global.gc();
                tracker.snapshot('iter_' + (i + 1));
            }
        }

        if (global.gc) global.gc();
        tracker.snapshot('end');

        const tolerance = global.gc ? 10 : 20;
        assert(tracker.isStable(tolerance * 1024 * 1024),
            'Memory leak detected with mixed execution: grew ' +
            (tracker.getHeapGrowth() / (1024 * 1024)).toFixed(1) + 'MB');
    });

    it('CHAOS-804: block cycling does not leak compilation cache', async function() {
        this.timeout(120000);
        const vm = createVM();
        const tracker = new MemoryTracker();

        const code = `module.exports = function(xchain) { return 'ok'; };`;

        // Warmup
        for (let b = 0; b < 10; b++) {
            vm.beginBlock();
            await execute(vm, code);
            vm.endBlock();
        }
        if (global.gc) global.gc();
        tracker.snapshot('start');

        // 200 block cycles with 5 executions each
        for (let b = 0; b < 200; b++) {
            vm.beginBlock();
            for (let i = 0; i < 5; i++) {
                await execute(vm, `/* block${b}_exec${i} */ module.exports = function(xchain) { return 'ok'; };`);
            }
            vm.endBlock();
            if ((b + 1) % 50 === 0) {
                if (global.gc) global.gc();
                tracker.snapshot('block_' + (b + 1));
            }
        }

        if (global.gc) global.gc();
        tracker.snapshot('end');

        const tolerance = global.gc ? 10 : 20;
        assert(tracker.isStable(tolerance * 1024 * 1024),
            'Block cycling leaked memory: grew ' +
            (tracker.getHeapGrowth() / (1024 * 1024)).toFixed(1) + 'MB');
    });
});
