// Standalone script: a contract kills its worker (SIGABRT) while the respawn's
// fork() throws synchronously (ENOMEM). The respawn runs inside the worker's
// exit handling, so a throw that escapes reaches the host as an uncaught
// exception. Prints one JSON line; exits 0 if the host saw none, 3 if it did.
// @ts-nocheck
const H = require('./liveness_setup.js');

const PE = H.loadHookedExecutor();
const exec = H.newExec(PE);
let uncaught = null;
process.on('uncaughtException', (e) => { uncaught = e; });
(async () => {
    exec.beginBlock();
    await exec.execute(H.quick(1));
    const victim = H.track(exec.execute(H.busy(2)));
    const queued = H.track(exec.execute(H.quick(3)));
    H.forkHook.throwErr = H.enomem();
    exec._child.kill('SIGABRT');
    await H.waitFor(() => queued.state !== 'pending' && victim.state !== 'pending', 5000);
    H.forkHook.throwErr = null;
    console.log(JSON.stringify({
        uncaught: uncaught && (uncaught.code || uncaught.message),
        victim: victim.state,
        victimError: victim.value && victim.value.error,
        queued: queued.state,
        queuedHostFault: H.isHostFault(queued.value),
        broken: exec._broken
    }));
    await exec.shutdown();
    process.exit(uncaught ? 3 : 0);
})();
