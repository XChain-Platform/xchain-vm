//  doctrine test-coverage program: coverage for src/vm-worker.js. The
// worker is the child side of process-executor: it holds one XChainVM and runs
// executions sequentially. Loading it here would pull in isolated-vm (native,
// Linux-only in this repo), so this pins the worker's determinism-critical
// contract by compiling and statically inspecting the module instead of
// forking it: it must wire the IPC message handler, force in-process mode so
// it never recurses into another fork, exit on disconnect, and touch no
// network primitive (a socket would break execution determinism).

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', '..', 'src', 'vm-worker.js');
const source = fs.readFileSync(SRC, 'utf8').replace(/^#!.*\n/, '');

describe('vm-worker (static contract)', function () {
    it('is syntactically valid JavaScript (compiles without executing)', function () {
        assert.doesNotThrow(() => new vm.Script(source, { filename: 'vm-worker.js' }));
    });

    it('registers a process IPC message handler', function () {
        assert.ok(/process\.on\(\s*['"]message['"]/.test(source),
            'worker must handle IPC messages from the parent executor');
    });

    it('handles the init and beginBlock control messages', function () {
        assert.ok(/['"]init['"]/.test(source), 'must handle init');
        assert.ok(/['"]beginBlock['"]/.test(source), 'must handle beginBlock');
    });

    it('forces in-process execution so it never recurses into another fork', function () {
        assert.ok(/execution:\s*['"]in-process['"]/.test(source));
    });

    it('exits the process on IPC disconnect', function () {
        assert.ok(/process\.on\(\s*['"]disconnect['"]/.test(source));
    });

    it('opens no network primitive (determinism guard)', function () {
        for (const mod of ['http', 'https', 'net', 'dgram', 'dns', 'tls']) {
            assert.ok(!new RegExp(`require\\(\\s*['"]${mod}['"]`).test(source),
                `worker must not require ${mod}`);
        }
    });
});
