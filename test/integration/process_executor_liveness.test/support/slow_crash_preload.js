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
 **********************************************************************/
// Preload for a forked worker: block for XVM_TEST_CRASH_MS before the worker
// loads, then exit(1). The worker never signals ready and dies just past the
// two-second age the executor once used as its only spawn-failure window.
// @ts-nocheck
const ms = Number(process.env.XVM_TEST_CRASH_MS || 2100);
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
process.exit(1);
