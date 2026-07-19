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
 * VM Differential-Fuzzing Harness (cross-arch / cross-build)
 *
 * The golden-manifest guard (test/determinism) pins a FIXED corpus of
 * hand-written scenarios. This harness instead fuzzes: it derives a large,
 * RANDOM-but-reproducible corpus from a seed, executes it, and reduces each
 * case to its consensus-visible hash. Because the corpus is a pure function
 * of the seed, two different arches / Node ABIs / libc builds can generate
 * the IDENTICAL input stream independently and then compare only the output
 * hashes. Any per-case hash divergence between two builds is a validator
 * fork waiting to happen (the whole point of the VM is bit-identical
 * execution everywhere), so the differential is the assertion.
 *
 * Two differential axes are supported:
 *   1. cross-process, one host: in-process vs `execution:'subprocess'`
 *      (a proxy build boundary: different V8 entry path + IPC serialisation).
 *   2. cross-arch / cross-build: `record` a manifest per platform in CI,
 *      then `diffManifests()` every pair (see differential-run.js +
 *      .github/workflows/vm-differential-fuzz.yml).
 *
 * The corpus is built from the same fast-check generators the property
 * suites use, so it inherits their valid / mutated / adversarial mix.
 ********************************************************************/
// @ts-nocheck

const os = require('os');
const crypto = require('crypto');
const fc = require('fast-check');
const acorn = require('acorn');
const { generate } = require('astring');

const {
    GAS_SCHEDULE,
    DEFAULT_LIMITS,
    DEFAULT_BLOCK_CONTEXT,
    XChainVM,
    hashResult
} = require('./harness');
const {
    validContractArb,
    adversarialCodeArb,
    VALID_TEMPLATES
} = require('./generators/code');
const { mixedParamsArb } = require('./generators/args');
const { initialStateArb } = require('./generators/state');

const DEFAULT_SEED = 0x58434841; // "XCHA"
const DEFAULT_CASES = 200;
const GAS_CEILING = 1000000;

// Platform fingerprint: arch + Node major + V8 build + libc family. Two
// entries that share a resultHash for the same case agree byte-for-byte on
// the consensus-visible output despite differing on any of these axes.
function platformTag() {
    const nodeMajor = process.versions.node.split('.')[0];
    const libc = (() => {
        try {
            // report.getReport() exposes the glibc/musl split without extra deps.
            const rep = typeof process.report?.getReport === 'function'
                ? process.report.getReport()
                : null;
            const g = rep && rep.header && rep.header.glibcVersionRuntime;
            return g ? 'glibc' + g : 'nonglibc';
        } catch (_e) {
            return 'libc?';
        }
    })();
    return `${os.platform()}-${os.arch()}-node${nodeMajor}-v8_${process.versions.v8}-${libc}`;
}

// --- Deterministic AST mutation --------------------------------------------
//
// The property suites' `mutatedContractArb` mutates via Math.random() INSIDE
// its .map(), so the same fast-check draw yields different code on each call.
// That is fine for a single-process property (both VMs see one drawn value)
// but fatal for a cross-arch differential, where two independent processes
// must derive the IDENTICAL corpus from the seed alone. So the differential
// corpus re-implements the same mutation menu as a PURE function of a
// fast-check-supplied `pick` integer: no Math.random, fully seed-reproducible.

function collectNodes(ast, type) {
    const out = [];
    (function visit(node) {
        if (!node || typeof node !== 'object') return;
        if (node.type === type) out.push(node);
        for (const key of Object.keys(node)) {
            const child = node[key];
            if (Array.isArray(child)) child.forEach(visit);
            else if (child && typeof child === 'object' && child.type) visit(child);
        }
    })(ast);
    return out;
}

