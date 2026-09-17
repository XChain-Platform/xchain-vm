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
 * XChain VM: gateway injection
 *
 * Binds every host-side gateway function into the isolate as an
 * ivm.Reference behind one bridge that JSON-frames arguments and results
 * and re-tags typed errors so they survive the isolate boundary.
 * XChainVM prototype method, installed by the entry (../index.js).
 ********************************************************************/
// @ts-nocheck

const ivm    = require('isolated-vm');
const { ContractRevertError, GasExhaustedError } = require('../errors.js');

function injectAccessors(g, gateway, bridge) {
    // Context accessors (0 gas)
    g.setSync('__getBlockHeight',     bridge(gateway.getBlockHeight));
    g.setSync('__getBlockTimestamp',   bridge(gateway.getBlockTimestamp));
    g.setSync('__getBlockHash',        bridge(gateway.getBlockHash));
    g.setSync('__getSourceAddress',    bridge(gateway.getSourceAddress));
    g.setSync('__getContractAddress',  bridge(gateway.getContractAddress));
    g.setSync('__getInputParams',      bridge(gateway.getInputParams));
    g.setSync('__getInputParam',       bridge(gateway.getInputParam));
    g.setSync('__getInputParamCount',  bridge(gateway.getInputParamCount));
    g.setSync('__getCallDepth',        bridge(gateway.getCallDepth));
    g.setSync('__getCrossHops',        bridge(gateway.getCrossHops));
}

function injectLedger(g, gateway, bridge) {
    // Ledger queries (metered)
    g.setSync('__getBalance',   bridge(gateway.getBalance));
    g.setSync('__getTokenInfo', bridge(gateway.getTokenInfo));
    g.setSync('__getPollResult', bridge(gateway.getPollResult));
}

function injectState(g, gateway, bridge) {
    // State (metered)
    g.setSync('__state_get',    bridge(gateway.state.get));
    g.setSync('__state_has',    bridge(gateway.state.has));
    g.setSync('__state_set',    bridge(gateway.state.set));
    g.setSync('__state_delete', bridge(gateway.state.delete));
}

function injectOracle(g, gateway, bridge) {
    // Oracle (metered)
    g.setSync('__oracle_getPrice',        bridge(gateway.oracle.getPrice));
    g.setSync('__oracle_getPriceAtRound',  bridge(gateway.oracle.getPriceAtRound));
    g.setSync('__oracle_getSnapshotAge',   bridge(gateway.oracle.getSnapshotAge));
}

function injectCrossChain(g, gateway, bridge) {
    // Cross-chain (metered)
    g.setSync('__crossChain_getAttestation', bridge(gateway.crossChain.getAttestation));
    g.setSync('__crossChain_isSettled',      bridge(gateway.crossChain.isSettled));
    g.setSync('__crossChain_getCallResult',  bridge(gateway.crossChain.getCallResult));

    g.setSync('__attestation_request',     bridge(gateway.attestation.request));
    g.setSync('__attestation_getResponse', bridge(gateway.attestation.getResponse));
}

function injectStaking(g, gateway, bridge) {
    // Contract-targeted staking (metered)
    g.setSync('__contract_getStake',       bridge(gateway.contract.getStake));
    g.setSync('__contract_getTotalStaked', bridge(gateway.contract.getTotalStaked));
    g.setSync('__contract_getStakers',     bridge(gateway.contract.getStakers));
    g.setSync('__contract_slash',          bridge(gateway.contract.slash));
}

function injectEmit(g, gateway, bridge) {
    // Emit (metered)
    g.setSync('__emit_send',      bridge(gateway.emit.send));
    g.setSync('__emit_destroy',   bridge(gateway.emit.destroy));
    g.setSync('__emit_issue',     bridge(gateway.emit.issue));
    g.setSync('__emit_mint',      bridge(gateway.emit.mint));
    g.setSync('__emit_order',     bridge(gateway.emit.order));
    g.setSync('__emit_dispenser', bridge(gateway.emit.dispenser));
    g.setSync('__emit_dividend',  bridge(gateway.emit.dividend));
    g.setSync('__emit_airdrop',   bridge(gateway.emit.airdrop));
    g.setSync('__emit_callback',  bridge(gateway.emit.callback));
    g.setSync('__emit_file',      bridge(gateway.emit.file));
    g.setSync('__emit_list',      bridge(gateway.emit.list));
    g.setSync('__emit_coinpay',   bridge(gateway.emit.coinpay));
    g.setSync('__emit_sweep',     bridge(gateway.emit.sweep));
    g.setSync('__emit_link',      bridge(gateway.emit.link));
    g.setSync('__emit_broadcast', bridge(gateway.emit.broadcast));
    g.setSync('__emit_message',   bridge(gateway.emit.message));
    g.setSync('__emit_vote',      bridge(gateway.emit.vote));
    g.setSync('__emit_execute',   bridge(gateway.emit.execute));
    g.setSync('__emit_crossExecute', bridge(gateway.emit.crossExecute));
}

