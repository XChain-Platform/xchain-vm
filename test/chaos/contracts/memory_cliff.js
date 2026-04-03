// Parameterized memory allocator for chaos testing.
// Allocates chunks of ~512KB each. Use params[0] to control count.
// With maxMemory=8MB: chunks=10 should succeed, chunks=20 should OOM.
module.exports = function(xchain) {
    var chunks = parseInt(xchain.getInputParam(0) || '10', 10);
    var arrays = [];
    for (var i = 0; i < chunks; i++) {
        // Each chunk: 65536 elements * ~8 bytes ≈ 512KB
        arrays.push(new Array(65536).fill('x'));
    }
    xchain.state.set('allocated', String(chunks));
    return 'ok:' + chunks;
};
