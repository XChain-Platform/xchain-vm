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

// A LOCAL host fault — the out-of-process executor cannot run a contract on
// THIS machine at all (the worker process can never start: fork EAGAIN,
// isolated-vm load failure, etc.). This is NOT a contract outcome: it is not a
// deterministic property of the contract (a contract cannot make fork() fail),
// so it must NEVER be fabricated into a consensus result. A fabricated
// out_of_resource here would diverge from the fleet (which runs the contract
// normally) → unilateral fork. Callers must HALT (not commit) and retry. The
// `code` lets the indexer recognise it without importing the class.
class HostFaultError extends Error {
    constructor(reason) {
        super(reason || 'executor unavailable');
        this.name = 'HostFaultError';
        this.code = 'EXECUTOR_UNAVAILABLE';
    }
}

module.exports = { ContractRevertError, GasExhaustedError, HostFaultError };
