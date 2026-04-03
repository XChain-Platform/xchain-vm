// Tests oracle gateway API
module.exports = {
    checkPrice: function(xchain) {
        var price = xchain.oracle.getPrice('BTC/USD');
        var age = xchain.oracle.getSnapshotAge();

        xchain.log('price:', JSON.stringify(price));
        xchain.log('age:', String(age));

        // In Track A (stub), price is null and age is MAX_SAFE_INTEGER
        if (price === null) {
            xchain.log('oracle not available');
            return 'no oracle';
        }

        xchain.require(age < 1000, 'oracle data too stale');
        return price;
    }
};