function deterministicMutate(code, mutationType, pick) {
    try {
        const ast = acorn.parse(code, { ecmaVersion: 2020, sourceType: 'script' });
        switch (mutationType) {
            case 0: { // blank a string literal
                const lits = collectNodes(ast, 'Literal').filter(n => typeof n.value === 'string');
                if (lits.length) { const t = lits[pick % lits.length]; t.value = ''; t.raw = "''"; }
                break;
            }
            case 1: { // double a numeric literal
                const lits = collectNodes(ast, 'Literal').filter(n => typeof n.value === 'number');
                if (lits.length) { const t = lits[pick % lits.length]; t.value *= 2; t.raw = String(t.value); }
                break;
            }
            case 2: { // remove a statement from the first multi-statement block
                const blocks = collectNodes(ast, 'BlockStatement').filter(b => b.body && b.body.length > 1);
                if (blocks.length) { const b = blocks[pick % blocks.length]; b.body.splice(pick % b.body.length, 1); }
                break;
            }
            case 3: { // duplicate a statement
                const blocks = collectNodes(ast, 'BlockStatement').filter(b => b.body && b.body.length > 0);
                if (blocks.length) {
                    const b = blocks[pick % blocks.length];
                    const idx = pick % b.body.length;
                    b.body.splice(idx, 0, JSON.parse(JSON.stringify(b.body[idx])));
                }
                break;
            }
            case 4: { // lengthen a string literal
                const lits = collectNodes(ast, 'Literal').filter(n => typeof n.value === 'string');
                if (lits.length) { const t = lits[pick % lits.length]; t.value = 'x'.repeat(500); t.raw = "'" + t.value + "'"; }
                break;
            }
        }
        return generate(ast);
    } catch (_e) {
        return code; // an un-parseable/un-generatable mutation degrades to the original
    }
}

const deterministicMutatedArb = fc.tuple(
    fc.constantFrom(...VALID_TEMPLATES),
    fc.integer({ min: 0, max: 4 }),
    fc.integer({ min: 0, max: 0x7fffffff })
).map(([code, mutationType, pick]) => deterministicMutate(code, mutationType, pick));

// Same valid / mutated / adversarial weighting as the property suites'
// `anyCodeArb`, but the mutation tier is the deterministic one above so the
// whole corpus is a pure function of the seed.
const deterministicCodeArb = fc.oneof(
    { weight: 3, arbitrary: validContractArb },
    { weight: 4, arbitrary: deterministicMutatedArb },
    { weight: 3, arbitrary: adversarialCodeArb }
);

// One case is a fully-specified execute() input. The corpus is the sorted,
// indexed sample of (code, params, state) triples for a given seed. fast-check
// sampling is a pure function of (arbitrary, seed, numRuns) since v3, and every
// arbitrary above is Math.random-free, so the SAME seed yields the SAME corpus
// on every platform (guarded by the seed-replay test).
function buildCorpus(opts) {
    const seed = (opts && opts.seed != null) ? opts.seed : DEFAULT_SEED;
    const cases = (opts && opts.cases != null) ? opts.cases : DEFAULT_CASES;

    const caseArb = fc.tuple(deterministicCodeArb, mixedParamsArb, initialStateArb);
    const samples = fc.sample(caseArb, { seed, numRuns: cases });

    return samples.map(([code, params, state], index) => ({
        index,
        code,
        method: 'default',
        params,
        state
    }));
}

function makeVM(execution) {
    return new XChainVM({
        gasSchedule: GAS_SCHEDULE,
        gasCeiling:  GAS_CEILING,
        limits:      DEFAULT_LIMITS,
        execution:   execution || 'in-process'
    });
}

// A short code fingerprint so a manifest diff can point at WHICH generated
// contract diverged without embedding the whole (possibly 100KB) source.
function codeFingerprint(code) {
    return crypto.createHash('sha256').update(code).digest('hex').slice(0, 16);
}

// Execute one case and reduce it to its portable, consensus-visible record.
// hashResult() already collapses the resource-exhaustion family (out_of_gas /
// timeout / out_of_memory / out_of_stack) to one class, matching what the
// indexer actually hashes into contract_hash, so a host-timing race over WHICH
// ceiling fires does not read as a false differential.
async function runCase(vm, c) {
    let result;
    try {
        result = await vm.execute({
            code:            c.code,
            method:          c.method || 'default',
            params:          c.params || [],
            state:           c.state || {},
            caller:          'test_addr',
            contractAddress: 'C:BTC:1',
            blockContext:    DEFAULT_BLOCK_CONTEXT,
            contractIndex:   1
        });
    } catch (e) {
        // vm.execute() must never throw; if it does, that is itself a
        // divergence signal, so fold it into a deterministic synthetic result.
        result = {
            success: false, error: 'HARNESS_CAUGHT_THROW: ' + (e && e.message),
            gasUsed: 0, returnValue: null, stateChanges: [], stateDeletes: [],
            emittedActions: [], logs: []
        };
    }
    return {
        index:      c.index,
        codeHash:   codeFingerprint(c.code),
        resultHash: hashResult(result),
        gasUsed:    result.gasUsed,
        success:    result.success,
        error:      result.error
    };
}

