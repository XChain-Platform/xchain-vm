/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * XChain VM: in-contract gateway type definitions
 *
 * Types for the `xchain` object AS SEEN INSIDE A CONTRACT (the argument
 * every method receives). Editors that pick this file up give autocomplete,
 * type-checking, and inline docs while authoring, with no build step and
 * nothing to install at runtime (contracts stay single-file, import-free).
 *
 * Author usage (JSDoc, no bundler needed):
 *
 *   // SPDX-License-Identifier: MIT
 *   / ** @param {import('xchain-vm/src/gateway').XChainGateway} xchain * /
 *   module.exports = {
 *     initialize: function (xchain) {
 *       xchain.state.set('owner', xchain.getSourceAddress());
 *     }
 *   };
 *
 * The runtime surface is built by src/gateway.js (buildGateway) and
 * src/gateway-emit.js (buildEmitAPI). test/unit/gateway-dts-parity.test.js
 * asserts this file stays in lockstep with that surface, so a method added
 * to the gateway without a type here fails CI.
 *
 * IMPORTANT: every value below is a STRING unless typed otherwise. Contract
 * params, state values, and token amounts are all strings; do arithmetic on
 * amounts with `xchain.math.*` (bignumber), never native float math (floats
 * are rejected at deploy).
 ********************************************************************/

/** Token metadata as returned by `getTokenInfo` (fields are strings). */
export interface TokenInfo {
    tick: string;
    /** Total minted supply, as a decimal string. */
    supply?: string;
    /** Maximum supply cap, as a decimal string. */
    maxSupply?: string;
    /** Decimal places (0-18). */
    decimals?: string;
    /** Issuing / controlling address. */
    owner?: string;
    [key: string]: string | undefined;
}

/** One staker of a contract-targeted stake, from `contract.getStakers`. */
export interface Staker {
    /** 64-hex staker public key. */
    pubkey: string;
    /** Active stake amount, as a decimal string. */
    amount: string;
}

/** Frozen result of a finalized VOTE governance poll (`getPollResult`). */
export interface PollResult {
    status: string;
    winning_option: string | number;
    total_weight: string;
    total_voters: number;
    decided_early: boolean;
    options: Array<{ index: number; weight: string; voters: number }>;
}

/** Terminal outcome of a cross-chain call this chain originated. */
export interface CrossCallResult {
    status: string;
    payload: string;
}

/** Options for `attestation.request`. */
export interface AttestationRequestOptions {
    /** Number of independent responders: 1, 3, or 5 (default 1). */
    redundancy?: 1 | 3 | 5;
    /** Response window in blocks, integer in [1, 100] (default 10). */
    deadlineBlocks?: number;
    /** Optional request-fee tick (XCHAIN-only in v1). */
    feeTick?: string;
    /** Optional request-fee amount, non-negative decimal, <= 8 dp. */
    feeAmount?: string;
}

/**
 * Deferred cross-contract EXECUTE (same chain). Runs AFTER this method
 * returns, inside the same atomic scope, with no return value.
 */
export interface EmitExecuteParams {
    /** Target contract index (positive integer). */
    contractIndex: number;
    /** Method name to invoke (non-empty, <= 64 bytes, no "|"). */
    method: string;
    /** Positional string args (each <= 1024 bytes, no "|"), max 32. */
    params?: string[];
    /** Gas ceiling reserved from THIS run's budget for the callee. */
    gasLimit: number;
}

/**
 * Deferred cross-CHAIN call (XCALL). Relayed by the validator federation
 * after confirmation depth; the outcome always arrives via `callbackMethod`.
 */
export interface EmitCrossExecuteParams {
    /** 'BTC' | 'LTC' | 'DOGE', and must differ from this contract's chain. */
    targetChain: 'BTC' | 'LTC' | 'DOGE';
    contractIndex: number;
    /** Must be in the target contract's exported `crossCallable` allowlist. */
    method: string;
    params?: string[];
    /** Remote gas ceiling, integer in [5000, 200000]. */
    gasLimit: number;
    /** Method on THIS contract that receives the result/expiry. */
    callbackMethod: string;
    callbackParams?: string[];
    /** Expiry window in blocks, integer in [10, 4000] (default 400). */
    deadlineBlocks?: number;
}

/** Deterministic bignumber math. Amounts in, amounts out, as strings. */
export interface XChainMath {
    add(a: string, b: string): string;
    subtract(a: string, b: string): string;
    multiply(a: string, b: string): string;
    divide(a: string, b: string): string;
    mod(a: string, b: string): string;
    /** -1 if a<b, 0 if a==b, 1 if a>b. */
    compare(a: string, b: string): number;
    gt(a: string, b: string): boolean;
    gte(a: string, b: string): boolean;
    lt(a: string, b: string): boolean;
    lte(a: string, b: string): boolean;
    eq(a: string, b: string): boolean;
    min(a: string, b: string): string;
    max(a: string, b: string): string;
    abs(a: string): string;
    isZero(a: string): boolean;
    sqrt(a: string): string;
    pow(a: string, b: string): string;
    log(a: string): string;
    log2(a: string): string;
    log10(a: string): string;
}

/** Contract state key/value store (flat; values are strings). */
export interface XChainState {
    /** Read a key, or null if unset. */
    get(key: string): string | null;
    has(key: string): boolean;
    set(key: string, value: string): void;
    /** Delete a key; returns whether it existed. */
    delete(key: string): boolean;
}

