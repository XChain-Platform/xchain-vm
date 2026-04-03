// Contract that emits multiple action types in one execution
module.exports = {
    initialize: function(xchain) {
        xchain.state.set('token', xchain.getInputParam(0) || 'TEST');
    },
    sendAndDestroy: function(xchain) {
        var token = xchain.state.get('token');
        var dest = xchain.getInputParam(0);
        var sendAmt = xchain.getInputParam(1);
        var destroyAmt = xchain.getInputParam(2);

        xchain.emit.send({ destination: dest, tick: token, quantity: sendAmt });
        xchain.emit.destroy({ tick: token, quantity: destroyAmt });

        xchain.log('sent', sendAmt, 'destroyed', destroyAmt);
        return 'done';
    },
    conditionalAction: function(xchain) {
        var action = xchain.getInputParam(0);
        var token = xchain.state.get('token');

        if (action === 'send') {
            xchain.emit.send({
                destination: xchain.getInputParam(1),
                tick: token,
                quantity: xchain.getInputParam(2)
            });
            return 'sent';
        } else if (action === 'destroy') {
            xchain.emit.destroy({ tick: token, quantity: xchain.getInputParam(1) });
            return 'destroyed';
        } else {
            xchain.revert('unknown action: ' + action);
        }
    }
};
