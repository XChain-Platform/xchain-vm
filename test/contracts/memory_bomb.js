// Should hit memory limit
module.exports = function(xchain) {
    var arrays = [];
    for (var i = 0; i < 1000000; i++) {
        arrays.push(new Array(10000).fill('x'));
    }
};
