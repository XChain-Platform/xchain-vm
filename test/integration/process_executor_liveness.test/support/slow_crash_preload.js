// Preload for a forked worker: block for XVM_TEST_CRASH_MS before the worker
// loads, then exit(1). The worker never signals ready and dies just past the
// two-second age the executor once used as its only spawn-failure window.
// @ts-nocheck
const ms = Number(process.env.XVM_TEST_CRASH_MS || 2100);
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
process.exit(1);
