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
 * XChain VM: execution setup host-fault boundary
 *
 * Wraps execute() host operations whose failure must halt and retry instead
 * of becoming a committed result.
 ********************************************************************/
// @ts-nocheck

const { HostFaultError } = require('../../../errors.js');

// Run one host operation and raise any throw as a HostFaultError, so the caller halts and retries.
function hostSetupStep(step, fn) {
    try {
        return fn();
    } catch (e) {
        if (e instanceof HostFaultError) throw e;
        throw new HostFaultError('execution setup failed (' + step + '): ' + (e && e.message));
    }
}

module.exports = { hostSetupStep };
