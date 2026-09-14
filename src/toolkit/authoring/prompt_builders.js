const {
    MODEL_SHIFTS,
    NATIVE_PRIMITIVES,
    CONCEPT_MAP,
    HARD_RULES,
    CONTRACT_SHAPE
} = require('./authoring_knowledge.js');

// Prompt construction

function renderConceptMap() {
    return CONCEPT_MAP
        .map((r) => '- `' + r.solidity + '` -> ' + r.xchain + (r.note ? '  (' + r.note + ')' : ''))
        .join('\n');
}

function renderNativePrimitives() {
    return NATIVE_PRIMITIVES
        .map((r) => '- ' + r.want + ': in Solidity you\'d ' + r.solidity + '; on XChain use ' + r.xchain)
        .join('\n');
}

function renderNumbered(list) {
    return list.map((s, i) => (i + 1) + '. ' + s).join('\n');
}

/**
 * The system prompt: everything the model needs to write a gate-clean XChain
 * contract, independent of the specific request. Deterministic (no timestamps),
 * so it is snapshot-testable.
 * @param {object} [opts]
 * @param {boolean} [opts.typescript] - ask for a TypeScript contract (types erased at build)
 * @returns {string}
 */
function buildSystemPrompt(opts = {}) {
    const lang = opts.typescript ? 'TypeScript (erasable types only: no enums, namespaces, or decorators)' : 'JavaScript';
    return [
        'You are an expert XChain Platform smart-contract author. An XChain contract is a ' +
            'DETERMINISTIC ' + lang + ' program run in a sandboxed V8 isolate. It custodies tokens ' +
            'and emits validated protocol ACTIONs; it never mutates the ledger directly.',
        '',
        'THREE MODEL SHIFTS an EVM/Solidity developer must respect:',
        renderNumbered(MODEL_SHIFTS),
        '',
        'BEFORE writing a contract, prefer a native protocol primitive when one fits:',
        renderNativePrimitives(),
        '',
        'SOLIDITY -> XCHAIN CONCEPT MAP:',
        renderConceptMap(),
        '',
        'HARD RULES. The on-chain deploy gate REJECTS a violation of most of these and the ' +
            'contract never deploys. Two are exceptions to that mechanism, not to the rule: ' +
            'a contract touching a deleted host global deploys clean and then THROWS on its ' +
            'first execution, and a decimal number literal is reported as a linter WARNING ' +
            'that still deploys, leaving native floating-point arithmetic running on chain. ' +
            'None of the three is recoverable after the fact, so treat every rule below as ' +
            'blocking:',
        renderNumbered(HARD_RULES),
        '',
        'CONTRACT SHAPE:',
        '```javascript',
        CONTRACT_SHAPE,
        '```',
        '',
        'OUTPUT FORMAT: reply with exactly one fenced code block containing the complete ' +
            'single-file contract, then (optional) a short "Notes:" section. Do not split the ' +
            'contract across multiple code blocks. No prose inside the code block except comments.'
    ].join('\n');
}

// The identity ask, first thing in the user message. It is asked UP FRONT rather
// than left to the repair loop because a missing `meta` is a deploy REJECTION, not
// a style note, and a round trip to discover that costs a model call. A caller who
// already knows the name/description pins them; otherwise the model proposes them
// from the brief.
function renderIdentityAsk(opts) {
    const name = opts.name == null ? '' : String(opts.name).trim();
    const description = opts.description == null ? '' : String(opts.description).trim();
    const lines = [
        'FIRST, give the contract its on-chain identity. Export `meta` as the FIRST key of the ' +
            'contract with a `name` (1..64 bytes), a one-line `description` (1..512 bytes) and a ' +
            '`version` ("1.0.0" for a new contract). They are REQUIRED: a deploy without them is ' +
            'rejected, and they are what a wallet and the explorer show beside the contract address. ' +
            'Use plain string literals.'
    ];
    if (name) lines.push('Use exactly this name: ' + JSON.stringify(name) + '.');
    if (description) lines.push('Use exactly this description: ' + JSON.stringify(description) + '.');
    if (!name || !description) {
        lines.push('Choose ' +
            (!name && !description ? 'a name and a one-line description' : (!name ? 'a name' : 'a one-line description')) +
            ' that describes what the contract does, from the request below.');
    }
    return lines.join(' ');
}

