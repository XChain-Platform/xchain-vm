// Medium benchmark: AMM-like swap logic.
// 5-8 state ops, 2 emissions, several math operations.
module.exports = {
    default: function(xchain) {
        var reserveA = xchain.state.get('reserveA') || '1000000';
        var reserveB = xchain.state.get('reserveB') || '500000';
        var feeRate  = xchain.state.get('feeRate')  || '3';
        var txCount  = xchain.state.get('txCount')  || '0';

        var inputAmount = xchain.getInputParam(0) || '1000';

        // Constant-product AMM: outputAmount = (reserveB * inputAmount * (1000 - fee)) / (reserveA * 1000 + inputAmount * (1000 - fee))
        var feeMultiplier = xchain.math.subtract('1000', feeRate);
        var inputWithFee  = xchain.math.multiply(inputAmount, feeMultiplier);
        var numerator     = xchain.math.multiply(reserveB, inputWithFee);
        var denominator   = xchain.math.add(
            xchain.math.multiply(reserveA, '1000'),
            inputWithFee
        );
        var outputAmount = xchain.math.divide(numerator, denominator);

        // Update reserves
        var newReserveA = xchain.math.add(reserveA, inputAmount);
        var newReserveB = xchain.math.subtract(reserveB, outputAmount);
        xchain.state.set('reserveA', newReserveA);
        xchain.state.set('reserveB', newReserveB);
        xchain.state.set('txCount', xchain.math.add(txCount, '1'));

        // Emit transfer actions
        xchain.emit.send({ destination: xchain.getSourceAddress(), tick: 'TOKENB', quantity: outputAmount });
        xchain.emit.send({ destination: xchain.getContractAddress(), tick: 'TOKENA', quantity: inputAmount });

        return outputAmount;
    }
};
