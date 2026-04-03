// AMM swap contract: constant product market maker
module.exports = {
    initialize: function(xchain) {
        xchain.state.set('tokenA', xchain.getInputParam(0));
        xchain.state.set('tokenB', xchain.getInputParam(1));
        xchain.state.set('reserveA', '0');
        xchain.state.set('reserveB', '0');
        xchain.state.set('owner', xchain.getSourceAddress());
    },
    addLiquidity: function(xchain) {
        var amountA = xchain.getInputParam(0);
        var amountB = xchain.getInputParam(1);
        xchain.require(amountA && amountB, 'amounts required');

        var reserveA = xchain.state.get('reserveA');
        var reserveB = xchain.state.get('reserveB');

        xchain.state.set('reserveA', xchain.math.add(reserveA, amountA));
        xchain.state.set('reserveB', xchain.math.add(reserveB, amountB));
    },
    swap: function(xchain) {
        var inputAmount = xchain.getInputParam(0);
        var inputToken  = xchain.getInputParam(1);
        xchain.require(inputAmount, 'amount required');
        xchain.require(xchain.math.gt(inputAmount, '0'), 'amount must be positive');

        var tokenA = xchain.state.get('tokenA');
        var tokenB = xchain.state.get('tokenB');
        var reserveA = xchain.state.get('reserveA');
        var reserveB = xchain.state.get('reserveB');

        xchain.require(xchain.math.gt(reserveA, '0') && xchain.math.gt(reserveB, '0'), 'no liquidity');

        var outputToken, outputAmount, newReserveA, newReserveB;

        if (inputToken === tokenA) {
            outputToken = tokenB;
            // constant product: (reserveA + input) * (reserveB - output) = reserveA * reserveB
            var k = xchain.math.multiply(reserveA, reserveB);
            var newResA = xchain.math.add(reserveA, inputAmount);
            var newResB = xchain.math.divide(k, newResA);
            outputAmount = xchain.math.subtract(reserveB, newResB);
            newReserveA = newResA;
            newReserveB = newResB;
        } else {
            outputToken = tokenA;
            var k = xchain.math.multiply(reserveA, reserveB);
            var newResB = xchain.math.add(reserveB, inputAmount);
            var newResA = xchain.math.divide(k, newResB);
            outputAmount = xchain.math.subtract(reserveA, newResA);
            newReserveA = newResA;
            newReserveB = newResB;
        }

        xchain.require(xchain.math.gt(outputAmount, '0'), 'insufficient output');

        xchain.state.set('reserveA', newReserveA);
        xchain.state.set('reserveB', newReserveB);

        // Send output to caller
        xchain.emit.send({
            destination: xchain.getSourceAddress(),
            tick: outputToken,
            quantity: outputAmount
        });

        return outputAmount;
    }
};
