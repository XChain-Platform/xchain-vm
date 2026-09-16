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
 ********************************************************************/

const acorn = require('acorn');
const walk = require('acorn-walk');

// --- Contract identity (`meta`) ------------------------------------------
//
// CONTRACT_META_REQUIRED makes `meta.name` and `meta.description` a consensus
// requirement: at/after the flag day the indexer rejects a DEPLOY whose contract
// exports no conforming `meta`. The gate has to see that BEFORE the author pays a
// fee, so `contract-meta` joins 'code-size' as a gate-local DEPLOY_BLOCKING rule.
//
// It is gate-local (not a lint_core rule) because lint_core's CONSENSUS_RULES is
// the frozen set the on-chain validateSyntax acts on, byte-vendored into the SDK
// and pinned by a sha256 parity guard; the chain rejects a nameless contract in
// deploy/index.js, not in validateSyntax, exactly as it rejects an oversized one:
// the contract identity and code-size checks have the same layering.
//
// The detector is STATIC (acorn), while the chain evaluates `meta` by RUNNING the
// module in the isolate. A computed name is therefore invisible here, which is why
// an undecidable read is an advisory rather than a block: the gate never blocks a
// contract the chain would accept on a shape it merely cannot see.

// Frozen consensus tokens, copied verbatim from spec 2.3 so the author reads the
// same string the chain will write into the action's status.
const META_VERDICTS = {
    REQUIRED:    'invalid: CONTRACT_MANIFEST (meta required)',
    NAME:        'invalid: CONTRACT_MANIFEST (meta.name must be a string of 1..64 bytes, printable, trimmed)',
    DESCRIPTION: 'invalid: CONTRACT_MANIFEST (meta.description must be a string of 1..512 bytes, printable, trimmed)',
    VERSION:     'invalid: CONTRACT_MANIFEST (meta.version must be a string of 1..32 bytes, printable, trimmed)'
};

const META_NAME_MAX_BYTES = 64;
const META_DESCRIPTION_MAX_BYTES = 512;
const META_VERSION_MAX_BYTES = 32;

// Code points banned ANYWHERE in a meta text field: C0 controls, DEL + C1,
// zero-width joiners/spaces, and the bidi overrides that let a name render as
// something other than its bytes. U+000A is banned too, excepted only for
// `description` (allowLf). The set is the consensus grammar's, not a superset:
// widening it later is another flag day.
function isBannedMetaCodePoint(cp, allowLf) {
    if (cp === 0x0A) return !allowLf;
    if (cp <= 0x1F) return true;                    // C0 controls
    if (cp >= 0x7F && cp <= 0x9F) return true;      // DEL + C1 controls
    if (cp >= 0x200B && cp <= 0x200D) return true;  // zero-width space/non-joiner/joiner
    if (cp === 0x2060 || cp === 0xFEFF) return true; // word joiner, BOM/ZWNBSP
    if (cp >= 0x202A && cp <= 0x202E) return true;  // bidi embedding/override
    if (cp >= 0x2066 && cp <= 0x2069) return true;  // bidi isolates
    if (cp === 0x200E || cp === 0x200F) return true; // LRM / RLM
    return false;
}

// "Trimmed" as an explicit code-point set rather than String.trim(), which follows
// the host Node's Unicode table and would make the verdict Node-version dependent.
const META_EDGE_CODE_POINTS = new Set([
    0x0020, 0x00A0, 0x1680,
    0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200A,
    0x2028, 0x2029, 0x202F, 0x205F, 0x3000
]);

function isMetaEdgeCodePoint(cp, allowLf) {
    return META_EDGE_CODE_POINTS.has(cp) || (allowLf && cp === 0x0A);
}

/**
 * The consensus text grammar for a meta field, mirrored client-side (spec 2.3).
 * A gate-local copy of the indexer's isValidMetaText: sizes in UTF-8 BYTES, no
 * locale, no trim(), no normalisation.
 * @param {*} s
 * @param {number} maxBytes
 * @param {boolean} allowLf - LF is legal inside (and at the edges of) a description
 * @returns {boolean}
 */
function isValidMetaText(s, maxBytes, allowLf) {
    if (typeof s !== 'string') return false;
    // A lone surrogate re-encodes as U+FFFD for the byte count and is refused by a
    // utf8mb4 column, so it can never be stored as written.
    if (typeof s.isWellFormed === 'function' && !s.isWellFormed()) return false;
    const bytes = Buffer.byteLength(s, 'utf8');
    if (bytes < 1 || bytes > maxBytes) return false;
    const cps = Array.from(s);
    for (const ch of cps) {
        if (isBannedMetaCodePoint(ch.codePointAt(0), allowLf)) return false;
    }
    if (isMetaEdgeCodePoint(cps[0].codePointAt(0), allowLf)) return false;
    if (isMetaEdgeCodePoint(cps[cps.length - 1].codePointAt(0), allowLf)) return false;
    return true;
}