function injectMath(g, gateway, bridge) {
    // Math
    g.setSync('__math_add',      bridge(gateway.math.add));
    g.setSync('__math_subtract', bridge(gateway.math.subtract));
    g.setSync('__math_multiply', bridge(gateway.math.multiply));
    g.setSync('__math_divide',   bridge(gateway.math.divide));
    g.setSync('__math_mod',      bridge(gateway.math.mod));
    g.setSync('__math_compare',  bridge(gateway.math.compare));
    g.setSync('__math_gt',       bridge(gateway.math.gt));
    g.setSync('__math_gte',      bridge(gateway.math.gte));
    g.setSync('__math_lt',       bridge(gateway.math.lt));
    g.setSync('__math_lte',      bridge(gateway.math.lte));
    g.setSync('__math_eq',       bridge(gateway.math.eq));
    g.setSync('__math_min',      bridge(gateway.math.min));
    g.setSync('__math_max',      bridge(gateway.math.max));
    g.setSync('__math_abs',      bridge(gateway.math.abs));
    g.setSync('__math_isZero',   bridge(gateway.math.isZero));
    g.setSync('__math_sqrt',     bridge(gateway.math.sqrt));
    g.setSync('__math_pow',      bridge(gateway.math.pow));
    g.setSync('__math_log',      bridge(gateway.math.log));
    g.setSync('__math_log2',     bridge(gateway.math.log2));
    g.setSync('__math_log10',    bridge(gateway.math.log10));
}

function injectControlFlow(g, gateway, bridge) {
    // Control flow (gas-free)
    g.setSync('__revert',  bridge(gateway.revert));
    g.setSync('__require', bridge(gateway.require));
}

function injectLogging(g, gateway, bridge) {
    // Logging (gas-free)
    g.setSync('__log',         bridge(gateway.log));
    g.setSync('__isLogFull',   bridge(gateway.isLogFull));
    g.setSync('__getLogCount', bridge(gateway.getLogCount));
}

module.exports = {
    /**
     * Inject gateway methods into the isolate context as ivm.Reference objects.
     */
    injectGateway(context, gateway) {
        const g = context.global;
        // Bridge helper: wraps a host-side function so it can be called from the isolate.
        // Arguments arrive as a single JSON string; ALL non-null/undefined return values
        // are prefixed with \x01 and JSON-encoded so they can cross the boundary safely.
        // This prevents user-supplied strings containing \x01 from being misinterpreted
        // as protocol markers by the harness wrap() function.
        const bridge = (fn) => new ivm.Reference(function(jsonArgs) {
            const args = jsonArgs ? JSON.parse(jsonArgs) : [];
            try {
                const result = fn.apply(undefined, args);
                if (result === null || result === undefined) return result;
                return '\x01' + JSON.stringify(result);
            } catch (e) {
                // Re-throw with a type prefix so the error can be classified
                // after it loses its class crossing the isolate boundary
                if (e instanceof ContractRevertError) {
                    throw new Error('\x03REVERT:' + e.message);
                }
                if (e instanceof GasExhaustedError) {
                    throw new Error('\x03GAS:' + e.used + ':' + e.ceiling);
                }
                throw e;
            }
        });

        injectAccessors(g, gateway, bridge);
        injectLedger(g, gateway, bridge);
        injectState(g, gateway, bridge);
        injectOracle(g, gateway, bridge);
        injectCrossChain(g, gateway, bridge);
        injectStaking(g, gateway, bridge);
        injectEmit(g, gateway, bridge);
        injectMath(g, gateway, bridge);
        injectControlFlow(g, gateway, bridge);
        injectLogging(g, gateway, bridge);
    },
};
