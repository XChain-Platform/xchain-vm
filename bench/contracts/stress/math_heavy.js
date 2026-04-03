// Stress benchmark: 200+ bignumber operations.
// Tests mathjs bignumber throughput via the gateway boundary.
module.exports = function(xchain) {
    var a = '1000000000000000000';
    var b = '999999999999999999';
    var result = '0';
    for (var i = 0; i < 200; i++) {
        var sum  = xchain.math.add(a, b);
        var diff = xchain.math.subtract(sum, a);
        var prod = xchain.math.multiply(diff, '2');
        var quot = xchain.math.divide(prod, '3');
        result   = xchain.math.add(result, quot);
        a = xchain.math.add(a, '1');
    }
    return result;
};