// Read the literal name/description/version out of a `meta` object literal.
//
// Three outcomes per key, and the difference is what decides blocking vs advising:
//   - a string LITERAL: the value is known, so the grammar judges it;
//   - a NON-LITERAL expression (`'Escrow ' + x`, an identifier, a call, a template
//     literal): computed meta. The chain EVALUATES meta in the isolate and accepts
//     whatever it yields, so a static walk that cannot see the value must not
//     refuse it; the field is reported in `computed` and advised on;
//   - a literal that is not a string (`version: 1`, `name: null`): the chain
//     rejects it, and so do we, via the ordinary null read.
// A key that is simply MISSING also reads null, which is what blocks a nameless
// contract.
function readMetaLiterals(metaObj) {
    for (const p of metaObj.properties) {
        // A spread or a computed key can inject or rename any of the three fields.
        if (p.type !== 'Property' || p.computed) return { status: 'undecidable' };
    }
    const out = {
        status: 'present',
        name: null,
        description: null,
        version: null,
        computed: [],           // keys present whose value is a non-literal expression
        nonStringLiteral: [],   // keys present whose value is a literal but not a string
        line: (metaObj.loc && metaObj.loc.start && metaObj.loc.start.line) || null
    };
    for (const p of metaObj.properties) {
        const key = p.key && (p.key.name || p.key.value);
        if (key !== 'name' && key !== 'description' && key !== 'version') continue;
        const v = p.value;
        if (v && v.type === 'Literal' && typeof v.value === 'string') {
            out[key] = v.value;
        } else if (v && v.type === 'Literal') {
            out.nonStringLiteral.push(key);
        } else {
            out.computed.push(key);
        }
    }
    return out;
}

function readExportAssignments(ast) {
    let exportObj = null;      // module.exports = { ... }
    let exportName = null;     // module.exports = someIdentifier
    let seenExport = false;
    let exportAssignments = 0;           // every module.exports assignment, any scope
    const metaAssignments = new Map();   // identifier -> the node assigned to <id>.meta
    const metaAssignmentCounts = new Map();

    walk.simple(ast, {
        AssignmentExpression(node) {
            const l = node.left;
            if (!l || l.type !== 'MemberExpression' || l.computed) return;
            if (!l.object || l.object.type !== 'Identifier' || !l.property) return;
            if (l.object.name === 'module' && l.property.name === 'exports') {
                // First module.exports assignment wins; the count below is what
                // decides whether that read may be trusted at all.
                exportAssignments += 1;
                if (seenExport) return;
                seenExport = true;
                if (node.right && node.right.type === 'ObjectExpression') exportObj = node.right;
                else if (node.right && node.right.type === 'Identifier') exportName = node.right.name;
                return;
            }
            // The function-export form (spec R1): `contract.meta = { ... }`.
            if (l.property.name === 'meta') {
                metaAssignmentCounts.set(l.object.name, (metaAssignmentCounts.get(l.object.name) || 0) + 1);
                if (!metaAssignments.has(l.object.name)) metaAssignments.set(l.object.name, node.right);
            }
        }
    });

    return { exportObj, exportName, exportAssignments, metaAssignments, metaAssignmentCounts };
}

/**
 * Static read of a contract's exported `meta`, over the same acorn walk shape the
 * SDK's getExportedMethodNames uses (ES2020, script). Never throws.
 * @param {string} source
 * @returns {{status:'present',name:?string,description:?string,version:?string,
 *            computed:string[],nonStringLiteral:string[],line:?number}
 *          |{status:'absent'}|{status:'undecidable'}}
 *   present     - a `meta` object literal was found; each field is its string literal
 *                 or null, with `computed` naming the keys whose value is a
 *                 non-literal expression (the chain evaluates those, so they advise
 *                 rather than block)
 *   absent      - a literal export shape was found and it carries no `meta`
 *   undecidable - the shape is one a static read cannot judge (computed export,
 *                 spread, non-literal meta); the chain evaluates it at deploy
 */
