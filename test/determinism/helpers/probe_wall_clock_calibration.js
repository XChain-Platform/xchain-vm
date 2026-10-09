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
 * Calibration: how long does the worst-case EXECUTE take to burn the
 * 1,000,000-gas ceiling on the pinned consensus runtime?
 *
 * src/consensus-wall-clock.js grounds CONSENSUS_MAX_WALL_MS (30 s) and the
 * gas-ceiling batch weights on a measured ~750 ms worst-case burn, i.e. about
 * 40x headroom. This probe re-derives that figure instead of trusting the
 * comment: it refuses to call a run a calibration off the PINNED runtime, runs
 * as a MAINNET node past every ARMED flag-day so the activated metering is what
 * gets measured, and reports the headroom ratio against CONSENSUS_MAX_WALL_MS.
 *
 * "Every armed flag-day" means three kinds: the block-time gates (the latest
 * armed *_GATE_BLOCK_TIME export), the per-coin block-HEIGHT gates listed in
 * HEIGHT_GATES for the probe contract's coin (Pkg 3 sandbox, execute-time lint,
 * lint global-alias, lint optional-chain, lint banned-with, lint destructure,
 * BigInt surface strip), and the per-network activation tables
 * listed in NETWORK_GATES (iterator/Set meter, apply-length meter, gas-ceiling
 * success, JSON.stringify hook; null is off, 0 is on from genesis), whose latest
 * armed time is folded into the probe block. The height gates only resolve on a
 * named network, so the probe passes NETWORK explicitly, and it refuses to run
 * when an armed gate is not active at the probe block or when a per-network
 * activation table is not listed. Unarmed gates stay off, as they do on a real
 * mainnet node.
 *
 * Two vector groups:
 *   - metered: shapes the schedule is meant to price. The worst of these is the
 *     figure the comment quotes; a breach here means the headroom claim is false.
 *   - unmetered-suspect: builtins that do O(n) native work for a flat call-site
 *     charge. A `wall` termination here is a metering hole, not a calibration.
 *
 * Wall time depends on the host, so every run prints the CPU model beside the
 * figures and warnings use ratios, never raw milliseconds. Report-only: it is
 * deliberately not in any mocha glob or CI script.
 *
 *   node test/determinism/helpers/probe_wall_clock_calibration.js [--runs N] [--allow-unpinned]
 *
 * Exit: 0 clean, 2 on a metered headroom breach or advisory (< 10x), 1 on a
 * runtime mismatch without --allow-unpinned, on an armed gate that is not
 * active at the probe block, or on a per-network activation table the probe
 * does not list.
 ********************************************************************/
// @ts-nocheck
const os = require('os');
const { createVM, execute } = require('../../fuzz/helpers/harness.js');
const XChainVM = require('../../../src/index.js');
const runtime = require('../../../src/consensus-runtime.js');
const { CONSENSUS_MAX_WALL_MS } = require('../../../src/consensus-wall-clock.js');

const GAS_CEILING = 1000000;
const DOCUMENTED_MS = 750;
const ADVISORY_RATIO = 10;
const K = 100000;
// Gate constants at or above this are unarmed sentinels, not scheduled flag-days.
const UNARMED_SENTINEL = 9999999999;
// Probe as a mainnet node (the height gates key on '<COIN>:mainnet', not on a missing network).
const NETWORK = 'mainnet';
const CONTRACT = 'C:BTC:1';
// Floor for the probe height; raised to any armed height gate that sits above it.
const MIN_HEIGHT = 10000000;
// Per-coin height gates, read from the exports (a null entry is unarmed, an absent one is refused).
const HEIGHT_GATES = [
    { name: 'pkg3-sandbox', table: XChainVM.PKG3_SANDBOX_ACTIVATION, active: XChainVM.isPkg3SandboxActive },
    { name: 'exec-lint', table: XChainVM.EXEC_LINT_ACTIVATION, active: XChainVM.isExecLintActive },
    { name: 'lint-global-alias', table: XChainVM.LINT_GLOBAL_ALIAS_ACTIVATION, active: XChainVM.isLintGlobalAliasActive },
    { name: 'lint-optional-chain', table: XChainVM.LINT_OPTIONAL_CHAIN_ACTIVATION, active: XChainVM.isLintOptionalChainActive },
    { name: 'lint-banned-with', table: XChainVM.LINT_BANNED_WITH_ACTIVATION, active: XChainVM.isLintBannedWithActive },
    { name: 'lint-destructure', table: XChainVM.LINT_DESTRUCTURE_ACTIVATION, active: XChainVM.isLintDestructureActive },
    { name: 'bigint-surface-strip', table: XChainVM.BIGINT_SURFACE_STRIP_ACTIVATION, active: XChainVM.isBigIntSurfaceStripActive },
];
// Per-network time tables, read from the exports by name (a null entry is unarmed, an absent one is refused).
const NETWORK_GATES = [
    { name: 'iter-set-meter', source: 'ITER_SET_METER_ACTIVATION', active: XChainVM.isIterSetMeterActive },
    { name: 'apply-length-meter', source: 'APPLY_LENGTH_METER_ACTIVATION', active: XChainVM.isApplyLengthMeterActive },
    { name: 'gas-ceiling-success', source: 'GAS_CEILING_SUCCESS_ACTIVATION', active: XChainVM.isGasCeilingSuccessActive },
    // No is-active export exists for this one; the in-isolate check compares against the gate time.
    { name: 'json-stringify-hook', source: 'JSON_STRINGIFY_HOOK_ACTIVATION',
        active: (network, blockTime) => blockTime >= XChainVM.jsonStringifyHookGateTime(network) },
].map((g) => ({ ...g, table: XChainVM[g.source] }));
const NETWORK_KEYS = ['mainnet', 'testnet', 'regtest'];