// Run a whole corpus under one execution mode. Fresh VM per case (no
// cross-case block-cache / state bleed), mirroring the determinism runner.
async function runCorpus(corpus, opts) {
    if (!XChainVM) {
        const err = new Error('isolated-vm not available; cannot run differential corpus');
        err.code = 'NO_ISOLATED_VM';
        throw err;
    }
    const execution = (opts && opts.execution) || 'in-process';
    const entries = [];
    // Subprocess mode pays a worker spawn per VM, so reuse one VM across the
    // whole corpus in that mode; in-process stays fresh-per-case (cheap).
    if (execution === 'subprocess') {
        const vm = makeVM('subprocess');
        try {
            if (typeof vm.beginBlock === 'function') vm.beginBlock();
            for (const c of corpus) entries.push(await runCase(vm, c));
        } finally {
            if (typeof vm.shutdown === 'function') await vm.shutdown();
        }
    } else {
        for (const c of corpus) {
            const vm = makeVM('in-process');
            if (typeof vm.beginBlock === 'function') vm.beginBlock();
            entries.push(await runCase(vm, c));
            if (typeof vm.endBlock === 'function') vm.endBlock();
        }
    }
    return entries;
}

// Build a portable manifest for the current platform: seed + params so any
// other build can regenerate the identical corpus, plus the per-case hashes.
async function buildManifest(opts) {
    const seed = (opts && opts.seed != null) ? opts.seed : DEFAULT_SEED;
    const cases = (opts && opts.cases != null) ? opts.cases : DEFAULT_CASES;
    const execution = (opts && opts.execution) || 'in-process';
    const corpus = buildCorpus({ seed, cases });
    const entries = await runCorpus(corpus, { execution });
    return {
        version:   1,
        kind:      'vm-differential-fuzz-manifest',
        seed,
        cases,
        execution,
        platform:  platformTag(),
        node:      process.versions.node,
        entries
    };
}

// Compare two manifests case-by-case. Returns a list of divergences; empty
// list == the two builds are consensus-identical over this corpus. The
// resultHash is the consensus contract; gasUsed is folded into resultHash
// but reported separately when it moves, because a gas delta is the most
// common concrete cause of a hash split and the easiest to eyeball.
function diffManifests(a, b) {
    const divergences = [];

    if (a.seed !== b.seed || a.cases !== b.cases) {
        divergences.push({
            index: -1,
            kind:  'corpus-mismatch',
            detail: `manifests describe different corpora: ` +
                    `seed/cases ${a.seed}/${a.cases} vs ${b.seed}/${b.cases}. ` +
                    `A differential is only meaningful over the identical corpus.`
        });
        return divergences;
    }

    const bById = new Map((b.entries || []).map(e => [e.index, e]));
    for (const ea of (a.entries || [])) {
        const eb = bById.get(ea.index);
        if (!eb) {
            divergences.push({
                index: ea.index, kind: 'missing',
                detail: `case ${ea.index} present in ${a.platform} but absent in ${b.platform}`
            });
            continue;
        }
        if (ea.resultHash !== eb.resultHash) {
            divergences.push({
                index:      ea.index,
                kind:       'result-hash',
                codeHash:   ea.codeHash,
                detail:     `case ${ea.index} (code ${ea.codeHash}) diverged: ` +
                            `${a.platform} resultHash=${ea.resultHash} ` +
                            `(gasUsed=${ea.gasUsed}, error=${JSON.stringify(ea.error)}) vs ` +
                            `${b.platform} resultHash=${eb.resultHash} ` +
                            `(gasUsed=${eb.gasUsed}, error=${JSON.stringify(eb.error)}). ` +
                            `A validator split across these builds is possible.`
            });
        }
    }
    return divergences;
}

module.exports = {
    DEFAULT_SEED,
    DEFAULT_CASES,
    GAS_CEILING,
    platformTag,
    buildCorpus,
    runCorpus,
    buildManifest,
    diffManifests,
    codeFingerprint,
    makeVM
};
