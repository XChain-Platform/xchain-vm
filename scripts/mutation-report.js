// @ts-nocheck
// 
'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Mutation Testing Report Generator
//
// Reads Stryker's JSON output and/or the custom mutant runner's JSON output,
// merges them, and generates reports/mutation/MUTATION_SUMMARY.md with:
//   - Overall and per-module mutation scores
//   - Tier-based pass/fail against plan targets
//   - Survived mutation details with actionable recommendations
//   - Operator summary statistics
//
// Usage:
//   node scripts/mutation-report.js
//   node scripts/mutation-report.js --stryker reports/mutation/mutation-score.json
//   node scripts/mutation-report.js --custom reports/mutation/custom-mutant-results.json
//   node scripts/mutation-report.js --stryker path1 --custom path2

const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_STRYKER_JSON = path.join(ROOT, 'reports', 'mutation', 'mutation-score.json');
const DEFAULT_CUSTOM_JSON  = path.join(ROOT, 'reports', 'mutation', 'custom-mutant-results.json');
const OUTPUT_MD = path.join(ROOT, 'reports', 'mutation', 'MUTATION_SUMMARY.md');

// Tier classification matching XCHAIN_VM_MUTATION_TESTING_PLAN.md
const TIERS = {
    'index.js':        { tier: 'Critical', target: 95 },
    'metering.js':     { tier: 'Critical', target: 95 },
    'sandbox.js':      { tier: 'Critical', target: 95 },
    'gas.js':          { tier: 'Critical', target: 95 },
    'gateway.js':      { tier: 'High',     target: 90 },
    'gateway-emit.js': { tier: 'High',     target: 90 },
    'state.js':        { tier: 'High',     target: 90 },
    'math.js':         { tier: 'High',     target: 90 },
    'collector.js':    { tier: 'Medium',   target: 85 },
    'validator.js':    { tier: 'Medium',   target: 85 },
    'syntax.js':       { tier: 'Medium',   target: 85 },
    'isolate.js':      { tier: 'Low',      target: 80 },
    'errors.js':       { tier: 'Low',      target: 80 }
};

const TIER_ORDER = { Critical: 0, High: 1, Medium: 2, Low: 3, Unknown: 4 };

// ─── CLI args ───────────────────────────────────────────────────────────────

function parseArgs() {
    const args = process.argv.slice(2);
    const opts = { strykerJson: null, customJson: null };

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--stryker': opts.strykerJson = args[++i]; break;
            case '--custom':  opts.customJson = args[++i]; break;
        }
    }

    // Auto-detect available files if not specified
    if (!opts.strykerJson && fs.existsSync(DEFAULT_STRYKER_JSON)) {
        opts.strykerJson = DEFAULT_STRYKER_JSON;
    }
    if (!opts.customJson && fs.existsSync(DEFAULT_CUSTOM_JSON)) {
        opts.customJson = DEFAULT_CUSTOM_JSON;
    }

    return opts;
}

// ─── Data loading ───────────────────────────────────────────────────────────

function loadJSON(filepath) {
    if (!filepath || !fs.existsSync(filepath)) return null;
    try {
        return JSON.parse(fs.readFileSync(filepath, 'utf8'));
    } catch (e) {
        console.error('WARNING: Failed to parse ' + filepath + ':', e);
        return null;
    }
}

function mergeResults(strykerData, customData) {
    // Unified structure: { files: { "filename": { mutants: [...] } } }
    const merged = {};

    // Process Stryker data
    if (strykerData && strykerData.files) {
        for (const [filePath, fileData] of Object.entries(strykerData.files)) {
            const filename = path.basename(filePath);
            const relPath = filePath.startsWith('src/') ? filePath : 'src/' + filename;
            if (!merged[relPath]) merged[relPath] = { mutants: [], source: 'stryker' };
            for (const m of (fileData.mutants || [])) {
                merged[relPath].mutants.push({
                    id: m.id,
                    mutatorName: m.mutatorName,
                    status: m.status,
                    replacement: m.replacement || '',
                    location: m.location,
                    coveredBy: m.coveredBy,
                    killedBy: m.killedBy,
                    statusReason: m.statusReason,
                    source: 'stryker'
                });
            }
        }
    }

    // Process custom runner data
    if (customData && customData.files) {
        for (const [filePath, fileData] of Object.entries(customData.files)) {
            const filename = path.basename(filePath);
            const relPath = filePath.startsWith('src/') ? filePath : 'src/' + filename;
            if (!merged[relPath]) merged[relPath] = { mutants: [], source: 'custom' };
            for (const m of (fileData.mutants || [])) {
                merged[relPath].mutants.push({
                    id: m.id,
                    mutatorName: m.mutatorName,
                    status: m.status,
                    replacement: m.replacement || '',
                    original: m.original || '',
                    location: m.location,
                    source: 'custom'
                });
            }
        }
    }

    return merged;
}

