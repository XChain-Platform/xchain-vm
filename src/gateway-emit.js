/*********************************************************************
 * XChain VM — Emit API
 *
 * Each emit method validates basic parameter shape, charges gas,
 * and queues the action. Full validation happens in the indexer.
 ********************************************************************/

function validateRequired(params, fields) {
    if (typeof params !== 'object' || params === null)
        throw new Error('emit params must be an object');
    for (const field of fields) {
        if (params[field] === undefined || params[field] === null)
            throw new Error('emit: missing required field: ' + field);
    }
}

// Type validation for common emission fields.
// Catches misuse early before reaching the indexer.
function validateTypes(params, typeSpec) {
    for (const [field, type] of Object.entries(typeSpec)) {
        if (params[field] !== undefined && params[field] !== null) {
            if (typeof params[field] !== type)
                throw new Error('emit: field ' + field + ' must be a ' + type + ', got ' + typeof params[field]);
        }
    }
}

function buildEmitAPI(gasTracker, emissionCollector, gasSchedule) {
    const charge = () => gasTracker.charge(gasSchedule.VM_EMISSION);

    return {
        send: (params) => {
            charge();
            validateRequired(params, ['destination', 'tick', 'quantity']);
            validateTypes(params, { destination: 'string', tick: 'string', quantity: 'string' });
            emissionCollector.add('SEND', params);
        },
        destroy: (params) => {
            charge();
            validateRequired(params, ['tick', 'quantity']);
            validateTypes(params, { tick: 'string', quantity: 'string' });
            emissionCollector.add('DESTROY', params);
        },
        issue: (params) => {
            charge();
            validateRequired(params, ['tick']);
            validateTypes(params, { tick: 'string' });
            emissionCollector.add('ISSUE', params);
        },
        mint: (params) => {
            charge();
            validateRequired(params, ['tick', 'quantity']);
            validateTypes(params, { tick: 'string', quantity: 'string' });
            emissionCollector.add('MINT', params);
        },
        order: (params) => {
            charge();
            validateRequired(params, ['giveAmount', 'getAmount']);
            validateTypes(params, { giveAmount: 'string', getAmount: 'string' });
            emissionCollector.add('ORDER', params);
        },
        dispenser: (params) => {
            charge();
            if (typeof params !== 'object' || params === null) params = {};
            emissionCollector.add('DISPENSER', params);
        },
        dividend: (params) => {
            charge();
            validateRequired(params, ['tick', 'dividendTick', 'quantity']);
            validateTypes(params, { tick: 'string', dividendTick: 'string', quantity: 'string' });
            emissionCollector.add('DIVIDEND', params);
        },
        airdrop: (params) => {
            charge();
            validateRequired(params, ['tick', 'quantity', 'listActionIndex']);
            validateTypes(params, { tick: 'string', quantity: 'string' });
            emissionCollector.add('AIRDROP', params);
        },
        callback: (params) => {
            charge();
            validateRequired(params, ['tick']);
            validateTypes(params, { tick: 'string' });
            emissionCollector.add('CALLBACK', params);
        },
        file: (params) => {
            charge();
            if (typeof params !== 'object' || params === null) params = {};
            emissionCollector.add('FILE', params);
        },
        list: (params) => {
            charge();
            if (typeof params !== 'object' || params === null) params = {};
            emissionCollector.add('LIST', params);
        },
        coinpay: (params) => {
            charge();
            validateRequired(params, ['orderMatchActionIndex']);
            emissionCollector.add('COINPAY', params);
        },
        sweep: (params) => {
            charge();
            validateRequired(params, ['destination']);
            validateTypes(params, { destination: 'string' });
            emissionCollector.add('SWEEP', params);
        },
        link: (params) => {
            charge();
            validateRequired(params, ['coin1', 'coin1ActionIndex', 'coin2', 'coin2ActionIndex']);
            validateTypes(params, { coin1: 'string', coin2: 'string' });
            emissionCollector.add('LINK', params);
        },
        broadcast: (params) => {
            charge();
            if (typeof params !== 'object' || params === null) params = {};
            emissionCollector.add('BROADCAST', params);
        },
        message: (params) => {
            charge();
            validateRequired(params, ['destination']);
            validateTypes(params, { destination: 'string' });
            emissionCollector.add('MESSAGE', params);
        }
    };
}

module.exports = { buildEmitAPI };
