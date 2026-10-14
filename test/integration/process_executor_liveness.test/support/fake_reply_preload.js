// Preload for a forked worker: rewrites its result replies per XVM_TEST_FAKE_REPLY.
// dup:      the real reply, then a forged reply with the SAME id
// stale:    the real reply, then the PREVIOUS reply again
// future:   the real reply, then a forged reply for id+1 (not yet dispatched)
// noresult: the real reply without its result field
// @ts-nocheck
const mode = process.env.XVM_TEST_FAKE_REPLY || '';
const realSend = process.send.bind(process);
let prev = null;
const forged = (id) => ({ type: 'result', id, result: {
    success: true, error: null, gasUsed: 1, returnValue: '"FORGED' + id + '"',
    stateChanges: [], stateDeletes: [], emittedActions: [], logs: [] } });
process.send = function (msg, ...rest) {
    if (!msg || msg.type !== 'result') return realSend(msg, ...rest);
    if (mode === 'noresult') return realSend({ type: 'result', id: msg.id, token: msg.token }, ...rest);
    const out = realSend(msg, ...rest);
    if (mode === 'dup') realSend(forged(msg.id), undefined, () => {});
    if (mode === 'stale' && prev) realSend(prev, undefined, () => {});
    if (mode === 'future') realSend(forged(msg.id + 1), undefined, () => {});
    prev = msg;
    return out;
};
