#!/usr/bin/env node
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
 * xchain-foundry: local developer toolkit CLI for XChain contracts.
 *
 *   xchain-foundry new <name> [--ts] [--dir DIR] [--force]
 *       Scaffold a contract project (contract + simulator test + README).
 *
 *   xchain-foundry lint <file...> [--json]
 *       Static determinism gate + gas estimate. No isolated-vm needed, so it
 *       runs on any OS/CPU with millisecond feedback. .ts files are stripped
 *       to JS first. Exit 1 if any file has a deploy-blocking error.
 *
 *   xchain-foundry gas <file...>
 *       Print only the heuristic gas-budget estimate for each file.
 *
 *   xchain-foundry simulate <file> [--method M] [--params a,b]
 *                                   [--constructor a,b] [--caller ADDR]
 *                                   [--execution in-process|subprocess]
 *       Deploy the contract in the in-memory simulator and run one method,
 *       printing the result (success, returnValue, gasUsed, emitted actions,
 *       state changes). Requires the isolated-vm binding (Node 22 / Linux).
 *       --execution subprocess runs the mode the indexer runs: slower (one
 *       forked worker) but it reports the chain's out_of_resource result for a
 *       contract that aborts the JS engine, instead of taking this process down.
 *
 *   xchain-foundry describe "<what the contract should do>" [--ts]
 *       AI-assisted authoring (Tier 3). Prints the ready-to-use LLM prompt
 *       (system + user) that turns your English brief into a gate-clean XChain
 *       contract. Feed it to any model. No network calls, no key needed.
 *
 *   xchain-foundry from-solidity <file.sol> [--ts]
 *       Same, but prints the prompt to translate a Solidity contract into the
 *       XChain equivalent with the differences explained.
 *
 *   xchain-foundry validate <response-file> [--ts] [--json]
 *       Close the loop: extract the contract from a model's reply (use `-` for
 *       stdin), run it through the deploy determinism gate, and on failure print
 *       the repair prompt to paste back to the model. Any OS/CPU (no isolate).
 *
 * Exit codes: 0 ok · 1 blocking lint error / failed simulate/validate · 2 usage.
 ********************************************************************/
// @ts-nocheck

const fs = require('fs');
const path = require('path');

const { runGate } = require('../src/toolkit/gate.js');
const { toContractJs } = require('../src/toolkit/transpile.js');
const { writeScaffold } = require('../src/toolkit/scaffold.js');
const {
    buildAuthoringPrompt,
    buildRepairPrompt,
    extractContractCode
} = require('../src/toolkit/authoring.js');

function usage(msg) {
    if (msg) process.stderr.write('error: ' + msg + '\n\n');
    process.stderr.write(
        'Usage:\n' +
        '  xchain-foundry new <name> [--ts] [--dir DIR] [--force]\n' +
        '  xchain-foundry lint <file...> [--json]\n' +
        '  xchain-foundry gas <file...>\n' +
        '  xchain-foundry simulate <file> [--method M] [--params a,b] [--constructor a,b] [--caller ADDR]\n' +
        '                                 [--execution in-process|subprocess]\n' +
        '  xchain-foundry describe "<what it should do>" [--ts] [--json]\n' +
        '  xchain-foundry from-solidity <file.sol> [--ts] [--json]\n' +
        '  xchain-foundry validate <response-file|-> [--ts] [--json]\n'
    );
    process.exit(2);
}

// Minimal flag parser: collects --k v / --k=v / --bool, returns { _:positional, flags }.
function parseArgs(argv) {
    const flags = {};
    const positional = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) {
            const eq = a.indexOf('=');
            if (eq >= 0) {
                flags[a.slice(2, eq)] = a.slice(eq + 1);
            } else {
                const key = a.slice(2);
                const next = argv[i + 1];
                if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i++; }
                else flags[key] = true;
            }
        } else {
            positional.push(a);
        }
    }
    return { _: positional, flags };
}

function readSource(file) {
    const raw = fs.readFileSync(file, 'utf8');
    return toContractJs(raw, file);
}

function splitList(v) {
    if (v === undefined || v === true || v === '') return [];
    return String(v).split(',');
}

// ---- commands --------------------------------------------------------------

function cmdNew(args) {
    const name = args._[0];
    if (!name) usage('new requires a <name>');
    const useTs = !!(args.flags.ts || args.flags.typescript);
    const dir = args.flags.dir ? String(args.flags.dir) : path.join(process.cwd(), name);
    let res;
    try {
        res = writeScaffold(dir, { name, typescript: useTs, force: !!args.flags.force });
    } catch (e) {
        process.stderr.write('error: ' + e.message + '\n');
        process.exit(1);
    }
    process.stdout.write('Scaffolded ' + name + (useTs ? ' (TypeScript)' : '') + ' at ' + res.dir + '\n');
    for (const f of res.written) process.stdout.write('  ' + f + '\n');
    process.stdout.write('\nNext:\n  cd ' + name + '\n' +
        '  xchain-foundry lint contracts/' + res.contractFile + '\n  npm install && npm test\n');
    process.exit(0);
}

