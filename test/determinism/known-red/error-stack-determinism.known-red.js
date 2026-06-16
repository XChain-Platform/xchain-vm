/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Acceptance test (was KNOWN-RED) — contract-visible Error.stack must be
 * neutered (consensus determinism + info leak).
 *
 * A contract can catch its own errors and return/store e.stack, which lands
 * in hashed state. V8's stack text leaks isolate-internal frame data
 * (line/column offsets into the harness wrapper, frame formatting, depth)
 * that changes across V8 patch releases and whenever HARNESS_SOURCE is
 * edited -> two validators commit different bytes -> fork. RED before the
 * sandbox fix (e.stack was a full trace incl. "<isolated-vm>:11:6"), GREEN
 * after `src/sandbox.js` sets stackTraceLimit=0 + a frozen prepareStackTrace.
 *
 * Run via `npm run test:known-red` (and now `npm run ci`).
 *
 * Evidence: `test/determinism/probe-error-message-determinism.js`.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const { createVM, execute } = require('../../fuzz/harness');

const wrap = (body) => `module.exports = function(xchain) { ${body} };`;

async function ret(code) {
    const vm = createVM();
    if (typeof vm.beginBlock === 'function') vm.beginBlock();
    const r = await execute(vm, code, { method: 'default' });
    if (typeof vm.endBlock === 'function') vm.endBlock();
    return r;
}

describe('Error.stack must be neutered (was KNOWN-RED)', function () {
    this.timeout(30000);

    // Normal (non-overflow) throws: prepareStackTrace + stackTraceLimit=0 apply,
    // so e.stack is the empty string. (The stack-OVERFLOW path is a separate,
    // deeper exposure — see the it.skip residuals below — because V8 cannot run
    // the JS prepareStackTrace hook when the stack is exhausted.)
    const VECTORS = [
        { id: 'TypeError (call undefined)', code: wrap(`try { var f; f(); } catch (e) { return String(e.stack); }`) },
        { id: 'TypeError (property of null)', code: wrap(`try { return null.x; } catch (e) { return String(e.stack); }`) }
    ];

    for (const v of VECTORS) {
        it(`${v.id}: e.stack carries no frames / internal offsets`, async function () {
            const r = await ret(v.code);
            assert.strictEqual(r.success, true, `expected success, got error=${r.error}`);
            // Neutered => empty string. Crucially: no frame markers, no isolate
            // internals, no line/column offsets that vary across V8 builds.
            assert.strictEqual(r.returnValue, '""',
                `e.stack must be the empty string; got ${r.returnValue}`);
            assert(!/<isolated-vm>|\bat \b|:\d+:\d+/.test(r.returnValue || ''),
                `e.stack leaks frame/offset data: ${r.returnValue}`);
        });
    }

    it('stackTraceLimit and prepareStackTrace are locked (cannot be restored)', async function () {
        const r = await ret(wrap(`
            var before = Error.stackTraceLimit;
            try { Error.stackTraceLimit = 100; } catch (e) {}
            try { Error.prepareStackTrace = function(){ return 'leak'; }; } catch (e) {}
            var err; try { null.x; } catch (e) { err = e; }
            return JSON.stringify({ limit: Error.stackTraceLimit, before: before, stack: String(err.stack) });
        `));
        assert.strictEqual(r.success, true, `expected success, got error=${r.error}`);
        const o = JSON.parse(JSON.parse(r.returnValue));
        assert.strictEqual(o.limit, 0, `stackTraceLimit must stay 0, got ${o.limit}`);
        assert.strictEqual(o.stack, '', `stack must stay empty even after tamper attempt, got ${JSON.stringify(o.stack)}`);
    });

    // Stack-OVERFLOW path. Deep recursion used to surface as a contract-catchable
    // RangeError whose stack text (captured host-side via the __gas/applySync
    // boundary) carried HOST FILESYSTEM PATHS into the contract's catch -> info-leak
    // + per-validator nondeterminism -> fork. The fix is now structural rather than
    // cosmetic: the deterministic in-isolate depth bound (src/metering.js Phase 4 +
    // src/index.js) throws an UNCATCHABLE out_of_stack fault at a fixed,
    // platform-independent depth. The contract's own try/catch never runs, so there
    // is no stack text for it to read or leak, and the fault label is byte-identical
    // on every validator regardless of CPU/host call depth. Strictly stronger than
    // the old "neuter the caught stack" guarantee.
    it('stack-overflow faults deterministically and is uncatchable (no host-path leak)', async function () {
        const r = await ret(wrap(`function g(){ return 1 + g(); } try { g(); } catch (e) { return String(e.stack); }`));
        // The contract cannot swallow the overflow: execution faults rather than
        // reaching the catch and returning the (host-dependent) stack.
        assert.strictEqual(r.success, false,
            `overflow must fault uncatchably, not return; got returnValue=${r.returnValue}`);
        // Frozen, deterministic fault label — no host filesystem paths, no host
        // module references, no per-validator-variable frame/offset data.
        assert.strictEqual(r.error, 'out_of_stack: maximum call depth exceeded',
            `expected the frozen out_of_stack fault, got ${r.error}`);
        assert(!/\/[A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+\.js|node:internal|index\.js:|harness\.js:|cjs\/loader/.test(r.error || ''),
            `out_of_stack fault leaks host paths: ${r.error}`);
    });

    // DOCUMENTED RESIDUAL — not in-VM fixable, mitigated operationally.
    // Native throws set e.message as a V8 own property; it cannot be intercepted
    // by overriding the Error constructor. e.message / e.toString() text is
    // therefore still contract-observable and has changed across V8 versions
    // (e.g. "Cannot read property 'x' of undefined" -> "Cannot read properties
    // of undefined (reading 'x')" at V8 8.4; JSON SyntaxError gained a
    // "(line N column M)" suffix in recent V8). Mitigation is a consensus
    // parameter: pin the exact V8/ICU build fleet-wide and enforce it with the
    // cross-version determinism manifest gate. Contracts must not branch on or
    // persist raw error text (SDK/docs guidance). Tracked, intentionally pending.
    it.skip('RESIDUAL: e.message text is V8-version-dependent — mitigate by pinning exact V8 (consensus param), not in-VM', function () {});
});
