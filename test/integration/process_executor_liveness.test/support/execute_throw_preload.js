// Preload for a forked worker: make execute reject with a plain test error.
// @ts-nocheck
if (process.env.XVM_TEST_EXECUTE_THROW === '1') {
    const XChainVM = require('../../../../src/index.js');
    XChainVM.prototype.execute = async function execute() {
        throw new Error('injected execute throw');
    };
}
