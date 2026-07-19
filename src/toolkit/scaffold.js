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
 * XChain VM Toolkit: contract project scaffolder
 *
 * Generates a ready-to-run contract project: a contract file, a simulator
 * unit test, a package.json, and a README, in JavaScript or TypeScript. The
 * generated test drives the local simulator, so `npm test` in the new project
 * runs the contract with no regtest stack (on Node-22 Linux; see the runtime
 * note in simulator.js).
 *
 * buildScaffold() returns a plain { relPath: contents } map (pure, testable
 * without touching disk); writeScaffold() commits that map to a directory.
 ********************************************************************/
// @ts-nocheck

const fs = require('fs');
const path = require('path');

// A deterministic-gate-clean counter contract: state, input params, the
// bignumber math API (never native floats), require(), and a view method.
function contractJs() {
    return `// SPDX-License-Identifier: MIT
//
// __NAME__: an XChain counter contract (scaffolded by xchain-foundry).
//
// XChain contracts are plain JS run in a deterministic sandbox. They read and
// write a key/value state store, read inputs, and emit validated ACTIONs; they
// never mutate the ledger directly. Use xchain.math.* for all arithmetic (the
// sandbox strips native floats because IEEE-754 transcendentals fork across CPUs).

module.exports = {

    // Optional display metadata for wallets/explorers (advisory; never executed).
    abi: { version: 1, methods: {
        initialize: { summary: 'Set the starting count (constructor)', params: ['start'] },
        increment:  { summary: 'Add N (default 1) to the count', params: ['by'] },
        get:        { summary: 'Read the current count', params: [], view: true }
    } },

    // Constructor: the indexer runs this once at DEPLOY with CONSTRUCTOR_PARAMS.
    initialize: function(xchain) {
        var start = xchain.getInputParam(0);
        if (start === null || start === undefined) start = '0';
        xchain.require(xchain.math.gte(start, '0'), 'start must be >= 0');
        xchain.state.set('count', start);
        return start;
    },

    increment: function(xchain) {
        var by = xchain.getInputParam(0);
        if (by === null || by === undefined) by = '1';
        xchain.require(xchain.math.gt(by, '0'), 'increment must be positive');
        var current = xchain.state.get('count');
        if (current === null) current = '0';
        var next = xchain.math.add(current, by);
        xchain.state.set('count', next);
        return next;
    },

    get: function(xchain) {
        var current = xchain.state.get('count');
        return current === null ? '0' : current;
    }
};
`;
}

// The same contract in TypeScript. Types (the local interface + the parameter
// annotations) are ERASED by the toolkit's type-strip step, so the VM sees the
// identical JS above. Only erasable TS is used (no enums / namespaces / decorators).
function contractTs() {
    return `// SPDX-License-Identifier: MIT
//
// __NAME__: an XChain counter contract in TypeScript (scaffolded by xchain-foundry).
//
// Author in TypeScript for editor autocomplete and type-checking; the toolkit
// strips the annotations to the ES the VM accepts (types are erased, not
// down-levelled). Use xchain.math.* for all arithmetic.

// Minimal shape of the in-contract gateway. In a real project, import the
// published \`xchain\` contract types instead of redeclaring them.
interface XChainState {
    get(key: string): string | null;
    set(key: string, value: string): void;
    has(key: string): boolean;
    delete(key: string): void;
}
interface XChainMath {
    add(a: string, b: string): string;
    gt(a: string, b: string): boolean;
    gte(a: string, b: string): boolean;
}
interface XChain {
    state: XChainState;
    math: XChainMath;
    getInputParam(i: number): string | null;
    require(cond: boolean, reason: string): void;
}

module.exports = {

    abi: { version: 1, methods: {
        initialize: { summary: 'Set the starting count (constructor)', params: ['start'] },
        increment:  { summary: 'Add N (default 1) to the count', params: ['by'] },
        get:        { summary: 'Read the current count', params: [], view: true }
    } },

    initialize: function(xchain: XChain): string {
        let start = xchain.getInputParam(0);
        if (start === null || start === undefined) start = '0';
        xchain.require(xchain.math.gte(start, '0'), 'start must be >= 0');
        xchain.state.set('count', start);
        return start;
    },

    increment: function(xchain: XChain): string {
        let by = xchain.getInputParam(0);
        if (by === null || by === undefined) by = '1';
        xchain.require(xchain.math.gt(by, '0'), 'increment must be positive');
        let current = xchain.state.get('count');
        if (current === null) current = '0';
        const next = xchain.math.add(current, by);
        xchain.state.set('count', next);
        return next;
    },

    get: function(xchain: XChain): string {
        const current = xchain.state.get('count');
        return current === null ? '0' : current;
    }
};
`;
}

