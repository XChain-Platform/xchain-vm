// @ts-nocheck
//
// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.
//
// Execution-mode selection at construct time. Subprocess mode is the only
// mode with host-crash (SIGABRT) containment, so the mode string must never
// fail silently: a typo'd value used to fall back to in-process via
// `config.execution || 'in-process'` and quietly drop containment.

const assert = require('assert');
const XChainVM = require('../../src/index.js');

const GAS_SCHEDULE = {
    VM_COMPUTATION: 1, VM_STATE_READ: 100, VM_STATE_WRITE: 200, VM_STATE_DELETE: 100,
    VM_ORACLE_READ: 100, VM_CROSSCHAIN_READ: 100, VM_ATTEST_REQUEST: 5000, VM_EMISSION: 500, VM_XCALL_REQUEST: 2000, VM_XCALL_CALLBACK: 20000
};

function cfg(extra) {
    return Object.assign({ gasSchedule: GAS_SCHEDULE, gasCeiling: 1000000 }, extra);
}

describe('XChainVM execution-mode selection', function () {

    it("accepts execution: 'in-process' explicitly", function () {
        const vm = new XChainVM(cfg({ execution: 'in-process' }));
        assert.strictEqual(vm.execution, 'in-process');
        assert.strictEqual(vm._executor, null);
    });

    it('throws at construct time on an unknown mode string (typo guard)', function () {
        for (const bad of ['subproces', 'sub-process', 'subprocess ', 'SUBPROCESS', 'inprocess', true, 1]) {
            assert.throws(
                () => new XChainVM(cfg({ execution: bad })),
                /unknown execution mode/,
                "expected construct-time throw for execution: " + JSON.stringify(bad)
            );
        }
    });

    it('warns once per process when the mode is left implicit', function () {
        const warnings = [];
        const origWarn = console.warn;
        const origLatch = XChainVM._warnedImplicitInProcess;
        console.warn = (msg) => { warnings.push(String(msg)); };
        try {
            XChainVM._warnedImplicitInProcess = false;
            const vm1 = new XChainVM(cfg());
            const vm2 = new XChainVM(cfg());
            assert.strictEqual(vm1.execution, 'in-process');
            assert.strictEqual(vm2.execution, 'in-process');
            const modeWarnings = warnings.filter(w => /no execution mode configured/.test(w));
            assert.strictEqual(modeWarnings.length, 1, 'implicit-mode warning must fire exactly once per process');
            assert.match(modeWarnings[0], /subprocess/, 'warning should point at the production fix');
        } finally {
            console.warn = origWarn;
            XChainVM._warnedImplicitInProcess = origLatch;
        }
    });

    it("does not warn when 'in-process' is chosen explicitly", function () {
        const warnings = [];
        const origWarn = console.warn;
        const origLatch = XChainVM._warnedImplicitInProcess;
        console.warn = (msg) => { warnings.push(String(msg)); };
        try {
            XChainVM._warnedImplicitInProcess = false;
            new XChainVM(cfg({ execution: 'in-process' }));
            assert.strictEqual(warnings.filter(w => /no execution mode configured/.test(w)).length, 0,
                'an explicit in-process choice acknowledges the trade-off and must be silent');
        } finally {
            console.warn = origWarn;
            XChainVM._warnedImplicitInProcess = origLatch;
        }
    });
});
