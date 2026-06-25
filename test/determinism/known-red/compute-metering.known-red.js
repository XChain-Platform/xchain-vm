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
 * Acceptance test (was KNOWN-RED): native compute/iteration builtins
 * must be size-metered so the gas ceiling, not the wall-clock backstop,
 * is the binding constraint.
 *
 * RED before the G1 fix (the compute builtins were charged ~1 gas at the
 * call site regardless of input size (~66,000 native element-touches per
 * gas, see probe), GREEN after `src/index.js` extends F3-style size
 * metering to them. Excluded from the green suites by the `.known-red.js`
 * suffix (the determinism globs match `*.test.js`). Run explicitly:
 *
 *     npm run test:known-red
 *
 * Invariant: a workload whose native element-touches exceed the gas budget
 * by >10x MUST terminate `out_of_gas`; it cannot run to completion. Each
 * vector below performs C * K = 10,000,000 native touches against a default
 * 1,000,000 gas ceiling. A generous 30 s wall-clock net is used so that,
 * BEFORE the fix, the work completes successfully (the RED state) rather
 * than being masked by a timeout.
 *
 * Evidence behind it: `test/determinism/probe-compute-amplification.js`.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const { createVM, execute } = require('../../fuzz/harness');

const CPU_MS = 30000;   // generous: pre-fix work completes (RED) instead of timing out
const K      = 200000;  // working-set size
const C      = 50;      // native calls; C*K = 10,000,000 touches vs the 1,000,000 ceiling

const wrap = (body) => `module.exports = function(xchain) { ${body} };`;

async function run(code) {
    const vm = createVM({ maxCpuTimeMs: CPU_MS }); // gas ceiling stays at the 1,000,000 default
    if (typeof vm.beginBlock === 'function') vm.beginBlock();
    const r = await execute(vm, code, { method: 'default' });
    if (typeof vm.endBlock === 'function') vm.endBlock();
    return r;
}

function assertGasBounded(id, r) {
    assert(
        r.success === false && /out_of_gas/.test(r.error || ''),
        `${id}: ${C} x O(K=${K}) native ops (${C * K} element-touches, >10x the gas ceiling) ` +
        `resolved as success=${r.success} error=${JSON.stringify(r.error)} gasUsed=${r.gasUsed}. ` +
        `Native work must be gas-bounded (expected out_of_gas).`
    );
}

describe('compute builtins must be size-metered (was KNOWN-RED)', function () {
    this.timeout(180000);

    const BUILTINS = [
        { id: 'Array.prototype.indexOf',
          mk: `var a=new Array(${K}).fill(7);var c=0;for(var i=0;i<${C};i++)c+=a.indexOf(-1);return c;` },
        { id: 'Array.prototype.includes',
          mk: `var a=new Array(${K}).fill(7);var c=0;for(var i=0;i<${C};i++)if(a.includes(-1))c++;return c;` },
        { id: 'Array.prototype.join',
          mk: `var a=new Array(${K}).fill(7);var t=0;for(var i=0;i<${C};i++)t+=a.join(',').length;return t;` },
        { id: 'Array.prototype.sort',
          mk: `var a=new Array(${K}).fill(0);for(var i=0;i<${K};i++)a[i]=(i*2654435761)%1000003;var t=0;for(var i=0;i<${C};i++){a.sort();t+=a[0];}return t;` },
        { id: 'JSON.stringify',
          mk: `var a=new Array(${K}).fill(7);var t=0;for(var i=0;i<${C};i++)t+=JSON.stringify(a).length;return t;` },
        { id: 'String.prototype.split',
          mk: `var s=('7,').repeat(${K});var t=0;for(var i=0;i<${C};i++)t+=s.split(',').length;return t;` },
        // Mutators (O(n) shift/copy) and ES2023 copying methods, added after the
        // metering-completeness sweep found them un-metered by the initial G1 list.
        { id: 'Array.prototype.splice',
          mk: `var a=new Array(${K}).fill(7);var t=0;for(var i=0;i<${C};i++){a.splice(0,0,1);t+=a.length;}return t;` },
        { id: 'Array.prototype.unshift',
          mk: `var a=new Array(${K}).fill(7);var t=0;for(var i=0;i<${C};i++)t+=a.unshift(1);return t;` },
        { id: 'Array.prototype.toSorted',
          mk: `var a=new Array(${K}).fill(7);var t=0;for(var i=0;i<${C};i++)t+=a.toSorted().length;return t;` },
        { id: 'Array.prototype.with',
          mk: `var a=new Array(${K}).fill(7);var t=0;for(var i=0;i<${C};i++)t+=a.with(0,9).length;return t;` }
    ];

    for (const b of BUILTINS) {
        it(`${b.id}: O(n) native work must consume gas (out_of_gas under budget)`, async function () {
            assertGasBounded(b.id, await run(wrap(b.mk)));
        });
    }
});

describe('Object statics must be size-metered (was KNOWN-RED)', function () {
    this.timeout(120000);

    // Smaller object working set: a very large key count + enumeration can exceed
    // the 8 MB isolate limit and, in-process, hit the host-abort OOM path (a
    // separate Finding-A residual, contained out-of-process). KO*CO touches still
    // far exceed the 1,000,000 ceiling.
    const KO = 20000;
    const CO = 100;
    const OBJ = `var o={};for(var j=0;j<${KO};j++)o['k'+j]=j;`;

    const STATICS = [
        { id: 'Object.keys',    mk: `${OBJ}var t=0;for(var i=0;i<${CO};i++)t+=Object.keys(o).length;return t;` },
        { id: 'Object.values',  mk: `${OBJ}var t=0;for(var i=0;i<${CO};i++)t+=Object.values(o).length;return t;` },
        { id: 'Object.entries', mk: `${OBJ}var t=0;for(var i=0;i<${CO};i++)t+=Object.entries(o).length;return t;` },
        { id: 'Object.assign',  mk: `${OBJ}var t=0;for(var i=0;i<${CO};i++)t+=Object.keys(Object.assign({},o)).length;return t;` }
    ];

    for (const b of STATICS) {
        it(`${b.id}: O(n) enumeration must consume gas (out_of_gas under budget)`, async function () {
            const r = await run(wrap(b.mk));
            assert(
                r.success === false && /out_of_gas/.test(r.error || ''),
                `${b.id}: ${CO} x O(${KO}) enumerations resolved as success=${r.success} ` +
                `error=${JSON.stringify(r.error)} gasUsed=${r.gasUsed}; expected out_of_gas.`
            );
        });
    }

    // Syntax-level allocators (G4): the metering pass rewrites these into the
    // harness helpers (__concat/__tmpl/__arrspread/__objspread), so a loop that
    // copies a large working set via spread is now gas-bounded, not CPU-bounded.
    const SYNTAX = [
        { id: 'array spread [...a]',
          mk: `var a=new Array(${K}).fill(7);var t=0;for(var i=0;i<${C};i++){t+=[...a].length;}return t;` },
        { id: 'object spread {...o}',
          mk: `var o={};for(var j=0;j<20000;j++)o['k'+j]=j;var t=0;for(var i=0;i<300;i++){var z={...o};t+=1;}return t;` },
        // Previously-skipped cases (#5313): a hole mixed with spread, and an object
        // spread sitting next to a method shorthand. Both used to copy O(n) for free;
        // they must now be gas-bounded exactly like the plain spreads above.
        { id: 'array hole + spread [, ...a]',
          mk: `var a=new Array(${K}).fill(7);var t=0;for(var i=0;i<${C};i++){t+=[, ...a].length;}return t;` },
        { id: 'object spread + method {...o, m(){}}',
          mk: `var o={};for(var j=0;j<20000;j++)o['k'+j]=j;var t=0;for(var i=0;i<300;i++){var z={...o, m(){return 1;}};t+=1;}return t;` }
    ];
    for (const b of SYNTAX) {
        it(`${b.id}: O(n) copy must consume gas (out_of_gas under budget)`, async function () {
            // default ceiling (no override) so the loop trips out_of_gas
            const vm = createVM({ maxCpuTimeMs: CPU_MS });
            if (typeof vm.beginBlock === 'function') vm.beginBlock();
            const r = await execute(vm, wrap(b.mk), { method: 'default' });
            if (typeof vm.endBlock === 'function') vm.endBlock();
            assert(
                r.success === false && /out_of_gas/.test(r.error || ''),
                `${b.id} resolved as success=${r.success} error=${JSON.stringify(r.error)} ` +
                `gasUsed=${r.gasUsed}; expected out_of_gas.`
            );
        });
    }

    // Correctness guard for the object-spread+method rewrite: wrapping the spread
    // SOURCE in __objspreadmeter must NOT disturb the method's `this`. A method that
    // reads a spread-in field through `this` must still see the spread value, and a
    // small spread+method literal must execute successfully (not trip out_of_gas).
    it('object spread + method preserves method `this` binding', async function () {
        const vm = createVM({ maxCpuTimeMs: CPU_MS });
        if (typeof vm.beginBlock === 'function') vm.beginBlock();
        const code = wrap('var base={k:41};var o={...base, bump(){return this.k + 1;}};return o.bump();');
        const r = await execute(vm, code, { method: 'default' });
        if (typeof vm.endBlock === 'function') vm.endBlock();
        assert(r.success === true, `expected success, got error=${JSON.stringify(r.error)}`);
        assert.strictEqual(JSON.parse(r.returnValue), 42, 'method this.k must resolve to the spread-in value');
    });
});

describe('string-growth metering: + / += / template (was KNOWN-RED)', function () {
    this.timeout(60000);

    async function runDefault(code) {
        const vm = createVM({ maxCpuTimeMs: CPU_MS }); // default 1,000,000 gas ceiling
        if (typeof vm.beginBlock === 'function') vm.beginBlock();
        const t0 = process.hrtime.bigint();
        const r = await execute(vm, wrap(code), { method: 'default' });
        const wallMs = Number(process.hrtime.bigint() - t0) / 1e6;
        if (typeof vm.endBlock === 'function') vm.endBlock();
        return { r, wallMs };
    }

    // The metering pass rewrites + / += into __concat and template literals into
    // __tmpl, charging by bytes grown beyond the largest operand, so doubling a
    // string trips out_of_gas instead of building megabytes for ~tens of gas.
    const BOMBS = [
        { id: '+ doubling (s = s + s)',          code: `var s='7';for(var i=0;i<25;i++)s=s+s;return s.length;` },
        { id: '+= doubling (s += s)',            code: `var s='7';for(var i=0;i<25;i++)s+=s;return s.length;` },
        { id: 'template doubling (`${s}${s}`)',  code: 'var s=\'7\';for(var i=0;i<25;i++)s=`${s}${s}`;return s.length;' }
    ];
    for (const b of BOMBS) {
        it(`${b.id}: gas-bounded, not memory-bounded`, async function () {
            const { r } = await runDefault(b.code);
            assert(
                r.success === false && /out_of_gas/.test(r.error || ''),
                `${b.id} resolved as success=${r.success} error=${JSON.stringify(r.error)} ` +
                `gasUsed=${r.gasUsed}; expected out_of_gas.`
            );
        });
    }

    it('cheap-gas / expensive-CPU witness: + build fed to split is gas-bounded', async function () {
        // Pre-fix this burned >5 s of CPU for ~644 gas (cheap + build, un-metered
        // split). Now both the + build (__concat) and the split (G1) are metered.
        const { r, wallMs } = await runDefault(
            `var s='7';for(var i=0;i<21;i++)s=s+','+s;var t=0;for(var i=0;i<200;i++)t+=s.split(',').length;return t;`);
        assert(
            r.success === false && /out_of_gas/.test(r.error || ''),
            `witness resolved as success=${r.success} error=${JSON.stringify(r.error)} ` +
            `gasUsed=${r.gasUsed} after ${wallMs.toFixed(0)} ms CPU. Expected out_of_gas.`
        );
    });

    it('normal numeric + and small strings are unaffected (cheap success)', async function () {
        const { r } = await runDefault(`var n=0;for(var i=0;i<100;i++)n=n+i;return 'sum_'+n;`);
        assert.strictEqual(r.success, true, `expected success, got ${r.error}`);
        assert.strictEqual(r.returnValue, '"sum_4950"');
        assert(r.gasUsed < 10000, `numeric +/small strings must stay cheap, got ${r.gasUsed}`);
    });

    // ---- item #6: member-lhs += and tagged-template residuals are now gas-bound ----
    // Before the __setconcat / __tmpltag[m] fix these escaped the byte meter: a
    // doubling loop built a multi-megabyte string for ~tens of gas and tripped the
    // V8 max-string-length RangeError (gasUsed ~ 59), NOT out_of_gas; gas was not
    // the binding constraint. Now each rewrite charges by bytes grown -> out_of_gas.
    const MEMBER_TMPL_BOMBS = [
        { id: 'computed-LHS += doubling (o[k] += o[k])',
          code: `var o={k:'7'};for(var i=0;i<25;i++)o['k']+=o['k'];return o.k.length;` },
        { id: 'complex-LHS += doubling (o.a.b += o.a.b)',
          code: `var o={a:{b:'7'}};for(var i=0;i<25;i++)o.a.b+=o.a.b;return o.a.b.length;` },
        { id: 'tagged-template doubling (String.raw`${s}${s}`)',
          code: 'var s=\'7\';for(var i=0;i<25;i++)s=String.raw`${s}${s}`;return s.length;' }
    ];
    for (const b of MEMBER_TMPL_BOMBS) {
        it(`${b.id}: gas-bounded, not memory-bounded`, async function () {
            const { r } = await runDefault(b.code);
            assert(
                r.success === false && /out_of_gas/.test(r.error || ''),
                `${b.id} resolved as success=${r.success} error=${JSON.stringify(r.error)} ` +
                `gasUsed=${r.gasUsed}; expected out_of_gas.`
            );
        });
    }

    // Correctness guards: the rewrites must preserve JS semantics exactly.
    it('member += evaluates object + computed key + rhs exactly once', async function () {
        // computed key: o[k()] += rhs -> k() must fire once (native ref semantics).
        const { r } = await runDefault(
            `var n=0;function k(){n++;return 'x';}var o={x:'a'};o[k()]+='b';return n+'|'+o.x;`);
        assert.strictEqual(r.success, true, r.error);
        assert.strictEqual(r.returnValue, '"1|ab"');
    });
    it('member += on a complex object evaluates the object expr once', async function () {
        const { r } = await runDefault(
            `var n=0;var o={x:'a'};function g(){n++;return o;}g().x+='b';return n+'|'+o.x;`);
        assert.strictEqual(r.success, true, r.error);
        assert.strictEqual(r.returnValue, '"1|ab"');
    });
    it('single small member += stays cheap success (no over-charge)', async function () {
        const { r } = await runDefault(`var o={x:'a'};for(var i=0;i<100;i++)o['x']+='b';return o.x.length;`);
        assert.strictEqual(r.success, true, r.error);
        assert(r.gasUsed < 10000, `small member += must stay cheap, got ${r.gasUsed}`);
    });
    it('tagged template: tag receives frozen strings object, raw, and correct this', async function () {
        const { r } = await runDefault(
            `var obj={name:'N',tag:function(strings){var ex=[];for(var i=1;i<arguments.length;i++)ex.push(arguments[i]);` +
            `var ok=strings.length===3&&strings[0]==='p'&&strings[1]==='q\\t'&&strings[2]==='r'&&` +
            `strings.raw[1]==='q\\\\t'&&ex.length===2&&ex[0]===1&&ex[1]===2&&this.name==='N'&&` +
            `Object.isFrozen(strings)&&Object.isFrozen(strings.raw);` +
            `return ok?'OK':('BAD '+strings.length+' '+JSON.stringify(strings)+' '+JSON.stringify(strings.raw));}};` +
            `var x=1,y=2;return obj.tag\`p\${x}q\\t\${y}r\`;`);
        assert.strictEqual(r.success, true, r.error);
        assert.strictEqual(r.returnValue, '"OK"');
    });
    it('String.raw via the metered helper is byte-identical to native', async function () {
        const s = 'X';
        const expected = String.raw`a\n${s}b`;   // native, in the test runtime
        const { r } = await runDefault(`var s='X';return String.raw\`a\\n\${s}b\`;`);
        assert.strictEqual(r.success, true, r.error);
        assert.strictEqual(r.returnValue, JSON.stringify(expected));
    });
    it('single tagged template stays cheap success', async function () {
        const { r } = await runDefault('var s=\'hi\';return String.raw`a${s}b`;');
        assert.strictEqual(r.success, true, r.error);
        assert(r.gasUsed < 10000, `single tagged template must stay cheap, got ${r.gasUsed}`);
    });
});
