/*********************************************************************
 * XChain VM — Action Validator
 *
 * Lightweight pre-validation of emitted actions before returning
 * to the indexer. Catches obvious errors early.
 ********************************************************************/

const ALLOWED_ACTIONS = new Set([
    'SEND', 'DESTROY', 'ISSUE', 'MINT', 'ORDER',
    'DISPENSER', 'DIVIDEND', 'AIRDROP', 'CALLBACK',
    'FILE', 'LIST', 'COINPAY', 'SWEEP', 'LINK', 'BROADCAST', 'MESSAGE'
]);

class ActionValidator {
    validate(action) {
        if (!ALLOWED_ACTIONS.has(action.action))
            throw new Error('unknown emission action: ' + action.action);

        if (typeof action.params !== 'object' || action.params === null)
            throw new Error('emission params must be an object');

        return true;
    }
}

module.exports = ActionValidator;