// ─── Statistics ─────────────────────────────────────────────────────────────

function computeFileStats(filePath, fileData) {
    const filename = path.basename(filePath);
    const mutants = fileData.mutants || [];

    let killed = 0, survived = 0, timeout = 0, noCoverage = 0, ignored = 0, compileError = 0;
    for (const m of mutants) {
        switch (m.status) {
            case 'Killed':       killed++;       break;
            case 'Survived':     survived++;     break;
            case 'Timeout':      timeout++;      break;
            case 'NoCoverage':   noCoverage++;   break;
            case 'Ignored':      ignored++;      break;
            case 'CompileError': compileError++;  break;
        }
    }

    const scorable = killed + survived + timeout + noCoverage;
    const score = scorable > 0 ? ((killed + timeout) / scorable * 100) : 0;
    const tierInfo = TIERS[filename] || { tier: 'Unknown', target: 80 };
    const status = score >= tierInfo.target ? 'PASS' : 'FAIL';

    return { filename, filePath, scorable, killed, survived, timeout, noCoverage, ignored, compileError, score, tierInfo, status };
}

// ─── Recommendations ────────────────────────────────────────────────────────

function getRecommendation(filename, mutatorName, location) {
    const line = location ? location.start.line : '?';

    if (filename === 'gas.js') {
        if (['ConditionalExpression', 'EqualityOperator', 'ConditionalBoundary', 'GuardDeletion'].includes(mutatorName)) {
            return 'Add assertion: gas.charge(ceiling + 1) must throw GasExhaustedError with correct .used and .ceiling values';
        }
        if (mutatorName === 'ArithmeticOperator') {
            return 'Add assertion: after charge(N), getUsed() must return exactly N';
        }
    }

    if (filename === 'sandbox.js') {
        if (mutatorName === 'ArrayElementDeletion') {
            return 'Add test: verify the specific stripped global is undefined inside an executed contract';
        }
        if (mutatorName === 'ObjectFreezeRemoval') {
            return 'Add test: verify SafeMath properties cannot be overwritten inside a contract';
        }
    }

    if (filename === 'state.js') {
        if (mutatorName === 'GuardDeletion') {
            return 'Add test: state.set(key, NaN) and state.set(key, Infinity) must throw';
        }
        if (mutatorName === 'ConditionalBoundary') {
            return 'Add assertion on exact key count at the limit boundary';
        }
    }

    if (filename === 'index.js') {
        if (mutatorName === 'StringPrefixSwap' || mutatorName === 'StringLiteral') {
            return 'Add test: verify return values cross the isolate boundary correctly (prefix protocol)';
        }
        if (mutatorName === 'ObjectFreezeRemoval') {
            return 'Add test: contract attempting to overwrite __gas must still be metered correctly';
        }
    }

    if (filename === 'metering.js') {
        return 'Add test: verify __gas() is injected for the specific AST node type at line ' + line;
    }

    if (filename === 'gateway-emit.js') {
        return 'Add test: verify required field validation rejects missing parameters';
    }

    if (filename === 'math.js') {
        if (mutatorName === 'GuardDeletion') {
            return 'Add test: division by zero must throw ContractRevertError';
        }
        return 'Add test: verify math operation precision at line ' + line;
    }

    if (mutatorName === 'BlockStatement' || mutatorName === 'Statement') {
        return 'Verify the deleted statement has a test asserting its side effect';
    }
    if (mutatorName === 'LogicalOperator') {
        return 'Add test cases for each branch of the compound condition independently';
    }

    return 'Add a test that fails when code at line ' + line + ' is altered';
}

