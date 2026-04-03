// Simple contract: reads state, emits one SEND
module.exports = {
    initialize: function(xchain) {
        xchain.state.set('owner', xchain.getSourceAddress());
        xchain.state.set('token', 'TEST');
    },
    send: function(xchain) {
        var destination = xchain.getInputParam(0);
        var amount = xchain.getInputParam(1);
        var token = xchain.state.get('token');

        xchain.require(destination, 'destination required');
        xchain.require(amount, 'amount required');

        xchain.emit.send({
            destination: destination,
            tick: token,
            quantity: amount
        });

        xchain.log('sent', amount, token, 'to', destination);
        return 'sent';
    }
};