const argv = process.argv.slice(2);
const RUNS = Math.max(1, parseInt(argv[argv.indexOf('--runs') + 1], 10) || 3);
const ALLOW_UNPINNED = argv.includes('--allow-unpinned');

const wrap = (body) => `module.exports = function(xchain) { ${body} };`;
const ARR = `var a=new Array(${K}).fill(7);`;
const TWO_BYTE = `var s=String.fromCharCode(0x100).repeat(${K});`;

// Each body loops forever, so only the gas ceiling or the wall-clock net stops it.
const VECTORS = [
    { group: 'metered', id: 'plain arithmetic loop', body: 'var t=0;for(;;){t++;}' },
    { group: 'metered', id: 'xchain.math.add loop (gas_burner)', body: "var s='0';for(;;){s=xchain.math.add(s,'1');}" },
    { group: 'metered', id: 'decodeURIComponent loop', body: `var s=('5').repeat(${K});var t=0;for(;;){t+=decodeURIComponent(s).length;}` },
    { group: 'metered', id: 'Array sort+join loop', body: `${ARR}var t=0;for(;;){a.sort();t+=a.join(',').length;}` },
    { group: 'metered', id: 'JSON.stringify loop', body: `${ARR}var t=0;for(;;){t+=JSON.stringify(a).length;}` },
    { group: 'metered', id: 'string split loop', body: `var s=('7,').repeat(${K});var t=0;for(;;){t+=s.split(',').length;}` },
    { group: 'metered', id: 'string spread loop', body: `var s=('7').repeat(${K});var t=0;for(;;){t+=[...s].length;}` },
    { group: 'unmetered-suspect', id: 'Iterator toArray loop', body: `${ARR}var t=0;for(;;){t+=a.values().toArray().length;}` },
    { group: 'unmetered-suspect', id: 'Iterator drop loop', body: `${ARR}var t=0;for(;;){t+=a.values().drop(${K}-1).next().value;}` },
    { group: 'unmetered-suspect', id: 'String isWellFormed loop', body: `${TWO_BYTE}var t=0;for(;;){if(s.isWellFormed())t++;}` },
    { group: 'unmetered-suspect', id: 'String toWellFormed loop', body: `var s=String.fromCharCode(0xD800).repeat(${K});var t=0;for(;;){t+=s.toWellFormed().length;}` },
    { group: 'unmetered-suspect', id: 'Function apply loop', body: `${ARR}function f(){return arguments.length;}var t=0;for(;;){t+=f.apply(null,a);}` },
    { group: 'unmetered-suspect', id: 'Math.max.apply loop', body: `${ARR}var t=0;for(;;){t+=Math.max.apply(null,a);}` },
    { group: 'unmetered-suspect', id: 'ArrayBuffer resize loop', body: `var b=new ArrayBuffer(8,{maxByteLength:${K}});var t=0;for(;;){b.resize(${K});b.resize(0);t++;}` },
    { group: 'unmetered-suspect', id: 'ArrayBuffer transfer loop', body: `var b=new ArrayBuffer(${K});var t=0;for(;;){b=b.transfer();t++;}` },
    { group: 'unmetered-suspect', id: 'Set union loop', body: `var x=new Set(),y=new Set();for(var j=0;j<${K};j++){x.add(j);y.add(j+${K});}var t=0;for(;;){t+=x.union(y).size;}` },
];

