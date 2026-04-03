// Stress benchmark: 500+ state operations.
// Tests state management performance and dirty tracking overhead.
module.exports = function(xchain) {
    var count = 500;
    // Write 500 keys
    for (var i = 0; i < count; i++) {
        xchain.state.set('key_' + i, 'value_' + i + '_data');
    }
    // Read them all back
    var total = 0;
    for (var i = 0; i < count; i++) {
        var v = xchain.state.get('key_' + i);
        if (v) total++;
    }
    return total;
};
