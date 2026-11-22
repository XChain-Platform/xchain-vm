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
 * eslint flat config: the file-level half of the code-style rules, for
 * editors and `npm run lint:eslint`.
 *
 * VENDORED BY COPY from the platform's master preset rather than imported: a
 * public clone of this repo has no platform tree beside it to import from.
 * Core rules only, no plugins, so this file adds exactly one devDependency.
 * Changes belong in the master copy first and travel here as a re-vendor.
 *
 * WHY THE SCRIPT IS `lint:eslint` AND NOT `lint`. In this repo `npm run lint`
 * is already the contract-lint CLI (bin/lint.js), which runs the deploy-time
 * validator over contract SOURCE. That is a product surface, not a style
 * check, and the two must not share a name.
 *
 * WHAT MATCHES HERE. This repo is a library: it has no src/config.js,
 * src/api.js or src/migrate.js, so of the entry-point group only src/index.js
 * and bin/ apply. The patterns that match nothing are kept as vendored to
 * keep the diff against the master copy readable.
 *
 * The pre-push gate (check-code-structure.js) does not depend on eslint or
 * on this file; the two agree on the rules but the gate is what binds.
 */
'use strict';

const allowedUnderscored = [
    '__asyncBlockTime', '__blockTime', '__clsBlockTime', '__codeBytes', '__codeHash', '__codeStr',
    '__corroborate', '__effectiveDepthLimit', '__execLintCoin', '__execLintHeight', '__faultSignalOn',
    '__gasBlockTime', '__hostPrepare', '__hostStackLimit', '__isolate', '__isolateDisposed',
    '__iterSetMeterOn', '__lintBlockTime', '__lintRefusal', '__lintUnits', '__lintVerdict',
    '__meterCallSpread', '__meterRestPattern', '__moBlockTime', '__nativeStackTerminal',
    '__overflowIsHostFault', '__pkg3Coin', '__pkg3Height', '__pkg3SandboxOn', '__psBlockTime',
    '__skBlockTime', '__specEvalOrder', '__stringResultMeterCompiler', '__stripBigIntSurface',
    '__wallBudgetMs', '__wrapperHardened', '_armedHarnessCache', '_balanceScopeWarned',
    '_bareCallbackWarned', '_base', '_blockCache', '_blockOpen', '_broken', '_callCount',
    '_callCounts', '_child', '_config', '_consecutiveSpawnFailures', '_defaultReturn',
    '_defaultTxHash', '_deployGateWarned', '_depth10GasCount', '_dispatch', '_everReady',
    '_executionLog', '_executor', '_gasCeiling', '_harnessCachedData', '_harnessSource', '_inBlock',
    '_lastBrokenRetryAt', '_lastSpawnError', '_lintVerdictCache', '_liveBlockTime', '_load',
    '_meteredCache', '_nextId', '_nextIndex', '_paramsReshapedWarned', '_pending',
    '_preGateWarned', '_preHeightGateWarned', '_processDestroy', '_processIssue', '_processMint',
    '_processSend', '_queue', '_readyTimer', '_releaseSlot', '_resolveFilename', '_rules',
    '_sawReady', '_shuttingDown', '_snapshots', '_stakeScopeWarned', '_stakeShapeWarned', '_v8',
    '_warnedImplicitInProcess', '_watchdogMs',
];

const allowedSnakeCase = [
    'banned_globals', 'banned_syntax', 'banned_with', 'nesting_depth', 'regex_group_depth',
    'syntax_depth',
];

const restrictedRequireSelector = ':function CallExpression[callee.name="require"]'
    + '[arguments.0.type="Literal"]'
    + ':not([arguments.0.value="child_process"])'
    + ':not([arguments.0.value="../src/toolkit/index.js"])'
    + ':not([arguments.0.value="./process-executor.js"])'
    + ':not([arguments.0.value="v8"])';

const globalIgnores = {
    ignores: ['test/**/fixtures/contracts/**/*.js'],
};

const src = {
    files: ['src/**/*.js'],
    languageOptions: {
        ecmaVersion: 2023,
        sourceType: 'commonjs',
        globals: {
            require: 'readonly', module: 'writable', exports: 'writable', process: 'readonly', Buffer: 'readonly',
            __dirname: 'readonly', __filename: 'readonly', console: 'readonly', setTimeout: 'readonly',
            clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly', setImmediate: 'readonly',
            URL: 'readonly', TextEncoder: 'readonly', TextDecoder: 'readonly', AbortController: 'readonly',
        },
    },
    rules: {
        // Naming: camelCase everywhere except property keys, which carry
        // protocol fields and DB columns through one-to-one.
        camelcase: ['error', {
            properties: 'never', ignoreDestructuring: true, ignoreImports: true, allow: allowedSnakeCase,
        }],
        'no-underscore-dangle': ['error', {
            enforceInMethodNames: true, allowAfterThis: false, allowFunctionParams: false,
            allow: allowedUnderscored,
        }],
        // Logging: one logger. Entry points override this below.
        'no-console': 'error',
        // Module shape: requires at the top, environment in config.js only,
        // one export shape per file.
        'no-restricted-syntax': ['error',
            {
                selector: restrictedRequireSelector,
                message: 'require() at the top of the file; inside a body only for a computed path (CODE-STYLE.md, Module shape)',
            },
            {
                selector: 'MemberExpression[object.name="process"][property.name="env"]',
                message: 'environment is read in config.js only (CODE-STYLE.md, Module shape)',
            },
        ],
        'prefer-const': 'error',
        'no-var': 'error',
        eqeqeq: ['error', 'smart'],
    },
};

const configAndEntry = {
    files: [
        'src/config.js', 'src/api.js', 'src/migrate.js', 'src/index.js', 'src/vm-worker.js',
        'src/toolkit/simulator.js', 'src/toolkit/simulator/**/*.js', 'bin/**/*.js',
    ],
    rules: {
        'no-console': 'off',
        'no-restricted-syntax': ['error',
            {
                selector: restrictedRequireSelector,
                message: 'require() at the top of the file; inside a body only for a computed path (CODE-STYLE.md, Module shape)',
            },
        ],
    },
};

const tests = {
    files: ['test/**/*.js'],
    languageOptions: src.languageOptions,
    rules: {
        camelcase: src.rules.camelcase,
        'no-underscore-dangle': src.rules['no-underscore-dangle'],
        'prefer-const': 'error',
        'no-var': 'error',
    },
};

module.exports = [globalIgnores, src, configAndEntry, tests];
