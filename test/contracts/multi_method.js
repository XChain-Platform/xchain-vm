// Multi-method contract: tests method routing
module.exports = {
    initialize: function(xchain) {
        xchain.state.set('owner', xchain.getSourceAddress());
        xchain.state.set('counter', '0');
        xchain.state.set('name', 'test-contract');
    },
    increment: function(xchain) {
        var count = xchain.state.get('counter') || '0';
        count = xchain.math.add(count, '1');
        xchain.state.set('counter', count);
        return count;
    },
    getCount: function(xchain) {
        return xchain.state.get('counter');
    },
    getName: function(xchain) {
        return xchain.state.get('name');
    },
    setName: function(xchain) {
        var newName = xchain.getInputParam(0);
        xchain.require(newName, 'name required');
        xchain.require(xchain.getSourceAddress() === xchain.state.get('owner'), 'only owner');
        xchain.state.set('name', newName);
    }
};
