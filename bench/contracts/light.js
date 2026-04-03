// Light benchmark: 2 state reads, 1 state write, basic math.
// Simulates a simple counter/getter contract.
module.exports = {
    default: function(xchain) {
        var count = xchain.state.get('count') || '0';
        var total = xchain.state.get('total') || '0';
        var newCount = xchain.math.add(count, '1');
        xchain.state.set('count', newCount);
        return newCount;
    }
};
