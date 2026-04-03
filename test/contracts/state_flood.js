// Should hit state key limit at 10001st key
module.exports = function(xchain) {
    for (var i = 0; i < 10001; i++) {
        xchain.state.set('key_' + i, 'value');
    }
};
