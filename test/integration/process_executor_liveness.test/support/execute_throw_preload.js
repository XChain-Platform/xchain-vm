// Preload for a forked worker: supply an isolate-free VM whose first execute
// rejects with a plain test error and whose next execute returns normally.
// @ts-nocheck
if (process.env.XVM_TEST_EXECUTE_THROW === '1') {
    const Module = require('module');
    const path = require('path');
    const { isHostFaultHaltActive } =
        require('../../../../src/index/host_fault_halt_heights.js');
    const { pkg3CoinFromAddress } = require('../../../../src/index/runtime/activations.js');
    const workerPath = path.resolve(__dirname, '../../../../src/vm-worker.js');
    const indexPath = path.resolve(__dirname, '../../../../src/index.js');
    const load = Module._load;
    let thrown = false;

    class InjectedVM {
        beginBlock() {}
        endBlock() {}
        async execute() {
            if (!thrown) {
                thrown = true;
                throw new Error('injected execute throw');
            }
            return {
                success: true, error: null, gasUsed: 1, returnValue: '"r2"',
                stateChanges: [], stateDeletes: [], emittedActions: [], logs: []
            };
        }
    }

    InjectedVM.isHostFaultHaltActive = isHostFaultHaltActive;
    InjectedVM.pkg3CoinFromAddress = pkg3CoinFromAddress;

    Module._load = function injectedLoad(request, parent, isMain) {
        if (parent && parent.filename === workerPath &&
            Module._resolveFilename(request, parent, isMain) === indexPath) return InjectedVM;
        return load.apply(this, arguments);
    };
}
