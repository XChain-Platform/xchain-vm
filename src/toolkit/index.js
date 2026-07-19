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
 * XChain VM Toolkit (xchain-foundry): the Tier-2 developer on-ramp.
 *
 * Packages the VM-as-library into a local simulator + author-time gates so a
 * developer can write, lint, gas-profile, and unit-test a contract with
 * millisecond feedback and no regtest stack. See the individual modules and
 * the `xchain-foundry` / `create-xchain-contract` CLIs.
 ********************************************************************/
// @ts-nocheck

const { ContractSimulator, DEFAULT_GAS_SCHEDULE, DEFAULT_LIMITS } = require('./simulator.js');
const { runGate, estimateGas } = require('./gate.js');
const { buildScaffold, writeScaffold } = require('./scaffold.js');
const { isTypeScript, stripTypes, toContractJs } = require('./transpile.js');
const {
    KNOWLEDGE,
    buildSystemPrompt,
    buildUserPrompt,
    buildAuthoringPrompt,
    buildRepairPrompt,
    extractContractCode,
    authorContract
} = require('./authoring.js');

module.exports = {
    ContractSimulator,
    DEFAULT_GAS_SCHEDULE,
    DEFAULT_LIMITS,
    runGate,
    estimateGas,
    buildScaffold,
    writeScaffold,
    isTypeScript,
    stripTypes,
    toContractJs,
    // Tier-3 AI-assisted authoring harness
    KNOWLEDGE,
    buildSystemPrompt,
    buildUserPrompt,
    buildAuthoringPrompt,
    buildRepairPrompt,
    extractContractCode,
    authorContract
};