function cmdLint(args, gasOnly) {
    const files = args._;
    if (files.length === 0) usage((gasOnly ? 'gas' : 'lint') + ' requires at least one <file>');
    const jsonOut = !!args.flags.json;
    const report = [];
    let anyError = false;

    for (const file of files) {
        let gate;
        try {
            gate = runGate(readSource(file));
        } catch (e) {
            anyError = true;
            report.push({ file, ok: false, errors: [{ rule: 'io', message: e.message }], advisories: [], warnings: [], gas: null });
            continue;
        }
        if (!gate.ok) anyError = true;
        report.push(Object.assign({ file }, gate));
    }

    if (jsonOut) {
        process.stdout.write(JSON.stringify(gasOnly ? report.map(r => ({ file: r.file, gas: r.gas })) : report, null, 2) + '\n');
        process.exit(anyError && !gasOnly ? 1 : 0);
    }

    for (const r of report) {
        if (gasOnly) {
            process.stdout.write(r.file + ': ~' + (r.gas ? r.gas.suggested : '?') +
                ' gas (' + (r.gas ? r.gas.rationale : 'unreadable') + ')\n');
            continue;
        }
        const mark = r.ok ? 'PASS' : 'FAIL';
        process.stdout.write('[' + mark + '] ' + r.file + '\n');
        for (const e of r.errors) {
            process.stdout.write('   error  ' + (e.line ? 'L' + e.line + ' ' : '') + e.rule + ': ' + e.message + '\n');
        }
        for (const a of (r.advisories || [])) {
            process.stdout.write('   advise ' + (a.line ? 'L' + a.line + ' ' : '') + (a.rule || '') + ': ' + a.message + '\n');
        }
        for (const w of (r.warnings || [])) {
            const msg = typeof w === 'string' ? w : (w.message || JSON.stringify(w));
            process.stdout.write('   warn   ' + (w && w.line ? 'L' + w.line + ' ' : '') + msg + '\n');
        }
        if (r.gas) process.stdout.write('   gas    ~' + r.gas.suggested + ' (' + r.gas.rationale + ')\n');
    }
    process.exit(anyError ? 1 : 0);
}

async function cmdSimulate(args) {
    const file = args._[0];
    if (!file) usage('simulate requires a <file>');

    let ContractSimulator;
    try {
        ({ ContractSimulator } = require('../src/toolkit/index.js'));
    } catch (e) {
        process.stderr.write('error: cannot load the simulator (' + e.message + ')\n' +
            'The simulator needs the isolated-vm binding (Node 22 / Linux). ' +
            'Use `xchain-foundry lint` for static checks on this host.\n');
        process.exit(1);
    }

    const code = readSource(file);
    const method = args.flags.method ? String(args.flags.method) : 'default';
    const params = splitList(args.flags.params);
    const ctorParams = args.flags.constructor !== undefined ? splitList(args.flags.constructor) : undefined;
    const caller = args.flags.caller ? String(args.flags.caller) : undefined;
    // Default left to the simulator (in-process). 'subprocess' is the mode the
    // indexer runs: it costs a fork, and it is the only way to see the chain's
    // out_of_resource result for a contract that aborts the JS engine.
    let execution;
    if (args.flags.execution !== undefined) {
        execution = String(args.flags.execution);
        if (execution !== 'in-process' && execution !== 'subprocess')
            usage('--execution must be in-process or subprocess, got ' + JSON.stringify(execution));
    }

    let sim;
    try {
        sim = new ContractSimulator(execution ? { execution } : {});
    } catch (e) {
        process.stderr.write('error: cannot start the simulator (' + e.message + ')\n' +
            'Run on Node 22 / Linux where isolated-vm loads.\n');
        process.exit(1);
    }

    try {
        const dep = await sim.deploy(code, { filename: file, constructorParams: ctorParams, caller });
        if (dep.initResult) {
            process.stdout.write('initialize: ' + (dep.initResult.success ? 'ok' : 'FAILED: ' + dep.initResult.error) + '\n');
            if (!dep.initResult.success) { await sim.close(); process.exit(1); }
        }
        const res = await sim.call(dep.contractIndex, method, params, { caller });
        process.stdout.write(JSON.stringify({
            method,
            success: res.success,
            error: res.error,
            returnValue: res.returnValue,
            gasUsed: res.gasUsed,
            emittedActions: res.emittedActions,
            stateChanges: res.stateChanges,
            stateDeletes: res.stateDeletes,
            logs: res.logs
        }, null, 2) + '\n');
        await sim.close();
        process.exit(res.success ? 0 : 1);
    } catch (e) {
        try { await sim.close(); } catch (_) { /* ignore */ }
        process.stderr.write('error: ' + e.message + '\n');
        process.exit(1);
    }
}

