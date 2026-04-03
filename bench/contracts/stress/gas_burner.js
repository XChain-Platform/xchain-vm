// Stress benchmark: tight loop burning gas toward the ceiling.
// Tests gas exhaustion detection latency and resource cleanup.
module.exports = function(xchain) {
    var sum = '0';
    for (var i = 0; i < 1000000; i++) {
        sum = xchain.math.add(sum, '1');
    }
    return sum;
};
