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
 * XChain VM — Error Types
 ********************************************************************/

class ContractRevertError extends Error {
    constructor(reason) {
        super(reason);
        this.name = 'ContractRevertError';
    }
}

class GasExhaustedError extends Error {
    constructor(used, ceiling) {
        super('gas exhausted: used ' + used + ' of ' + ceiling);
        this.name = 'GasExhaustedError';
        this.used = used;
        this.ceiling = ceiling;
    }
}

module.exports = { ContractRevertError, GasExhaustedError };
