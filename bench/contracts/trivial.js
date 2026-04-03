// Trivial benchmark: return a constant, no state or emit ops.
// Measures pure VM overhead: isolate creation, sandbox, gateway injection, metering.
module.exports = function(xchain) {
    return 42;
};