/**
 * Build the user message for an authoring request.
 * @param {object} opts
 * @param {'describe'|'from-solidity'} opts.mode
 * @param {string} opts.input - English brief (describe) or Solidity source (from-solidity)
 * @param {string} [opts.name] - pin the contract's meta.name (else the model proposes one)
 * @param {string} [opts.description] - pin the contract's meta.description
 * @returns {string}
 */
function buildUserPrompt(opts = {}) {
    const mode = opts.mode || 'describe';
    const input = String(opts.input == null ? '' : opts.input);
    const identity = renderIdentityAsk(opts);
    if (mode === 'from-solidity') {
        return [
            identity,
            '',
            'Translate the following Solidity contract into the equivalent XChain contract. ' +
                'Where a native XChain primitive replaces the whole contract (e.g. an ERC-20 is ' +
                'just an ISSUE action), say so instead of porting it. In a "Notes:" section after ' +
                'the code, explain the meaningful DIFFERENCES from the Solidity original ' +
                '(msg.value -> DEPOSIT, synchronous return -> callback, reentrancy handling, etc.).',
            '',
            'Solidity source:',
            '```solidity',
            input,
            '```'
        ].join('\n');
    }
    // describe (English brief)
    return [
        identity,
        '',
        'Write an XChain smart contract that does the following:',
        '',
        input,
        '',
        'If a native protocol primitive already covers this without a contract, say so in a ' +
            '"Notes:" section and provide the smallest useful contract (or none).'
    ].join('\n');
}

/**
 * Full prompt for one authoring request: { system, user, messages }.
 * `messages` is the chat-style array ([{role,content}...]) most clients accept.
 * @param {object} opts - { mode, input, typescript? }
 */
function buildAuthoringPrompt(opts = {}) {
    if (opts.mode && opts.mode !== 'describe' && opts.mode !== 'from-solidity') {
        throw new Error('unknown authoring mode: ' + opts.mode + ' (use "describe" or "from-solidity")');
    }
    const system = buildSystemPrompt(opts);
    const user = buildUserPrompt(opts);
    return {
        system,
        user,
        messages: [
            { role: 'system', content: system },
            { role: 'user', content: user }
        ]
    };
}

/**
 * A repair message that feeds the deploy-gate errors back to the model so it can
 * fix the previous attempt. This is the loop that makes the harness reliable:
 * the model does not have to be perfect, it has to converge.
 * @param {string} previousCode - the (already TS-stripped) code that failed
 * @param {object} gateResult   - a runGate() result with .errors
 * @returns {string}
 */
function buildRepairPrompt(previousCode, gateResult) {
    const errs = (gateResult && gateResult.errors) || [];
    const lines = errs.map((e) => '- ' + (e.line ? 'line ' + e.line + ': ' : '') +
        (e.rule ? e.rule + ': ' : '') + e.message);
    return [
        'The previous contract FAILS the XChain deploy determinism gate and would be rejected ' +
            'on deploy. Fix every error below and return the corrected complete contract in one ' +
            'fenced code block. Do not introduce new violations of the HARD RULES.',
        '',
        'Gate errors:',
        lines.length ? lines.join('\n') : '- (none reported; ensure the export shape is a module.exports object or function)',
        '',
        'Previous contract:',
        '```javascript',
        String(previousCode),
        '```'
    ].join('\n');
}

module.exports = {
    renderConceptMap,
    renderNativePrimitives,
    renderNumbered,
    buildSystemPrompt,
    renderIdentityAsk,
    buildUserPrompt,
    buildAuthoringPrompt,
    buildRepairPrompt
};