// Simulator-driven Mocha test. Skips (does not fail) when isolated-vm cannot
// load on the host, matching the VM's own smoke-suite convention, so the file
// is safe to `npm test` anywhere and runs for real on Node-22 Linux.
function testJs(name, contractFile) {
    return `// ${name} contract test: driven by the xchain-foundry local simulator.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let ContractSimulator = null;
try {
    ({ ContractSimulator } = require('xchain-vm/toolkit'));
    // Probe the isolate: on a host where isolated-vm cannot dlopen (e.g. macOS),
    // constructing a simulator throws; skip rather than fail.
    new ContractSimulator().close();
} catch (e) {
    console.log('Skipping ${name} simulator tests (isolated-vm unavailable): ' + e.message);
    ContractSimulator = null;
}

const CONTRACT = fs.readFileSync(path.join(__dirname, '..', 'contracts', '${contractFile}'), 'utf8');
const IS_TS = '${contractFile}'.endsWith('.ts');

(ContractSimulator ? describe : describe.skip)('${name}', function() {
    this.timeout(30000);
    let sim, addr;

    beforeEach(async function() {
        sim = new ContractSimulator({ coin: 'BTC' });
        const dep = await sim.deploy(CONTRACT, {
            filename: '${contractFile}',
            constructorParams: ['5']
        });
        addr = dep.contractIndex;
        assert.strictEqual(dep.initResult.success, true, 'deploy/initialize should succeed');
    });

    afterEach(async function() { if (sim) await sim.close(); });

    it('initializes the count from the constructor param', async function() {
        const res = await sim.call(addr, 'get', []);
        assert.strictEqual(res.success, true);
        assert.strictEqual(JSON.parse(res.returnValue), '5');
    });

    it('increments and persists state across calls', async function() {
        await sim.call(addr, 'increment', ['3']);
        const res = await sim.call(addr, 'increment', ['2']);
        assert.strictEqual(JSON.parse(res.returnValue), '10');
        assert.strictEqual(sim.getStateValue(addr, 'count'), '10');
        assert(res.gasUsed > 0, 'should consume gas');
    });

    it('reverts on a non-positive increment (nothing committed)', async function() {
        const before = sim.getStateValue(addr, 'count');
        const res = await sim.call(addr, 'increment', ['0']);
        assert.strictEqual(res.success, false);
        assert.strictEqual(sim.getStateValue(addr, 'count'), before, 'state unchanged on revert');
    });
});
`;
}

function packageJson(name, useTs) {
    const pkg = {
        name: name,
        version: '0.1.0',
        private: true,
        description: 'An XChain smart contract (scaffolded by xchain-foundry)',
        scripts: {
            test: 'mocha --timeout 30000 "test/**/*.test.js"',
            lint: 'xchain-foundry lint contracts/*',
            simulate: 'xchain-foundry simulate'
        },
        devDependencies: {
            'xchain-vm': '*',
            mocha: '^10'
        }
    };
    if (useTs) pkg.devDependencies.typescript = '^5';
    return JSON.stringify(pkg, null, 2) + '\n';
}

function readme(name, useTs, contractFile) {
    return `# ${name}

An XChain smart contract, scaffolded by \`xchain-foundry\`.

## Layout

- \`contracts/${contractFile}\` - the contract source${useTs ? ' (TypeScript; types are stripped to ES the VM accepts)' : ''}
- \`test/${name}.test.js\` - simulator-driven unit tests

## Develop

\`\`\`bash
xchain-foundry lint contracts/*        # static determinism gate + gas estimate (any OS)
npm test                               # run the contract in the local simulator (Node 22, Linux)
\`\`\`

The lint gate runs on any machine (no isolated-vm needed). Actually executing
the contract (the simulator and \`npm test\`) needs the isolated-vm binding,
which loads on Node 22 / Linux.

## Deploy

Lint clean here means the DEPLOY passes the indexer's determinism gate. Encode
the DEPLOY with \`xchain-sdk\` / \`xchain-encoder\` and broadcast it; fund the
contract with a separate DEPOSIT (there is no msg.value on XChain).
`;
}

/**
 * Build the scaffold file map (pure; does not touch disk).
 * @param {object} opts
 * @param {string} opts.name         - project/contract name
 * @param {boolean} [opts.typescript] - emit a .ts contract
 * @returns {{ files: Object<string,string>, contractFile: string }}
 */
function buildScaffold(opts = {}) {
    const name = String(opts.name || 'my-contract').trim();
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
        throw new Error('invalid project name: ' + JSON.stringify(name) +
            ' (use letters, digits, . _ -)');
    }
    const useTs = !!opts.typescript;
    const contractFile = name + (useTs ? '.ts' : '.js');
    const contractSrc = (useTs ? contractTs() : contractJs()).replace(/__NAME__/g, name);

    const files = {};
    files['contracts/' + contractFile] = contractSrc;
    files['test/' + name + '.test.js'] = testJs(name, contractFile);
    files['package.json'] = packageJson(name, useTs);
    files['README.md'] = readme(name, useTs, contractFile);
    return { files, contractFile };
}

/**
 * Write a scaffold to disk under destDir.
 * @param {string} destDir
 * @param {object} opts - see buildScaffold
 * @param {boolean} [opts.force] - overwrite existing files
 * @returns {{ dir:string, written:string[], contractFile:string }}
 */
function writeScaffold(destDir, opts = {}) {
    const { files, contractFile } = buildScaffold(opts);
    const written = [];
    for (const rel of Object.keys(files)) {
        const abs = path.join(destDir, rel);
        if (fs.existsSync(abs) && !opts.force) {
            throw new Error('refusing to overwrite existing file (pass force): ' + abs);
        }
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, files[rel]);
        written.push(rel);
    }
    return { dir: destDir, written, contractFile };
}

module.exports = { buildScaffold, writeScaffold };