// ─── Markdown generation ────────────────────────────────────────────────────

function generateMarkdown(mergedFiles) {
    const date = new Date().toISOString().split('T')[0];
    const lines = [];

    // Compute stats
    const allStats = [];
    for (const [filePath, fileData] of Object.entries(mergedFiles)) {
        allStats.push(computeFileStats(filePath, fileData));
    }

    // Sort by tier priority, then score ascending
    allStats.sort((a, b) => {
        const td = TIER_ORDER[a.tierInfo.tier] - TIER_ORDER[b.tierInfo.tier];
        return td !== 0 ? td : a.score - b.score;
    });

    // Totals
    let totalKilled = 0, totalSurvived = 0, totalTimeout = 0, totalNoCoverage = 0, totalScorable = 0;
    for (const s of allStats) {
        totalKilled     += s.killed;
        totalSurvived   += s.survived;
        totalTimeout    += s.timeout;
        totalNoCoverage += s.noCoverage;
        totalScorable   += s.scorable;
    }
    const overallScore = totalScorable > 0 ? ((totalKilled + totalTimeout) / totalScorable * 100) : 0;
    const overallTarget = 90;

    // Header
    lines.push('# Mutation Testing Report — ' + date);
    lines.push('');
    lines.push('## Overall Score: ' + overallScore.toFixed(1) + '% (' +
        (totalKilled + totalTimeout) + ' killed / ' + totalScorable + ' total)');
    lines.push('');
    lines.push('**Status:** ' + (overallScore >= overallTarget ? 'PASS' : 'FAIL') +
        ' (target: >' + overallTarget + '%)');
    lines.push('');

    // Data sources
    const sources = new Set();
    for (const [, fd] of Object.entries(mergedFiles)) {
        for (const m of fd.mutants) sources.add(m.source);
    }
    lines.push('**Sources:** ' + Array.from(sources).join(', '));
    lines.push('');

    // Per-module table
    lines.push('## Per-Module Scores');
    lines.push('');
    lines.push('| Module | Tier | Mutants | Killed | Survived | No Coverage | Timeout | Score | Target | Status |');
    lines.push('|--------|------|---------|--------|----------|-------------|---------|-------|--------|--------|');

    for (const s of allStats) {
        lines.push(
            '| ' + s.filename +
            ' | ' + s.tierInfo.tier +
            ' | ' + s.scorable +
            ' | ' + s.killed +
            ' | ' + s.survived +
            ' | ' + s.noCoverage +
            ' | ' + s.timeout +
            ' | ' + s.score.toFixed(1) + '%' +
            ' | >' + s.tierInfo.target + '%' +
            ' | ' + s.status + ' |'
        );
    }

    lines.push('');
    lines.push('**Totals:** ' + totalScorable + ' mutants | ' +
        totalKilled + ' killed | ' + totalSurvived + ' survived | ' +
        totalNoCoverage + ' no coverage | ' + totalTimeout + ' timeout');
    lines.push('');

    // Survived mutations
    const survivedList = [];
    for (const [filePath, fileData] of Object.entries(mergedFiles)) {
        const filename = path.basename(filePath);
        const tierInfo = TIERS[filename] || { tier: 'Unknown', target: 80 };
        for (const m of fileData.mutants) {
            if (m.status === 'Survived' || m.status === 'NoCoverage') {
                survivedList.push({ filename, filePath, tierInfo, mutant: m });
            }
        }
    }
    survivedList.sort((a, b) => TIER_ORDER[a.tierInfo.tier] - TIER_ORDER[b.tierInfo.tier]);

    if (survivedList.length > 0) {
        lines.push('## Survived Mutations (Action Required)');
        lines.push('');
        lines.push('Sorted by tier priority (Critical first). Each represents a test gap.');
        lines.push('');

        for (const { filename, tierInfo, mutant: m } of survivedList) {
            const loc = m.location
                ? filename + ':' + m.location.start.line
                : filename;
            const statusLabel = m.status === 'NoCoverage' ? 'NO COVERAGE' : 'SURVIVED';

            lines.push('### [' + loc + '] — ' + m.mutatorName + ' (' + statusLabel + ')');
            lines.push('');
            lines.push('- **Tier:** ' + tierInfo.tier);
            lines.push('- **Mutant ID:** ' + m.id);
            if (m.original) {
                lines.push('- **Original:** `' + sanitize(m.original).slice(0, 120) + '`');
            }
            lines.push('- **Replacement:** `' + sanitize(m.replacement).slice(0, 120) + '`');
            if (m.statusReason) lines.push('- **Reason:** ' + m.statusReason);
            if (m.coveredBy && m.coveredBy.length > 0) {
                lines.push('- **Covered by:** ' + m.coveredBy.slice(0, 3).join(', ') +
                    (m.coveredBy.length > 3 ? ' (+' + (m.coveredBy.length - 3) + ' more)' : ''));
            }
            lines.push('- **Source:** ' + (m.source || 'unknown'));
            lines.push('- **Priority:** ' + tierInfo.tier);
            lines.push('- **Recommendation:** ' + getRecommendation(filename, m.mutatorName, m.location));
            lines.push('');
        }
    } else {
        lines.push('## Survived Mutations');
        lines.push('');
        lines.push('No mutations survived. All mutants were killed or timed out.');
        lines.push('');
    }

    // Operator summary
    lines.push('## Mutation Operator Summary');
    lines.push('');

    const opStats = {};
    for (const [, fileData] of Object.entries(mergedFiles)) {
        for (const m of fileData.mutants) {
            if (!opStats[m.mutatorName]) opStats[m.mutatorName] = { total: 0, killed: 0, survived: 0 };
            opStats[m.mutatorName].total++;
            if (m.status === 'Killed' || m.status === 'Timeout') opStats[m.mutatorName].killed++;
            if (m.status === 'Survived') opStats[m.mutatorName].survived++;
        }
    }

    lines.push('| Operator | Total | Killed | Survived | Kill Rate |');
    lines.push('|----------|-------|--------|----------|-----------|');
    const sortedOps = Object.entries(opStats).sort((a, b) => b[1].survived - a[1].survived);
    for (const [op, stats] of sortedOps) {
        const rate = stats.total > 0 ? (stats.killed / stats.total * 100).toFixed(1) + '%' : 'N/A';
        lines.push('| ' + op + ' | ' + stats.total + ' | ' + stats.killed + ' | ' + stats.survived + ' | ' + rate + ' |');
    }
    lines.push('');

    // Footer
    lines.push('---');
    lines.push('');
    lines.push('*Generated by `npm run mutation:report` — ' + new Date().toISOString() + '*');
    lines.push('');
    lines.push('**Next steps:**');
    lines.push('1. For each survived Critical/High mutation: write a new test or strengthen an existing assertion');
    lines.push('2. For NoCoverage mutations: add tests that execute the uncovered code paths');
    lines.push('3. Re-run mutation testing to verify new tests kill the surviving mutants');
    lines.push('4. Mark confirmed equivalent mutants with `// Stryker disable` comments');

    return lines.join('\n');
}

