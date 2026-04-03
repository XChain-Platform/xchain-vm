// Simple contract: stores config on init, sends tokens on demand
module.exports = {
    initialize: function(xchain) {
        xchain.state.set('owner', xchain.getSourceAddress());
        xchain.state.set('token', xchain.getInputParam(0) || 'TEST');
        xchain.state.set('sends', '0');
    },
    send: function(xchain) {
        var dest   = xchain.getInputParam(0);
        var amount = xchain.getInputParam(1);
        xchain.require(dest, 'destination required');
        xchain.require(amount, 'amount required');

        xchain.emit.send({
            destination: dest,
            tick: xchain.state.get('token'),
            quantity: amount
        });

        var sends = xchain.state.get('sends') || '0';
        xchain.state.set('sends', xchain.math.add(sends, '1'));
        xchain.log('sent', amount, 'to', dest);
        return 'ok';
    },
    getSends: function(xchain) {
        return xchain.state.get('sends');
    }
};
