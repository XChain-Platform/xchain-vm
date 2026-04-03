// Multi-method contract for method routing tests
module.exports = {
    initialize: function(xchain) {
        xchain.state.set('owner', xchain.getSourceAddress());
        xchain.state.set('value', '0');
    },
    setValue: function(xchain) {
        var val = xchain.getInputParam(0);
        xchain.require(val !== null, 'value required');
        xchain.state.set('value', val);
        return val;
    },
    getValue: function(xchain) {
        return xchain.state.get('value');
    },
    onlyOwner: function(xchain) {
        var owner = xchain.state.get('owner');
        xchain.require(xchain.getSourceAddress() === owner, 'not owner');
        return 'authorized';
    }
};
