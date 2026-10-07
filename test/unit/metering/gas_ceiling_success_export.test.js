// @ts-nocheck

const assert = require('assert');
const vmModule = require('../../../src/index.js');
const GasTracker = require('../../../src/gas.js');

describe('gas-ceiling success gate on the module surface', function () {
    it('exposes the activation map and predicate the tracker owns', function () {
        assert.strictEqual(vmModule.GAS_CEILING_SUCCESS_ACTIVATION, GasTracker.GAS_CEILING_SUCCESS_ACTIVATION);
        assert.strictEqual(vmModule.isGasCeilingSuccessActive, GasTracker.isGasCeilingSuccessActive);
    });

    it('resolves per network from the exported predicate', function () {
        assert.deepStrictEqual({ ...vmModule.GAS_CEILING_SUCCESS_ACTIVATION }, { mainnet: null, testnet: null, regtest: 0 });
        assert.strictEqual(vmModule.isGasCeilingSuccessActive('regtest', 0), true);
        for (const net of ['mainnet', 'testnet', 'nosuchnet', undefined]) {
            assert.strictEqual(vmModule.isGasCeilingSuccessActive(net, 4000000000), false, String(net));
        }
    });
});
