/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Shared setup for the executor liveness tests: drive ProcessExecutor
 * directly through failed forks, pre-ready worker deaths and bad replies.
 ********************************************************************/
// @ts-nocheck

const path = require('path');
const cp = require('child_process');
const S = require('../../process_executor.test/support/executor_setup.js');

const SRC = path.join(__dirname, '..', '..', '..', '..', 'src');
const PE_PATH = path.join(SRC, 'process-executor.js');
const { HostFaultError } = require(path.join(SRC, 'errors.js'));
const ProcessExecutor = require(PE_PATH);

// A path no fork can exec: fork() then fails with ENOENT, which Node reports
// through 'error' and 'close' and never 'exit' (the same path as EACCES,
// EAGAIN, EMFILE and ENFILE).
const MISSING_NODE = path.join(__dirname, 'no-such-dir', 'node');

// A separate copy of process-executor.js whose `fork` binding goes through
// forkHook, so a test can make fork() throw synchronously, which is what Node
// does for errnos outside its asynchronously reported five (ENOMEM and kin).
const forkHook = { throwErr: null };
function loadHookedExecutor() {
    const realFork = cp.fork;
    delete require.cache[require.resolve(PE_PATH)];
    cp.fork = function hookedFork(...args) {
        if (forkHook.throwErr) throw forkHook.throwErr;
        return realFork.apply(this, args);
    };
    try { return require(PE_PATH); }
    finally {
        cp.fork = realFork;
        delete require.cache[require.resolve(PE_PATH)];
        require(PE_PATH); // restore the canonical cached copy for other tests
    }
}

function enomem() {
    return Object.assign(new Error('spawn ENOMEM'), { code: 'ENOMEM', errno: -12, syscall: 'spawn' });
}

function newExec(Ctor) {
    return new (Ctor || ProcessExecutor)({ gasSchedule: S.GAS_SCHEDULE, gasCeiling: S.GAS_CEILING, limits: S.LIMITS });
}

// Run with process.execPath swapped; fork() reads it at call time.
async function withExecPath(p, fn) {
    const saved = process.execPath;
    process.execPath = p;
    try { return await fn(); } finally { process.execPath = saved; }
}

// Spawn children with an extra --require preload (fake worker behavior).
async function withPreload(file, env, fn) {
    const savedArgv = process.execArgv;
    const savedEnv = {};
    for (const k of Object.keys(env)) { savedEnv[k] = process.env[k]; process.env[k] = env[k]; }
    process.execArgv = savedArgv.concat(['--require', path.join(__dirname, file)]);
    try { return await fn(); } finally {
        process.execArgv = savedArgv;
        for (const k of Object.keys(env)) {
            if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
        }
    }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms, step) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (pred()) return true; await sleep(step || 10); }
    return pred();
}

// Records how a promise settled without awaiting it.
function track(p) {
    const t = { state: 'pending', value: undefined };
    p.then((v) => { t.state = 'resolved'; t.value = v; }, (e) => { t.state = 'rejected'; t.value = e; });
    return t;
}

// Kill the current never-ready worker n times, waiting for each replacement.
async function killPreReady(exec, n) {
    for (let k = 0; k < n; k++) {
        const c = exec._child;
        S.assert.ok(c && !exec._sawReady, 'worker must be pre-ready at kill ' + k);
        c.kill('SIGKILL');
        await waitFor(() => exec._child !== c || exec._broken, 3000, 2);
    }
}

const quick = (i) => Object.assign({}, S.BASE, { code: `module.exports = function(){ return 'r${i}'; };` });
const busy = (i) => Object.assign({}, S.BASE,
    { code: `module.exports = function(){ var s=0; for(var k=0;k<60000;k++){ s+=k%7; } return 'c${i}:'+s; };` });

function isHostFault(e) {
    return e instanceof HostFaultError && e.code === 'EXECUTOR_UNAVAILABLE';
}

module.exports = Object.assign({}, S, {
    ProcessExecutor, HostFaultError, MISSING_NODE, forkHook, loadHookedExecutor, enomem, newExec,
    withExecPath, withPreload, sleep, waitFor, track, killPreReady, quick, busy, isHostFault
});
