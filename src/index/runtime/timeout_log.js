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
 * XChain VM: wall-clock timeout log sink
 *
 * The entry installs the sink so the raw console call stays in src/index.js;
 * until installed, the sink is a no-op.
 *
 **********************************************************************/
'use strict';

let sink = () => {};

function setTimeoutLog(fn) {
    sink = fn;
}

function logTimeout(message) {
    sink(message);
}

module.exports = { setTimeoutLog, logTimeout };