/** Validator-attested price oracle. */
export interface XChainOracle {
    /** Latest price for a pair (e.g. 'BTC/USD'), or null. */
    getPrice(coinPair: string): string | null;
    getPriceAtRound(coinPair: string, roundNumber: number): string | null;
    /** Blocks since the oracle snapshot (gas-free, deterministic). */
    getSnapshotAge(): number;
}

/** Cross-chain read surface. */
export interface XChainCrossChain {
    getAttestation(chain: string, actionIndex: number): string | null;
    isSettled(chain: string, actionIndex: number): boolean;
    /** Outcome of a call THIS chain originated, or null while in flight. */
    getCallResult(callId: string): CrossCallResult | null;
}

/** External attestation (http_get / llm providers), PBFT-certified. */
export interface XChainAttestation {
    /**
     * Emit an attestation request; returns a deterministic request_id. The
     * response arrives later via `callbackMethod`. Not available to a
     * controller guard (guards must decide synchronously).
     */
    request(
        providerId: string,
        requestPayload: string,
        callbackMethod: string,
        callbackParams: string[],
        options?: AttestationRequestOptions
    ): string;
    /** Read a stored response by request_id, or null if unfulfilled. */
    getResponse(requestId: string): string | null;
}

/** Contract-targeted staking, scoped to THIS contract. */
export interface XChainContractStake {
    /** Sum of active stake for (pubkey, token) on this contract. */
    getStake(pubkey: string, token: string): string;
    getTotalStaked(token: string): string;
    /** Stakers for `token`, sorted by amount desc, capped at 1000. */
    getStakers(token: string): Staker[];
    /** Slash a staker on this contract (routes to slash_destination). */
    slash(pubkey: string, token: string, amount: string): void;
}

/**
 * Action emission. Every call queues a validated ACTION applied AFTER the
 * method returns (deferred / snapshot semantics). A contract can only emit
 * ACTIONs a user could; it never mutates the ledger directly.
 */
export interface XChainEmit {
    /** Deferred same-chain contract call (no return value). */
    execute(params: EmitExecuteParams): void;
    /** Deferred cross-chain contract call; returns the call_id. */
    crossExecute(params: EmitCrossExecuteParams): string;
    send(params: { destination: string; tick: string; quantity: string }): void;
    destroy(params: { tick: string; quantity: string }): void;
    issue(params: { tick: string; [key: string]: string }): void;
    mint(params: { tick: string; quantity: string }): void;
    order(params: { giveAmount: string; getAmount: string; [key: string]: string }): void;
    dispenser(params: Record<string, string>): void;
    dividend(params: { tick: string; dividendTick: string; quantity: string }): void;
    airdrop(params: { tick: string; quantity: string; listActionIndex: string | number }): void;
    callback(params: { tick: string; [key: string]: string }): void;
    file(params: Record<string, string>): void;
    list(params: Record<string, string>): void;
    coinpay(params: { orderMatchActionIndex: string | number }): void;
    sweep(params: { destination: string; [key: string]: string }): void;
    link(params: {
        coin1: string; coin1ActionIndex: string | number;
        coin2: string; coin2ActionIndex: string | number;
    }): void;
    broadcast(params: Record<string, string>): void;
    message(params: { destination: string; [key: string]: string }): void;
    /** Governance: version 0 creates a poll, version 1 casts a ballot. */
    vote(params: Record<string, string | number>): void;
}

/**
 * The `xchain` gateway: the single argument every contract method receives.
 */
export interface XChainGateway {
    // --- Read-only block/call context (gas-free) ---
    getBlockHeight(): number;
    getBlockTimestamp(): number;
    getBlockHash(): string;
    /** The calling address (Solidity `msg.sender`). */
    getSourceAddress(): string;
    /** This contract's address, `C:<CHAIN>:<index>` (Solidity `address(this)`). */
    getContractAddress(): string;
    /** All positional params (all strings). */
    getInputParams(): string[];
    /** Param `i`, or null if out of range. */
    getInputParam(i: number): string | null;
    getInputParamCount(): number;
    /** 0 for a user EXECUTE, parent+1 when reached via emit.execute. */
    getCallDepth(): number;
    getCrossHops(): number;

    // --- Read-only ledger queries (metered) ---
    /** Balance of `tick` at `address`, or null. */
    getBalance(address: string, tick: string): string | null;
    getTokenInfo(tick: string): TokenInfo | null;
    /** Finalized VOTE poll result, or null if unknown / not finalized. */
    getPollResult(pollIndex: number): PollResult | null;

    // --- Namespaces ---
    state: XChainState;
    oracle: XChainOracle;
    crossChain: XChainCrossChain;
    attestation: XChainAttestation;
    contract: XChainContractStake;
    emit: XChainEmit;
    math: XChainMath;

    // --- Control flow (gas-free) ---
    /** Abort the whole execution (state + emissions roll back). */
    revert(reason?: string): never;
    /** Abort unless `condition` is truthy (Solidity `require`). */
    require(condition: unknown, reason?: string): asserts condition;

    // --- Debug logging (gas-free, capped at 100 entries) ---
    log(...args: unknown[]): void;
    isLogFull(): boolean;
    getLogCount(): number;
}

/** A contract method: receives the gateway, optionally returns a value. */
export type ContractMethod = (xchain: XChainGateway) => unknown;

/**
 * The shape a contract exports. `initialize` is the constructor (runs once at
 * deploy). `crossCallable` allowlists methods reachable by XCALL. `permissions`
 * / `maxTakeBps` declare the controller-guard manifest.
 */
export interface ContractModule {
    initialize?: ContractMethod;
    crossCallable?: string[];
    permissions?: string[];
    maxTakeBps?: number;
    [method: string]: ContractMethod | string[] | number | undefined;
}
