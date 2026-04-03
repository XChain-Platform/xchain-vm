// Should hit emission limit at 51st emit
module.exports = function(xchain) {
    for (var i = 0; i < 51; i++) {
        xchain.emit.send({
            destination: 'addr_' + i,
            tick: 'TEST',
            quantity: '1'
        });
    }
};