// Print the authoring prompt for `describe` / `from-solidity`. The prompt IS the
// product here (network-free); the developer pastes it into any model, then runs
// `validate` on the reply.
function cmdPrompt(args, mode) {
    const useTs = !!(args.flags.ts || args.flags.typescript);
    let input;
    if (mode === 'from-solidity') {
        const file = args._[0];
        if (!file) usage('from-solidity requires a <file.sol>');
        try {
            input = fs.readFileSync(file, 'utf8');
        } catch (e) {
            process.stderr.write('error: ' + e.message + '\n');
            process.exit(1);
        }
    } else {
        input = args._.join(' ').trim();
        if (!input) usage('describe requires a "<what the contract should do>" brief');
    }

    let prompt;
    try {
        prompt = buildAuthoringPrompt({ mode, input, typescript: useTs });
    } catch (e) {
        usage(e.message);
    }

    if (args.flags.json) {
        process.stdout.write(JSON.stringify({ mode, typescript: useTs, messages: prompt.messages }, null, 2) + '\n');
        process.exit(0);
    }

    process.stdout.write(
        '# Paste the prompt below into any LLM, then run:\n' +
        '#   <model> | xchain-foundry validate -' + (useTs ? ' --ts' : '') + '\n' +
        '# to run the reply through the deploy determinism gate.\n\n' +
        '===== SYSTEM =====\n' + prompt.system + '\n\n' +
        '===== USER =====\n' + prompt.user + '\n');
    process.exit(0);
}

// Close the loop: extract the contract from a model reply, run the gate, and on
// failure print the repair prompt to paste back. Static (no isolated-vm).
function cmdValidate(args) {
    const src = args._[0];
    if (!src) usage('validate requires a <response-file> (or - for stdin)');
    let raw;
    try {
        raw = src === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(src, 'utf8');
    } catch (e) {
        process.stderr.write('error: ' + e.message + '\n');
        process.exit(1);
    }

    const extracted = extractContractCode(raw);
    if (!extracted.code) {
        process.stderr.write('error: no contract code found in the response.\n');
        process.exit(1);
    }

    const useTs = !!(args.flags.ts || args.flags.typescript) ||
        extracted.lang === 'ts' || extracted.lang === 'typescript';
    let contractJs = extracted.code;
    if (useTs) {
        try {
            contractJs = toContractJs(extracted.code, 'contract.ts');
        } catch (e) {
            process.stderr.write('error: TypeScript strip failed: ' + e.message + '\n');
            process.exit(1);
        }
    }

    const gate = runGate(contractJs);

    if (args.flags.json) {
        process.stdout.write(JSON.stringify({ ok: gate.ok, gate, notes: extracted.notes, contractJs }, null, 2) + '\n');
        process.exit(gate.ok ? 0 : 1);
    }

    process.stdout.write('[' + (gate.ok ? 'PASS' : 'FAIL') + '] extracted contract (' +
        Buffer.byteLength(contractJs, 'utf8') + ' bytes)\n');
    for (const e of gate.errors) {
        process.stdout.write('   error  ' + (e.line ? 'L' + e.line + ' ' : '') + e.rule + ': ' + e.message + '\n');
    }
    for (const a of (gate.advisories || [])) {
        process.stdout.write('   advise ' + (a.line ? 'L' + a.line + ' ' : '') + (a.rule || '') + ': ' + a.message + '\n');
    }
    for (const w of (gate.warnings || [])) {
        const msg = typeof w === 'string' ? w : (w.message || JSON.stringify(w));
        process.stdout.write('   warn   ' + (w && w.line ? 'L' + w.line + ' ' : '') + msg + '\n');
    }
    if (gate.gas) process.stdout.write('   gas    ~' + gate.gas.suggested + ' (' + gate.gas.rationale + ')\n');
    if (extracted.notes) process.stdout.write('\nNotes from the model:\n' + extracted.notes + '\n');

    if (!gate.ok) {
        process.stdout.write('\n# Not deployable. Paste this back to the model to repair:\n\n' +
            buildRepairPrompt(contractJs, gate) + '\n');
    }
    process.exit(gate.ok ? 0 : 1);
}

// ---- dispatch --------------------------------------------------------------

function main() {
    const argv = process.argv.slice(2);
    const cmd = argv[0];
    const rest = parseArgs(argv.slice(1));

    switch (cmd) {
        case 'new':
        case 'init':
        case 'scaffold':
            return cmdNew(rest);
        case 'lint':
            return cmdLint(rest, false);
        case 'gas':
            return cmdLint(rest, true);
        case 'simulate':
        case 'run':
            return cmdSimulate(rest);
        case 'describe':
            return cmdPrompt(rest, 'describe');
        case 'from-solidity':
        case 'solidity':
            return cmdPrompt(rest, 'from-solidity');
        case 'validate':
            return cmdValidate(rest);
        case '-h':
        case '--help':
        case 'help':
        case undefined:
            return usage();
        default:
            return usage('unknown command: ' + cmd);
    }
}

main();
