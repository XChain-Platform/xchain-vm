// 64KB of deeply nested binary expressions for compilation benchmark.
// This contract is designed to stress-test the parser and compiler.
module.exports = function(xchain) {
    var a = 1;
    // Deeply nested additions (generated pattern)
    var r = a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a + a;
    var s = r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r + r;
    var t = s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s + s;
    xchain.log('result:', String(t));
    return String(t);
};