// Read one height gate's armed threshold for the probe coin (null when unarmed).
function armedHeight(gate, coin) {
    // Refuse a renamed export, which would otherwise read as an unarmed gate.
    if (!gate.table || typeof gate.active !== 'function') throw new Error(`height gate ${gate.name} is not exported`);
    // Refuse a key the table lacks, so a wrong network or coin cannot pass as unarmed (null is unarmed).
    const key = `${coin}:${NETWORK}`;
    if (!Object.prototype.hasOwnProperty.call(gate.table, key)) throw new Error(`height gate ${gate.name} has no entry for ${key}`);
    const h = gate.table[key];
    return Number.isFinite(h) ? h : null;
}

// Read one per-network gate's armed time for NETWORK (null when unarmed).
function armedTime(gate) {
    // Refuse a renamed export, which would otherwise read as an unarmed gate.
    if (!gate.table || typeof gate.active !== 'function') throw new Error(`network gate ${gate.name} is not exported`);
    if (!Object.prototype.hasOwnProperty.call(gate.table, NETWORK)) throw new Error(`network gate ${gate.name} has no entry for ${NETWORK}`);
    const t = gate.table[NETWORK];
    return Number.isFinite(t) && t < UNARMED_SENTINEL ? t : null;
}

// Name every bare-network-keyed *_ACTIVATION export, own or inherited, that `gates` does not list.
function unlistedNetworkTables(gates = NETWORK_GATES) {
    const names = new Set();
    for (let o = XChainVM; o && o !== Function.prototype && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
        Object.getOwnPropertyNames(o).filter((k) => /_ACTIVATION$/.test(k)).forEach((k) => names.add(k));
    }
    const isNetworkTable = (v) => !!v && typeof v === 'object' && Object.keys(v).length > 0 &&
        Object.keys(v).every((k) => NETWORK_KEYS.includes(k));
    return [...names].filter((k) => isNetworkTable(XChainVM[k]) && !gates.some((g) => g.source === k));
}

// Build the post-gate block: the latest ARMED flag-day time and every armed height, from the exports.
function postGateBlock(coin, gates = NETWORK_GATES) {
    const armed = Object.keys(XChainVM)
        .filter((k) => /_GATE_BLOCK_TIME$/.test(k) && typeof XChainVM[k] === 'number')
        .map((k) => XChainVM[k])
        .filter((t) => t < UNARMED_SENTINEL);
    const times = gates.map(armedTime).filter((t) => t !== null);
    const heights = HEIGHT_GATES.map((g) => armedHeight(g, coin)).filter((h) => h !== null);
    return { height: Math.max(MIN_HEIGHT, ...heights), timestamp: Math.max(...armed, ...times), hash: 'calibration' };
}

// Refuse an unlisted per-network table or an armed one that is off at the block; return the ones that are on.
function checkNetworkGates(block, gates = NETWORK_GATES) {
    const unlisted = unlistedNetworkTables(gates);
    if (unlisted.length) throw new Error(`per-network activation table not listed in NETWORK_GATES: ${unlisted.join(', ')}`);
    const on = [];
    for (const g of gates) {
        const isOn = g.active(NETWORK, block.timestamp);
        if (armedTime(g) !== null && !isOn) throw new Error(`armed network gate ${g.name} not active at the probe block`);
        if (isOn) on.push(g.name);
    }
    return on;
}

// Refuse a probe block where an armed gate is off; return the height gates that are on.
function checkGates(block, coin) {
    // The enforced budget must be the consensus bound, not the harness's 500 ms default.
    if (!XChainVM.isConsensusWallClockActive(NETWORK, block.timestamp)) throw new Error('consensus wall clock not active at the probe block');
    const on = [];
    for (const g of HEIGHT_GATES) {
        const isOn = g.active(NETWORK, coin, block.height);
        if (armedHeight(g, coin) !== null && !isOn) throw new Error(`armed height gate ${g.name} not active at the probe block`);
        if (isOn) on.push(g.name);
    }
    return on;
}

