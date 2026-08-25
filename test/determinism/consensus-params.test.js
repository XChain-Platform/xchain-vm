/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 * Consensus-parameter FREEZE guard (LAUNCH-PLAN track 8).
 *
 * The VM half of the frozen consensus surface: the declared CONSENSUS_VERSION,
 * the pinned runtime, and the status vocabulary. These are golden literals:
 * any drift reddens here, and a real change must bump CONSENSUS_VERSION + a new
 * golden in BOTH repos (the indexer asserts the bundled VM's version) and, post-
 * launch, a protocol_changes.js block-height activation.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const cr = require('../../src/consensus-runtime');
const vm = require('../../src/index');
const lintCore = require('../../src/lint-core');
const metering = require('../../src/metering');

describe('consensus parameters are frozen (track 8 guard)', function () {

    it('CONSENSUS_VERSION is the declared epoch (bump = consensus event)', function () {
        assert.strictEqual(cr.CONSENSUS_VERSION, '4');
        assert.strictEqual(vm.CONSENSUS_VERSION, '4', 're-export must match');
    });

    it('sandbox strip set is frozen (any change is a consensus event → bump CONSENSUS_VERSION)', function () {
        // The set of non-deterministic/dangerous globals the sandbox deletes is
        // consensus-critical surface: adding or removing one changes what a contract
        // can observe and therefore what bytes can enter hashed state. Freeze it as a
        // sorted golden so an edit to sandbox.js STRIPPED_GLOBAL_NAMES reddens here
        // until CONSENSUS_VERSION is bumped + this golden regenerated in lockstep.
        // (Promise and WebAssembly stay in the SET; their DELETION is flag-day gated
        // at runtime -- Promise on the block-time async-surface gate, WebAssembly on
        // the per-coin Pkg 3 height gate; membership is frozen, activation is the
        // separate gate pinned below. Epoch 3 added WebAssembly.)
        const GOLDEN_STRIPPED_GLOBAL_NAMES = [
            'Atomics', 'BigInt', 'Date', 'FinalizationRegistry', 'Intl',
            'Promise', 'Proxy', 'Reflect', 'SharedArrayBuffer', 'Temporal',
            'WeakRef', 'WebAssembly', 'WebSocket', 'XMLHttpRequest', 'clearImmediate',
            'clearInterval', 'clearTimeout', 'fetch', 'performance', 'queueMicrotask',
            'setImmediate', 'setInterval', 'setTimeout', 'structuredClone'
        ];
        assert.ok(Object.isFrozen(vm.STRIPPED_GLOBAL_NAMES), 'strip set must be frozen');
        assert.deepStrictEqual([...vm.STRIPPED_GLOBAL_NAMES].sort(), GOLDEN_STRIPPED_GLOBAL_NAMES,
            'sandbox strip set drifted: a sandbox surface change must bump CONSENSUS_VERSION + regolden in both repos');
    });

    it('deploy CONSENSUS_RULES set is frozen (any change is a consensus event → bump CONSENSUS_VERSION)', function () {
        // CONSENSUS_RULES is the closed set of lint findings the on-chain deploy
        // validator (validateSyntax) acts on; adding/removing one changes which
        // contracts the chain accepts (a hashed deploy verdict). Freeze it sorted so
        // a lint-core edit reddens here until CONSENSUS_VERSION is bumped in lockstep.
        // Epoch 4 added 'banned-rest' (the REST_PATTERN_METER deploy half).
        const GOLDEN_CONSENSUS_RULES = [
            'banned-async', 'banned-generator', 'banned-literal', 'banned-math',
            'banned-rest', 'banned-wasm', 'invalid-type', 'reserved-identifier',
            'unsupported-syntax'
        ];
        assert.deepStrictEqual([...vm.CONSENSUS_RULES].sort(), GOLDEN_CONSENSUS_RULES,
            'deploy CONSENSUS_RULES drifted: a deploy-rule change must bump CONSENSUS_VERSION + regolden in both repos');
    });

    it('deploy reserved-identifier ban list contents are frozen (matcher content, not just the rule name)', function () {
        // The CONSENSUS_RULES golden above freezes only the rule NAMES. The set of
        // host-injected __-prefixed helper names the 'reserved-identifier' rule actually
        // matches (metering.RESERVED_IDENTIFIERS) is the consensus surface behind that
        // name: dropping one (e.g. __setconcatL) narrows the deploy validator without
        // moving CONSENSUS_RULES, so the name-only guard would stay green. Pin the
        // contents sorted so a narrowing reddens until CONSENSUS_VERSION is bumped in
        // lockstep. AST-only, so this runs in every CI lane (no isolated-vm needed).
        const GOLDEN_RESERVED_IDENTIFIERS = [
            '__arrspread', '__concat', '__depth_enter', '__depth_exit', '__gas',
            '__objspread', '__objspreadmeter', '__setconcat', '__setconcatL',
            '__tmpl', '__tmpltag', '__tmpltagm'
        ];
        assert.deepStrictEqual([...metering.RESERVED_IDENTIFIERS].sort(), GOLDEN_RESERVED_IDENTIFIERS,
            'reserved-identifier ban list drifted: a deploy-rule content change must bump CONSENSUS_VERSION + regolden in both repos');
    });

    it('deploy banned-async matcher flags every async-surface kind (narrowing a visitor reddens here)', function () {
        // Same class as the reserved-identifier pin: 'banned-async' is one CONSENSUS_RULE
        // name, but findBannedAsync matches several distinct kinds (async decl/expr/arrow,
        // await, bare Promise). Removing any single visitor leaves CONSENSUS_RULES
        // byte-identical, so pin the kind set behaviourally. findBannedAsync is pure acorn
        // (no isolated-vm), so this runs in every lane, unlike the syntax/security suites.
        const kinds = (src) => lintCore.findBannedAsync(src).map((h) => h.kind);

        // async function declaration containing an await => both kinds must appear; the
        // 'await' assertion is what reddens if the AwaitExpression visitor is deleted.
        const declAwait = kinds('async function f(){ await g() }');
        assert.ok(declAwait.includes('async'), 'async function declaration must be flagged');
        assert.ok(declAwait.includes('await'), 'await expression must be flagged (AwaitExpression visitor)');

        // async arrow expression.
        assert.ok(kinds('var f = async () => 1').includes('async'), 'async arrow must be flagged');

        // Bare reference to the global Promise binding.
        assert.deepStrictEqual(kinds('var p = Promise'), ['promise'], 'bare Promise reference must be flagged');

        // A member-access property (obj.Promise) and a non-computed object-literal key
        // ({ Promise: 1 }) are NOT the global binding and must lint clean. This pins the
        // intent that the parent-position guard in findBannedAsync exists to express, so
        // the behaviour survives a future refactor of that (structurally dead) guard.
        assert.deepStrictEqual(kinds('var o = { Promise: 1 }; var x = o.Promise;'), [],
            'obj.Promise and a { Promise: 1 } key must not be flagged as the global Promise');

        // globalThis-qualified access is the same global binding under a different
        // spelling (dotted and both computed forms), and must be flagged too.
        assert.deepStrictEqual(kinds('globalThis.Promise.resolve()'), ['promise'],
            'globalThis.Promise must be flagged');
        assert.deepStrictEqual(kinds("globalThis['Promise']"), ['promise'],
            "globalThis['Promise'] must be flagged");

        // LINT_GLOBAL_ALIAS spellings (flagged only when the epoch flag is on, which is
        // the author-facing default this helper uses). Sloppy-mode `this` IS globalThis in
        // the Function-constructor evaluation the CONTRACT_WRAPPER performs, and the global
        // object carries its own `globalThis` self-reference, so both read the same binding.
        assert.deepStrictEqual(kinds('this.Promise'), ['promise'],
            'sloppy-mode this.Promise must be flagged under the global-alias epoch');
        assert.deepStrictEqual(kinds('globalThis.globalThis.Promise'), ['promise'],
            'the globalThis self-reference chain must be flagged under the global-alias epoch');
        // ...and the SAME sources must lint clean with the epoch flag off, or the gate is
        // not a gate and every pre-activation deploy verdict silently moves.
        assert.deepStrictEqual(lintCore.findBannedAsync('this.Promise', true, false), [],
            'this.Promise must be accepted below the global-alias activation');
        assert.deepStrictEqual(lintCore.findBannedAsync('globalThis.globalThis.Promise', true, false), [],
            'the globalThis chain must be accepted below the global-alias activation');
    });

    it('sandbox PROTOTYPE-METHOD neuters are frozen (regex + locale/ICU strips)', function () {
        // The strip set above only covers GLOBAL deletes. The sandbox also neuters
        // consensus-critical PROTOTYPE methods that survive a global delete: the regex
        // methods (match/matchAll/search) that coerce to %RegExp% (ReDoS the gas meter
        // cannot see) and the locale/ICU methods whose output is host-ICU-dependent.
        // These lived as inline literals inside buildStripScript and were frozen by
        // nothing; freeze them here so an edit reddens until the goldens are updated in
        // lockstep across both repos. Order-independent: compared as a sorted key set.
        const GOLDEN_STRIPPED_PROTO_METHODS = [
            'Array.toLocaleString', 'Number.toLocaleString', 'Object.toLocaleString',
            'String.localeCompare', 'String.match', 'String.matchAll', 'String.normalize',
            'String.search', 'String.toLocaleLowerCase', 'String.toLocaleUpperCase'
        ];
        assert.ok(Object.isFrozen(vm.STRIPPED_PROTO_METHODS), 'proto-method set must be frozen');
        const keys = vm.STRIPPED_PROTO_METHODS.map(e => e.proto + '.' + e.method).sort();
        assert.deepStrictEqual(keys, GOLDEN_STRIPPED_PROTO_METHODS,
            'sandbox prototype-method neuters drifted: update this golden + the indexer twin in lockstep');
    });

    it('sandbox prototype .constructor neuter targets are frozen (prototype-chain escape block)', function () {
        // The set of built-in prototypes whose .constructor is neutered to block
        // ({}).__proto__.constructor("return process")() escapes. Frozen for the same
        // reason as the strip set: removing one re-opens a sandbox escape.
        const GOLDEN_NEUTERED_PROTO_CONSTRUCTORS = [
            'Array', 'Boolean', 'Number', 'Object', 'RegExp', 'String'
        ];
        assert.ok(Object.isFrozen(vm.NEUTERED_PROTO_CONSTRUCTORS), 'ctor-neuter set must be frozen');
        assert.deepStrictEqual([...vm.NEUTERED_PROTO_CONSTRUCTORS].sort(), GOLDEN_NEUTERED_PROTO_CONSTRUCTORS,
            'prototype .constructor neuter targets drifted: update this golden + the indexer twin in lockstep');
    });

    it('SafeMath member whitelist is frozen (exposed Math surface is consensus-critical)', function () {
        // The deterministic Math subset a contract sees. Adding a member (e.g. a native
        // transcendental that differs by 1 ULP cross-arch, or Math.random) would route
        // non-deterministic bytes into hashed state. Freeze the exact member set.
        const GOLDEN_SAFE_MATH_MEMBERS = [
            'E', 'PI', 'abs', 'ceil', 'floor', 'max', 'min', 'round', 'sign', 'trunc'
        ];
        assert.ok(Object.isFrozen(vm.SAFE_MATH_MEMBERS), 'SafeMath member set must be frozen');
        assert.deepStrictEqual([...vm.SAFE_MATH_MEMBERS].sort(), GOLDEN_SAFE_MATH_MEMBERS,
            'SafeMath member whitelist drifted: update this golden + the indexer twin in lockstep');
    });

    it('ASYNC_SURFACE_GATE_BLOCK_TIME is the frozen flag-day (a divergent value forks the fleet)', function () {
        // The async/Promise surface change (Promise strip + banned-async deploy
        // rejection) activates fleet-wide at this block time on mainnet. It flips a
        // hashed deploy verdict and a hashed execution result, so two nodes that
        // disagree on the flag day diverge on the first such DEPLOY/EXECUTE. Pin it
        // like any other consensus parameter. Matches the indexer's VM_BANNED_ASYNC /
        // other 2.0.0 flag-day activations (protocol_changes.js: 1786060800).
        assert.strictEqual(vm.ASYNC_SURFACE_GATE_BLOCK_TIME, 1786060800);
    });

    it('VM_LINT_HARDENING_GATE_BLOCK_TIME is the frozen flag-day (a divergent value forks the fleet)', function () {
        // Flag-day Pkg 4: the hardened deploy-linter rule set, the
        // wrapper control-binding closure move, and the corroborated error
        // classifier all flip at this block time on mainnet. Deploy verdicts and
        // execution status/gasUsed are hashed, so two nodes that disagree on the
        // flag day diverge on the first hardened DEPLOY/EXECUTE. Armed at the
        // ratified flag-day anchor, the same instant VM_BANNED_ASYNC activates
        // (indexer protocol_changes.js: 1786060800).
        assert.strictEqual(vm.VM_LINT_HARDENING_GATE_BLOCK_TIME, 1786060800);
        assert.strictEqual(vm.isLintHardeningActive('regtest', 0), true);
        assert.strictEqual(vm.isLintHardeningActive('testnet', 0), true);
        assert.strictEqual(vm.isLintHardeningActive('mainnet', 1786060799), false);
        assert.strictEqual(vm.isLintHardeningActive('mainnet', 1786060800), true);
        assert.strictEqual(vm.isLintHardeningActive(undefined, NaN), false);
    });

    it('PINNED runtime equals the golden (re-pinning is a consensus event)', function () {
        assert.deepStrictEqual(cr.PINNED, {
            v8:      '12.4.254.21-node.56',
            icu:     '78.2',
            unicode: '17.0',
            cldr:    '48.0',
            modules: '127'
        });
        assert.ok(Object.isFrozen(cr.PINNED));
    });

    it('MATH_PINNED equals the golden and matches the installed mathjs + configured precision (item 4629)', function () {
        assert.deepStrictEqual(cr.MATH_PINNED, {
            mathjs:    '15.2.0',
            decimaljs: '10.4.3',
            precision: 64
        });
        assert.ok(Object.isFrozen(cr.MATH_PINNED));
        // A mathjs bump must travel with a coordinated CONSENSUS_VERSION change, else
        // contract math roots can fork. mathjs's global config is readonly, so precision
        // is fixed by the library version; assert the version, the precision, and the
        // decimal.js backend version.
        assert.strictEqual(require('mathjs/package.json').version, cr.MATH_PINNED.mathjs,
            'installed mathjs drifted from the consensus pin');
        assert.strictEqual(require('mathjs').config().precision, cr.MATH_PINNED.precision,
            'mathjs BigNumber precision drifted from the consensus pin');
        // decimal.js is the BigNumber backend that actually performs the precision-64
        // arithmetic and the xchain.math transcendentals, and mathjs declares it with a
        // caret range, so a lockfile re-resolve (e.g. npm audit fix) could float it while
        // mathjs stays pinned. package.json pins it via an `overrides` entry; assert the
        // installed nested copy too, so the guard fails if either the override or the
        // resolution drifts. mathjs's `exports` block a direct subpath require, so resolve
        // decimal.js through mathjs's own require.
        const mathjsRequire = require('module').createRequire(require.resolve('mathjs'));
        assert.strictEqual(mathjsRequire('decimal.js/package.json').version, cr.MATH_PINNED.decimaljs,
            'installed decimal.js (mathjs BigNumber backend) drifted from the consensus pin');
    });

    it('AST_TOOLCHAIN_PINNED equals the golden and matches the installed acorn/acorn-walk/astring (item 5012)', function () {
        assert.deepStrictEqual(cr.AST_TOOLCHAIN_PINNED, {
            acorn:     '8.16.0',
            acornWalk: '8.3.5',
            astring:   '1.9.0'
        });
        assert.ok(Object.isFrozen(cr.AST_TOOLCHAIN_PINNED));
        // The metering transform (meterCode) parses with acorn, walks with acorn-walk,
        // and regenerates with astring; injection placement => gasUsed => contract_hash.
        // A bump must travel with a coordinated CONSENSUS_VERSION change, so assert the
        // installed versions against the pin. acorn / acorn-walk expose package.json
        // directly; astring's `exports` block the subpath, so read its package.json by
        // walking up from its resolved main entry.
        const path = require('path'), fs = require('fs');
        function installedVersion(name){
            let dir = path.dirname(require.resolve(name));
            for(let i = 0; i < 8; i++){
                const pj = path.join(dir, 'package.json');
                if(fs.existsSync(pj)){
                    const j = JSON.parse(fs.readFileSync(pj, 'utf8'));
                    if(j.name === name) return j.version;
                }
                const up = path.dirname(dir);
                if(up === dir) break;
                dir = up;
            }
            return null;
        }
        assert.strictEqual(require('acorn/package.json').version, cr.AST_TOOLCHAIN_PINNED.acorn,
            'installed acorn drifted from the consensus pin');
        assert.strictEqual(require('acorn-walk/package.json').version, cr.AST_TOOLCHAIN_PINNED.acornWalk,
            'installed acorn-walk drifted from the consensus pin');
        assert.strictEqual(installedVersion('astring'), cr.AST_TOOLCHAIN_PINNED.astring,
            'installed astring drifted from the consensus pin');
    });

    it('CONSENSUS_STATUS_TOKENS is the frozen closed set (resource family collapsed)', function () {
        assert.deepStrictEqual(cr.CONSENSUS_STATUS_TOKENS, ['reverted', 'out_of_resource', 'failed']);
        assert.ok(Object.isFrozen(cr.CONSENSUS_STATUS_TOKENS));
        assert.deepStrictEqual(vm.CONSENSUS_STATUS_TOKENS, cr.CONSENSUS_STATUS_TOKENS, 're-export must match');
    });

    it('BINARY_ALLOC_GATE_BLOCK_TIME is the frozen flag-day (a divergent value forks the fleet)', function () {
        // The F3-binary ArrayBuffer/TypedArray byte-length gas charge activates
        // fleet-wide at this block time. It is hashed (gasUsed → contract_hash) and
        // drives the fee debit, so two nodes that disagree on the flag day diverge
        // on the first binary-allocating execution after the earlier of the two.
        // Pin it like any other consensus parameter; changing it is a coordinated
        // release-team event, NOT a silent edit. Matches the indexer's other 2.0.0
        // flag-day activations (protocol_changes.js: 1786060800).
        assert.strictEqual(vm.BINARY_ALLOC_GATE_BLOCK_TIME, 1786060800);
    });

    it('CONSENSUS_MAX_WALL_MS is the frozen per-execution wall-clock budget', function () {
        // Gas does not bound wall time: shapes exist whose wall-time-per-gas is far
        // above the schedule's assumption, and for those the wall-clock net is what
        // terminates the execution. While that net was the per-NODE
        // limits.maxCpuTimeMs, a validator with a tighter budget recorded
        // 'timeout:' + gasUsed clamped to the ceiling where a looser one committed
        // the real state changes and the real gasUsed. Both are consensus-visible,
        // so the budget is a consensus parameter and is pinned here; a node running
        // a different value forks the fleet on the first execution that reaches it.
        // Pinned AT the fleet's documented default so promoting it changed no
        // default-configured node's outcome; TIGHTENING it is a separate consensus
        // event (future flag-day + re-goldened baselines + atomic deploy).
        assert.strictEqual(vm.CONSENSUS_MAX_WALL_MS, 30000);
        assert.strictEqual(require('../../src/consensus-wall-clock.js').CONSENSUS_MAX_WALL_MS,
            vm.CONSENSUS_MAX_WALL_MS, 'enforcing module and export must be the same value');
        // The activation rides the ratified 2.0.0 flag-day, like its siblings.
        assert.strictEqual(vm.isConsensusWallClockActive('regtest', 0), true);
        assert.strictEqual(vm.isConsensusWallClockActive('mainnet', vm.BINARY_ALLOC_GATE_BLOCK_TIME), true);
        assert.strictEqual(vm.isConsensusWallClockActive('mainnet', vm.BINARY_ALLOC_GATE_BLOCK_TIME - 1), false);
    });

    it('CALL_SPREAD_METER_GATE_BLOCK_TIME is the frozen flag-day (a divergent value forks the fleet)', function () {
        // Size-metering of call/new/method argument spread (the __arrspread-wrapped
        // argument list) activates fleet-wide at this block time on mainnet. It moves
        // gasUsed (→ contract_hash → fee debit), so two nodes that disagree on the flag
        // day diverge on the first spread-argument execution after the earlier of the
        // two. Pin it like any other consensus parameter; batched into the same 2.0.0
        // flag-day (protocol_changes.js: 1786060800).
        assert.strictEqual(vm.CALL_SPREAD_METER_GATE_BLOCK_TIME, 1786060800);
    });

    it('REST_PATTERN_METER_GATE_BLOCK_TIME is the frozen flag-day (a divergent value forks the fleet)', function () {
        // Size-metering of destructuring rest (the __arrspread/__objspreadmeter-wrapped
        // rest SOURCE) and the deploy rejection of the rest positions metering cannot
        // reach both activate fleet-wide at this block time on mainnet. It moves gasUsed
        // (→ contract_hash → fee debit) AND a deploy verdict, so two nodes that disagree
        // on the flag day diverge on the first rest-using execution or deploy after the
        // earlier of the two. Pin it like any other consensus parameter.
        //
        // It does NOT ride the contract-era flag-day, deliberately: 1786060800 is already
        // in the past, so reusing it would retroactively re-price rest destructures that
        // have already executed. It takes the next scheduled coordinated instant instead
        // (2027-01-01 00:00:00 UTC, shared with the indexer's CROSS_CHAIN_ROYALTY).
        assert.strictEqual(vm.REST_PATTERN_METER_GATE_BLOCK_TIME, 1798761600);
        // testnet/regtest genesis-active; mainnet strictly at/after the instant.
        assert.strictEqual(vm.isRestPatternMeterActive('regtest', 0), true);
        assert.strictEqual(vm.isRestPatternMeterActive('testnet', 0), true);
        assert.strictEqual(vm.isRestPatternMeterActive('mainnet', vm.REST_PATTERN_METER_GATE_BLOCK_TIME), true);
        assert.strictEqual(vm.isRestPatternMeterActive('mainnet', vm.REST_PATTERN_METER_GATE_BLOCK_TIME - 1), false);
        // A missing/garbage timestamp must resolve PRE-gate on mainnet (replay-safe default).
        assert.strictEqual(vm.isRestPatternMeterActive('mainnet', NaN), false);
        assert.strictEqual(vm.isRestPatternMeterActive('mainnet', undefined), false);
        // And it must stay OFF the contract-era instant. If a future repin quietly folds it
        // into the six-gate batch below, every already-executed rest destructure is re-priced
        // retroactively -- which is exactly the retroactivity this separate arming exists to
        // prevent, so assert the separation rather than trusting the comment.
        assert.notStrictEqual(vm.REST_PATTERN_METER_GATE_BLOCK_TIME, vm.CALL_SPREAD_METER_GATE_BLOCK_TIME,
            'REST_PATTERN_METER must keep its own FUTURE flag-day; the contract-era instant is in the past');
    });

    it('REST_PATTERN_METER_GATE_BLOCK_TIME matches the indexer REST_PATTERN_METER literal (cross-repo repin guard)', function () {
        // The VM constant and the indexer protocol_changes entry are the two halves of one
        // flag day: the VM gates the metering rewrite on it, the indexer gates the deploy
        // rejection on it (deploy.js enforceBannedRest). A repin that edits one and misses
        // the other passes BOTH CIs and forks the fleet at activation. Same construction as
        // the six-gate CONTROLLER_GUARD guard below; skips only when the sibling repo is
        // not checked out (standalone clone), where the hard pin above still holds.
        const path = require('path'), fs = require('fs');
        const indexerFile = path.resolve(__dirname, '../../../xchain-indexer/src/protocol_changes.js');
        if (!fs.existsSync(indexerFile)) this.skip();
        const src = fs.readFileSync(indexerFile, 'utf8');
        const all = [...src.matchAll(/addChange\(\s*'REST_PATTERN_METER'\s*,\s*'[^']+'\s*,\s*(\d+)/g)];
        assert.strictEqual(all.length, 1,
            "expected exactly one REST_PATTERN_METER addChange in the indexer's protocol_changes.js, found " + all.length);
        assert.strictEqual(vm.REST_PATTERN_METER_GATE_BLOCK_TIME, Number(all[0][1]),
            'REST_PATTERN_METER diverged between xchain-vm and xchain-indexer: a repin must move both in lockstep');
    });

    it('Package 3 VM-sandbox bundle gate: per-coin activation heights + depth bounds are frozen', function () {
        // The whole flag-day Package 3 VM-sandbox bundle flips on ONE per-coin
        // block-HEIGHT gate (the musl-safe recursion bound folded in, the
        // WebAssembly strip, the generator-fn ban). The activation heights and the
        // depth bounds are hashed-behaviour-affecting (they move which executions
        // out_of_stack / which globals strip), so pin them like any other consensus
        // parameter; a divergent height or predicate forks the fleet. Unlike the six
        // 2.0.0 gates this keys on block HEIGHT, PER COIN, riding the ~961000 window.
        assert.strictEqual(vm.MAX_STACK_DEPTH, 512, 'pre-activation bound is the legacy 512');
        assert.strictEqual(vm.MAX_STACK_DEPTH_MUSL, 256, 'post-activation musl-safe bound');
        // Per-coin activation-height map (LTC/DOGE mainnet PROPOSED, awaiting operator
        // ratification at train sign-off). A bare BTC 961000 would be active-on-deploy
        // on LTC/DOGE (tips already far past it); each coin gets its calendar-equiv height.
        assert.strictEqual(vm.PKG3_SANDBOX_ACTIVATION['BTC:mainnet'], 961000);
        assert.strictEqual(vm.PKG3_SANDBOX_ACTIVATION['LTC:mainnet'], 3154250);
        assert.strictEqual(vm.PKG3_SANDBOX_ACTIVATION['DOGE:mainnet'], 6319000);
        // coin derivation from the C:<COIN>:<idx> contract address.
        assert.strictEqual(vm.pkg3CoinFromAddress('C:BTC:1'), 'BTC');
        assert.strictEqual(vm.pkg3CoinFromAddress('C:DOGE:42'), 'DOGE');
        assert.strictEqual(vm.pkg3CoinFromAddress('garbage'), null);
        assert.strictEqual(vm.pkg3CoinFromAddress(undefined), null);
        // Per-coin/network resolver: testnet/regtest from genesis; each mainnet coin at
        // its own height; unresolvable coin or non-finite height -> pre-activation.
        assert.strictEqual(vm.isPkg3SandboxActive('regtest', 'BTC', 0), true);
        assert.strictEqual(vm.isPkg3SandboxActive('testnet', 'BTC', 0), true);
        assert.strictEqual(vm.isPkg3SandboxActive('mainnet', 'BTC', 960999), false);
        assert.strictEqual(vm.isPkg3SandboxActive('mainnet', 'BTC', 961000), true);
        // The per-coin fix: LTC/DOGE mainnet stay pre-activation at a bare BTC 961000.
        assert.strictEqual(vm.isPkg3SandboxActive('mainnet', 'LTC', 961000), false);
        assert.strictEqual(vm.isPkg3SandboxActive('mainnet', 'LTC', 3154250), true);
        assert.strictEqual(vm.isPkg3SandboxActive('mainnet', 'DOGE', 961000), false);
        assert.strictEqual(vm.isPkg3SandboxActive('mainnet', 'DOGE', 6319000), true);
        // An unrecognized network resolves INACTIVE, the same direction as the indexer's
        // deploy-half twin (isVmDeployLintPkg3Active, pinned there for 'stagenet'). The
        // two halves are one gate: a network on which the runtime strip armed while the
        // deploy lint stayed off is the "deploys clean, stripped at runtime" window the
        // shared gate exists to prevent. Only mainnet/testnet/regtest ever reach a real
        // node, so this fixes the invariant by construction rather than by relying on
        // the indexer's boot-time network validation.
        assert.strictEqual(vm.isPkg3SandboxActive(undefined, 'BTC', 961000), false);
        assert.strictEqual(vm.isPkg3SandboxActive('stagenet', 'BTC', 961000), false);
        assert.strictEqual(vm.isPkg3SandboxActive(undefined, 'BTC', 100), false);
        assert.strictEqual(vm.isPkg3SandboxActive(undefined, 'BTC', NaN), false);
        // unresolvable coin -> inactive (safe legacy default) even at a high height.
        assert.strictEqual(vm.isPkg3SandboxActive('mainnet', null, 10000000), false);
    });

    it('execute-time source-lint gate: per-coin map is UNARMED on mainnet and the gas divisor is frozen', function () {
        // Re-linting stored contract code at EXECUTE time flips previously-succeeding
        // executions into failures and adds a source-length-derived gas charge, so both
        // the activation heights and the gas divisor are consensus parameters: a node
        // that armed a different height, or charged on a different divisor, forks on the
        // first execution of an affected contract.
        //
        // The operator ratified the MECHANISM on 2026-08-11 but still owes the per-coin
        // train heights, so every mainnet entry is the explicit unarmed `null` sentinel.
        // This assertion is what makes an accidental arming visible: filling a height in
        // here is a deliberate, reviewed edit that must move the xchain-indexer twin
        // (src/vm_exec_lint_activation.js) in the SAME change.
        assert.strictEqual(vm.EXEC_LINT_ACTIVATION['BTC:mainnet'], null);
        assert.strictEqual(vm.EXEC_LINT_ACTIVATION['LTC:mainnet'], null);
        assert.strictEqual(vm.EXEC_LINT_ACTIVATION['DOGE:mainnet'], null);
        assert.strictEqual(vm.EXEC_LINT_GAS_BYTES_PER_UNIT, 256);
        // Unarmed means inactive at EVERY mainnet height, including absurd ones: mainnet
        // execution is byte-identical to pre-gate until the operator arms it.
        assert.strictEqual(vm.isExecLintActive('mainnet', 'BTC', 0), false);
        assert.strictEqual(vm.isExecLintActive('mainnet', 'BTC', 961000), false);
        assert.strictEqual(vm.isExecLintActive('mainnet', 'LTC', 10000000), false);
        assert.strictEqual(vm.isExecLintActive('mainnet', 'DOGE', Number.MAX_SAFE_INTEGER), false);
        // Unknown network is treated as mainnet (conservative), unknown coin resolves off.
        assert.strictEqual(vm.isExecLintActive(undefined, 'BTC', 961000), false);
        assert.strictEqual(vm.isExecLintActive('mainnet', 'XYZ', 961000), false);
        assert.strictEqual(vm.isExecLintActive('mainnet', null, 961000), false);
        // Pre-launch nets are genesis-active: they already enforce the identical rule set
        // at deploy from genesis, so nothing that exists there can fail the execute check.
        assert.strictEqual(vm.isExecLintActive('regtest', 'BTC', 0), true);
        assert.strictEqual(vm.isExecLintActive('testnet', 'DOGE', 0), true);
        // A non-finite height is pre-activation even on a genesis-active-by-height chain.
        assert.strictEqual(vm.isExecLintActive('mainnet', 'BTC', NaN), false);
    });

    it('lint global-alias gate: per-coin map is UNARMED on mainnet and cannot ride an open gate', function () {
        // Widening banned-async / banned-wasm to the aliased global reads (sloppy-mode
        // `this`, the globalThis self-reference chain) changes which contracts the chain
        // ACCEPTS, so the activation heights are consensus parameters exactly like the
        // exec-lint ones above: a node that armed a different height rejects a deploy its
        // peers accept, and a from-genesis replay rewrites settled verdicts.
        //
        // Mainnet is the explicit unarmed `null` sentinel pending the operator's ratified
        // per-coin train heights. Filling one in here is a deliberate, reviewed edit that
        // must move the xchain-indexer twin (src/vm_lint_global_alias_activation.js) in
        // the SAME change; that repo's suite pins the pair to equality.
        assert.strictEqual(vm.LINT_GLOBAL_ALIAS_ACTIVATION['BTC:mainnet'], null);
        assert.strictEqual(vm.LINT_GLOBAL_ALIAS_ACTIVATION['LTC:mainnet'], null);
        assert.strictEqual(vm.LINT_GLOBAL_ALIAS_ACTIVATION['DOGE:mainnet'], null);
        assert.ok(Object.isFrozen(vm.LINT_GLOBAL_ALIAS_ACTIVATION));
        // Unarmed means inactive at EVERY mainnet height: deploy verdicts on mainnet are
        // byte-identical to pre-gate until the operator arms it.
        assert.strictEqual(vm.isLintGlobalAliasActive('mainnet', 'BTC', 0), false);
        assert.strictEqual(vm.isLintGlobalAliasActive('mainnet', 'BTC', 961000), false);
        assert.strictEqual(vm.isLintGlobalAliasActive('mainnet', 'DOGE', Number.MAX_SAFE_INTEGER), false);
        // Unknown network / coin / height resolve pre-activation (safe legacy default).
        assert.strictEqual(vm.isLintGlobalAliasActive(undefined, 'BTC', 961000), false);
        assert.strictEqual(vm.isLintGlobalAliasActive('mainnet', 'XYZ', 961000), false);
        assert.strictEqual(vm.isLintGlobalAliasActive('mainnet', null, 961000), false);
        assert.strictEqual(vm.isLintGlobalAliasActive('mainnet', 'BTC', NaN), false);
        // Pre-launch nets are genesis-active (no accepted history to preserve).
        assert.strictEqual(vm.isLintGlobalAliasActive('regtest', 'BTC', 0), true);
        assert.strictEqual(vm.isLintGlobalAliasActive('testnet', 'DOGE', 0), true);
        // It is a DISTINCT epoch, not a rider on VM_LINT_HARDENING. That block-time gate
        // is already open on every network, so reusing it would retroactively reject
        // contracts the chain has already accepted. This pin is what reddens if someone
        // "simplifies" the new gate away onto the old one.
        assert.strictEqual(vm.isLintHardeningActive('mainnet', vm.VM_LINT_HARDENING_GATE_BLOCK_TIME), true);
        assert.strictEqual(vm.isLintGlobalAliasActive('mainnet', 'BTC', 961000), false);
    });

    it('STATE_KEY_NUL_GATE_BLOCK_TIME is the frozen flag-day (a divergent value forks the fleet)', function () {
        // Rejecting NUL-byte state keys flips an execution from success to failure
        // (hashed status + state delta), so two nodes that disagree on the flag day
        // diverge on the first NUL-key write after the earlier of the two. The
        // regression suite exercises the gate's BEHAVIOR relative to the export;
        // this is the hard VALUE pin (a rename/removal makes the export undefined
        // and fails here too). Same 2.0.0 flag-day (protocol_changes.js: 1786060800).
        assert.strictEqual(vm.STATE_KEY_NUL_GATE_BLOCK_TIME, 1786060800);
    });

    it('METERING_EVAL_ORDER_GATE_BLOCK_TIME is the frozen flag-day (a divergent value forks the fleet)', function () {
        // The spec-correct obj[k] += rhs rewrite (__setconcatL) changes results and
        // gasUsed for side-effecting RHS patterns, so the activation must flip
        // fleet-wide at one timestamp. Hard value pin alongside its sibling gates;
        // batched into the same 2.0.0 flag-day (protocol_changes.js: 1786060800).
        assert.strictEqual(vm.METERING_EVAL_ORDER_GATE_BLOCK_TIME, 1786060800);
    });

    it('STATE_KEY_TYPE_GATE_BLOCK_TIME is the frozen flag-day (a divergent value forks the fleet)', function () {
        // Canonical string state keys (String(key) for primitives, deterministic
        // rejection of non-primitive keys) change which writes are valid and how
        // keys count against maxStateKeys, so the activation must flip fleet-wide
        // at one timestamp. Batched into the same 2.0.0 flag-day
        // (protocol_changes.js: 1786060800).
        assert.strictEqual(vm.STATE_KEY_TYPE_GATE_BLOCK_TIME, 1786060800);
    });

    it('all six gate constants match the indexer protocol_changes.js CONTROLLER_GUARD literal (cross-repo repin guard)', function () {
        // The six literal pins above freeze the VM's flag-day value, and the
        // indexer's own suite freezes its value, but nothing tied the two files
        // together: a coordinated repin that edits the indexer literal and misses
        // one VM constant passes BOTH CIs and forks the fleet at activation.
        // Read the indexer source directly (monorepo
        // sibling checkout) and assert every VM gate equals the CONTROLLER_GUARD
        // activation time. Skips only when the sibling repo is not checked out
        // (standalone clone); the hard value pins above still guard that case.
        const path = require('path'), fs = require('fs');
        const indexerFile = path.resolve(__dirname, '../../../xchain-indexer/src/protocol_changes.js');
        if (!fs.existsSync(indexerFile)) this.skip();
        const src = fs.readFileSync(indexerFile, 'utf8');
        // The CONSENSUS_VERSION tier is matched as a wildcard, not pinned. It used
        // to be '2.0.0' and became '0.2.0' when the registry was shifted ordinally
        // to follow the package onto the platform version stream, which broke this
        // guard on a rename that changed nothing it protects. What couples the two
        // repos is the FLAG-DAY TIMESTAMP, so that is what this asserts; the tier
        // label is the indexer's own business.
        const all = [...src.matchAll(/addChange\(\s*'CONTROLLER_GUARD'\s*,\s*'[^']+'\s*,\s*(\d+)/g)];
        assert.strictEqual(all.length, 1,
            "expected exactly one CONTROLLER_GUARD addChange in the indexer's protocol_changes.js, found " + all.length);
        const m = all[0];
        const indexerFlagDay = Number(m[1]);
        const gates = [
            'ASYNC_SURFACE_GATE_BLOCK_TIME', 'BINARY_ALLOC_GATE_BLOCK_TIME',
            'CALL_SPREAD_METER_GATE_BLOCK_TIME', 'STATE_KEY_NUL_GATE_BLOCK_TIME',
            'METERING_EVAL_ORDER_GATE_BLOCK_TIME', 'STATE_KEY_TYPE_GATE_BLOCK_TIME'
        ];
        for (const g of gates) {
            assert.strictEqual(vm[g], indexerFlagDay,
                g + ' diverged from the indexer CONTROLLER_GUARD flag-day: a repin must move all six VM gates and the indexer literal in lockstep');
        }
        // REST_PATTERN_METER_GATE_BLOCK_TIME is deliberately NOT in that list: the
        // contract-era instant is in the PAST, so riding it would retroactively re-price
        // rest destructures that have already executed. It is armed separately and pinned
        // to its own indexer twin by the cross-repo guard above.
        assert.ok(!gates.includes('REST_PATTERN_METER_GATE_BLOCK_TIME'));
        assert.notStrictEqual(vm.REST_PATTERN_METER_GATE_BLOCK_TIME, indexerFlagDay,
            'REST_PATTERN_METER must not be folded into the contract-era batch (that instant has passed)');
    });

    it('XCALL_MAX_HOPS is single-sourced from the emit-time enforcer and pinned', function () {
        // gateway-emit.js declares the hop cap it enforces (crossExecute's hop
        // gate) and index.js re-exports that same binding for the cross-service
        // parity suite. Pin both the value and the single-sourcing so a future
        // bump cannot leave the enforcer and the parity-tested export diverging.
        const gatewayEmit = require('../../src/gateway-emit.js');
        assert.strictEqual(vm.XCALL_MAX_HOPS, 2);
        assert.strictEqual(gatewayEmit.XCALL_MAX_HOPS, vm.XCALL_MAX_HOPS,
            'gateway-emit enforcer and index.js export must be the same value');
    });

    it('STATUS_ERROR_PREFIXES documents every raw prefix the VM can emit', function () {
        assert.deepStrictEqual(cr.STATUS_ERROR_PREFIXES,
            ['revert', 'out_of_gas', 'timeout', 'out_of_memory', 'out_of_stack', 'out_of_resource', 'error']);
        assert.ok(Object.isFrozen(cr.STATUS_ERROR_PREFIXES));
        // The whole resource-exhaustion family the indexer collapses to
        // 'out_of_resource' must be covered, plus the revert / generic prefixes.
        for (const p of ['revert', 'out_of_gas', 'timeout', 'out_of_memory', 'out_of_stack', 'out_of_resource', 'error']) {
            assert.ok(cr.STATUS_ERROR_PREFIXES.includes(p), 'missing prefix: ' + p);
        }
    });
});
