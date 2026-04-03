// Simplest possible contract: single function export
module.exports = function(xchain) {
    xchain.log('executed');
    return 'hello from contract';
};
