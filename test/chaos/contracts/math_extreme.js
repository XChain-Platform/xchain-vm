// Parameterized math operation executor for chaos testing.
// params[0] = operation (add, subtract, multiply, divide, mod, compare, accumulated)
// params[1] = operand a
// params[2] = operand b
// params[3] = iterations (for accumulated mode, default 100)
module.exports = function(xchain) {
    var op = xchain.getInputParam(0) || 'add';
    var a  = xchain.getInputParam(1) || '0';
    var b  = xchain.getInputParam(2) || '0';

    if (op === 'accumulated') {
        var iterations = parseInt(xchain.getInputParam(3) || '100', 10);
        var acc = '0';
        for (var i = 0; i < iterations; i++) {
            acc = xchain.math.add(acc, a);
        }
        return acc;
    }

    if (op === 'add')      return xchain.math.add(a, b);
    if (op === 'subtract') return xchain.math.subtract(a, b);
    if (op === 'multiply') return xchain.math.multiply(a, b);
    if (op === 'divide')   return xchain.math.divide(a, b);
    if (op === 'mod')      return xchain.math.mod(a, b);
    if (op === 'compare')  return String(xchain.math.compare(a, b));
    if (op === 'isZero')   return String(xchain.math.isZero(a));
    if (op === 'abs')      return xchain.math.abs(a);

    xchain.revert('unknown op: ' + op);
};