// Refuse to label a run a calibration unless the runtime matches PINNED.
function checkPin() {
    const result = runtime.checkConsensusRuntime();
    const cpu = (os.cpus()[0] || {}).model || 'unknown cpu';
    console.log(`node ${process.version}  v8 ${process.versions.v8}  ${process.platform}/${process.arch}  ${cpu}`);
    if (result.ok) return '';
    console.log(runtime.describeMismatch(result));
    if (!ALLOW_UNPINNED) process.exit(1);
    return 'NOT A CALIBRATION RUN (unpinned runtime) ';
}

// Classify one run by what stopped it.
function terminationOf(res) {
    const err = String(res.error || '');
    if (res.success) return 'completed';
    if (/^timeout:/.test(err)) return 'wall';
    if (/^(out_of_gas|out_of_resource)/.test(err)) return 'gas';
    if (/is not a function|undefined/.test(err)) return 'unavailable';
    return 'error';
}

async function measure(vm, vector, block) {
    const runs = [];
    for (let i = 0; i < RUNS; i++) {
        const t0 = process.hrtime.bigint();
        const res = await execute(vm, wrap(vector.body), { blockContext: block, network: NETWORK, contractAddress: CONTRACT });
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        runs.push({ ms, gasUsed: res.gasUsed, term: terminationOf(res), err: String(res.error || '').slice(0, 40) });
    }
    const sorted = runs.map((r) => r.ms).sort((x, y) => x - y);
    const terms = [...new Set(runs.map((r) => r.term))].join('/');
    return { ...vector, runs, terms, median: sorted[Math.floor(sorted.length / 2)], max: sorted[sorted.length - 1] };
}

function printRow(label, r) {
    const usPerGas = r.runs[0].gasUsed ? (r.median * 1000 / r.runs[0].gasUsed).toFixed(2) : '-';
    console.log(`${label}${r.group.padEnd(18)} ${r.id.padEnd(34)} ${r.terms.padEnd(11)} ` +
        `median ${r.median.toFixed(0).padStart(6)} ms  max ${r.max.toFixed(0).padStart(6)} ms  ${usPerGas} us/gas`);
}

// Summarise headroom over the metered group and flag every wall termination.
function summarise(label, rows) {
    const breaches = rows.filter((r) => r.terms.includes('wall'));
    const meteredGas = rows.filter((r) => r.group === 'metered' && r.terms === 'gas');
    const worst = meteredGas.reduce((w, r) => (!w || r.max > w.max ? r : w), null);
    let code = 0;
    for (const b of breaches) {
        console.log(`${label}HEADROOM BREACH (${b.group}): ${b.id} stopped on the ${CONSENSUS_MAX_WALL_MS} ms wall-clock bound, not on gas`);
        if (b.group === 'metered') code = 2;
    }
    if (!worst) return code || 2;
    const ratio = CONSENSUS_MAX_WALL_MS / worst.max;
    console.log(`${label}worst metered gas-terminated vector: ${worst.id}, max ${worst.max.toFixed(0)} ms`);
    console.log(`${label}headroom ${ratio.toFixed(1)}x against ${CONSENSUS_MAX_WALL_MS} ms ` +
        `(documented: ~${DOCUMENTED_MS} ms, ~${(CONSENSUS_MAX_WALL_MS / DOCUMENTED_MS).toFixed(0)}x)`);
    if (ratio < ADVISORY_RATIO) {
        console.log(`${label}ADVISORY: metered headroom below ${ADVISORY_RATIO}x`);
        code = 2;
    }
    return code;
}

async function main() {
    const label = checkPin();
    const coin = XChainVM.pkg3CoinFromAddress(CONTRACT);
    const block = postGateBlock(coin);
    const heightGatesOn = checkGates(block, coin);
    const networkGatesOn = checkNetworkGates(block);
    console.log(`${label}block time ${block.timestamp}, gas ceiling ${GAS_CEILING}, runs ${RUNS}`);
    console.log(`${label}network ${NETWORK}, coin ${coin}, height ${block.height}, height gates on: ${heightGatesOn.join(', ') || 'none'}`);
    console.log(`${label}network gates on: ${networkGatesOn.join(', ') || 'none'}`);
    const vm = createVM({ maxCpuTimeMs: CONSENSUS_MAX_WALL_MS, gasCeiling: GAS_CEILING });
    const rows = [];
    for (const vector of VECTORS) {
        const row = await measure(vm, vector, block);
        printRow(label, row);
        rows.push(row);
    }
    process.exit(summarise(label, rows));
}

// Measure only when run directly, so a test can load the gate logic without the slow vectors.
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { NETWORK_GATES, HEIGHT_GATES, armedTime, unlistedNetworkTables, postGateBlock, checkGates, checkNetworkGates };
