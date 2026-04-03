// Demonstrates why xchain.math is needed
module.exports = function(xchain) {
    // Native floating-point — non-deterministic across V8 versions
    var nativeResult = 0.1 + 0.2;
    xchain.log('native 0.1 + 0.2 =', String(nativeResult));

    // xchain.math — deterministic everywhere
    var safeResult = xchain.math.add('0.1', '0.2');
    xchain.log('xchain.math 0.1 + 0.2 =', safeResult);

    return { native: String(nativeResult), safe: safeResult };
};