function getExportedMeta(source) {
    let ast;
    try {
        // acorn is a hard dependency of lint_core, already required above, so an
        // unparseable source is the only way to land here.
        ast = acorn.parse(String(source), { ecmaVersion: 2020, sourceType: 'script', locations: true });
    } catch (e) {
        return { status: 'undecidable' };
    }

    const {
        exportObj, exportName, exportAssignments, metaAssignments, metaAssignmentCounts
    } = readExportAssignments(ast);

    // More than one export assignment: the isolate evaluates whichever one runs
    // LAST, and a source-order walk cannot say which that is (an assignment may
    // sit inside a function, a branch or a loop, and walk.simple visits all of
    // them). So the static read proves nothing here and must say so. This is the
    // contract stated above, not a new one: 'absent' is the single outcome that
    // PROVES the chain will answer "meta required", and a first-wins guess can
    // reach it from a source whose evaluated export carries perfectly good meta
    // (blocking a deploy the chain accepts) or miss it on the reverse ordering
    // (passing a deploy the chain refuses). Undecidable routes to an advisory, so
    // the gate advises instead of deciding on evidence it does not have.
    if (exportAssignments > 1) return { status: 'undecidable' };

    if (exportObj) {
        for (const p of exportObj.properties) {
            if (p.type !== 'Property' || p.computed) return { status: 'undecidable' };
        }
        const metaProp = exportObj.properties.find((p) => (p.key && (p.key.name || p.key.value)) === 'meta');
        if (!metaProp) return { status: 'absent' };
        if (!metaProp.value || metaProp.value.type !== 'ObjectExpression') return { status: 'undecidable' };
        return readMetaLiterals(metaProp.value);
    }

    if (exportName) {
        if (!metaAssignments.has(exportName)) return { status: 'absent' };
        // Same reasoning one level down: `c.meta = {...}; c.meta = {...}` leaves the
        // first read unprovable, so it advises rather than deciding.
        if ((metaAssignmentCounts.get(exportName) || 0) > 1) return { status: 'undecidable' };
        const right = metaAssignments.get(exportName);
        if (!right || right.type !== 'ObjectExpression') return { status: 'undecidable' };
        return readMetaLiterals(right);
    }

    // No literal export shape (e.g. `module.exports = function (xchain) {...}`, an
    // exports.foo surface, or a factory): the chain reads meta off the evaluated
    // module, so say so instead of guessing.
    return { status: 'undecidable' };
}

/**
 * Gate findings for the contract-identity rule.
 * @param {string} code
 * @returns {Array<{rule:string,message:string,line:?number,severity:string}>}
 */
function checkContractMeta(code) {
    const read = getExportedMeta(code);

    if (read.status === 'undecidable') {
        // Advisory, never blocking: rule id deliberately differs from
        // 'contract-meta' so the DEPLOY_BLOCKING filter routes it to advisories.
        return [{
            rule: 'contract-meta-undecidable',
            message: 'contract identity (meta) could not be read statically; the chain ' +
                'evaluates meta at deploy, and CONTRACT_META_REQUIRED rejects a contract ' +
                'whose evaluated meta has no valid name and description',
            line: null,
            severity: 'advisory'
        }];
    }

    if (read.status === 'absent') {
        return [{
            rule: 'contract-meta',
            message: META_VERDICTS.REQUIRED + ' - export meta: { name, description, version } ' +
                'as the first key of the contract',
            line: null,
            severity: 'error'
        }];
    }

    const findings = [];
    const computed = read.computed || [];

    // A computed field is one the chain evaluates and accepts; the gate says so and
    // moves on, rather than refusing a contract it merely cannot read.
    if (computed.length) {
        findings.push({
            rule: 'contract-meta-undecidable',
            message: 'contract identity: meta.' + computed.join(', meta.') +
                (computed.length > 1 ? ' are ' : ' is ') +
                'a computed expression, so the gate cannot check it here; the chain evaluates ' +
                'meta at deploy and CONTRACT_META_REQUIRED judges the evaluated value ' +
                '(string literals are recommended, so what you read is what the chain records)',
            line: read.line,
            severity: 'advisory'
        });
    }

    if (!computed.includes('name') && !isValidMetaText(read.name, META_NAME_MAX_BYTES, false)) {
        findings.push({ rule: 'contract-meta', message: META_VERDICTS.NAME, line: read.line, severity: 'error' });
    }
    if (!computed.includes('description') && !isValidMetaText(read.description, META_DESCRIPTION_MAX_BYTES, true)) {
        findings.push({ rule: 'contract-meta', message: META_VERDICTS.DESCRIPTION, line: read.line, severity: 'error' });
    }
    // `version` is optional: judged only when the key is present with a literal
    // value (a string that fails the grammar, or a literal that is not a string).
    const versionLiteralPresent = read.version !== null || (read.nonStringLiteral || []).includes('version');
    if (!computed.includes('version') && versionLiteralPresent
        && !isValidMetaText(read.version, META_VERSION_MAX_BYTES, false)) {
        findings.push({ rule: 'contract-meta', message: META_VERDICTS.VERSION, line: read.line, severity: 'error' });
    }
    return findings;
}

module.exports = {
    META_VERDICTS,
    META_NAME_MAX_BYTES,
    META_DESCRIPTION_MAX_BYTES,
    META_VERSION_MAX_BYTES,
    isBannedMetaCodePoint,
    META_EDGE_CODE_POINTS,
    isMetaEdgeCodePoint,
    isValidMetaText,
    readMetaLiterals,
    getExportedMeta,
    checkContractMeta
};