function sanitize(str) {
    return String(str).replace(/`/g, "'").replace(/\n/g, ' ').replace(/\r/g, '');
}

// ─── Main ───────────────────────────────────────────────────────────────────

function main() {
    const opts = parseArgs();
    const strykerData = loadJSON(opts.strykerJson);
    const customData  = loadJSON(opts.customJson);

    if (!strykerData && !customData) {
        console.error('ERROR: No mutation test results found.');
        console.error('Expected one or both of:');
        console.error('  ' + DEFAULT_STRYKER_JSON + '  (run: npm run mutation)');
        console.error('  ' + DEFAULT_CUSTOM_JSON + '  (run: npm run mutation:custom)');
        process.exit(1);
    }

    const sourcesLoaded = [];
    if (strykerData) sourcesLoaded.push('Stryker (' + opts.strykerJson + ')');
    if (customData) sourcesLoaded.push('Custom (' + opts.customJson + ')');
    console.log('Loading results from: ' + sourcesLoaded.join(', '));

    const merged = mergeResults(strykerData, customData);
    const md = generateMarkdown(merged);

    const outDir = path.dirname(OUTPUT_MD);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    fs.writeFileSync(OUTPUT_MD, md, 'utf8');
    console.log('Report written to: ' + OUTPUT_MD);
}

main();
