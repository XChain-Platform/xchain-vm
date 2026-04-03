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

function buildEmitAPI(gasTracker, emissionCollector, gasSchedule) {
    const charge = () => gasTracker.charge(gasSchedule.VM_EMISSION);

    return {
        send: (params) => {
            charge();
            validateRequired(params, ['destination', 'tick', 'quantity']);
            emissionCollector.add('SEND', params);
        },
        destroy: (params) => {
            charge();
            validateRequired(params, ['tick', 'quantity']);
            emissionCollector.add('DESTROY', params);
        },
        issue: (params) => {
            charge();
            validateRequired(params, ['tick']);
            emissionCollector.add('ISSUE', params);
        },
        mint: (params) => {
            charge();
            validateRequired(params, ['tick', 'quantity']);
            emissionCollector.add('MINT', params);
        },
        order: (params) => {
            charge();
            validateRequired(params, ['giveAmount', 'getAmount']);
            emissionCollector.add('ORDER', params);
        },
        dispenser: (params) => {
            charge();
            emissionCollector.add('DISPENSER', params);
        },
        dividend: (params) => {
            charge();
            validateRequired(params, ['tick', 'dividendTick', 'quantity']);
            emissionCollector.add('DIVIDEND', params);
        },
        airdrop: (params) => {
            charge();
            validateRequired(params, ['tick', 'quantity', 'listActionIndex']);
            emissionCollector.add('AIRDROP', params);
        },
        callback: (params) => {
            charge();
            validateRequired(params, ['tick']);
            emissionCollector.add('CALLBACK', params);
        },
        file: (params) => {
            charge();
            emissionCollector.add('FILE', params);
        },
        list: (params) => {
            charge();
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
            emissionCollector.add('SWEEP', params);
        },
        link: (params) => {
            charge();
            validateRequired(params, ['coin1', 'coin1ActionIndex', 'coin2', 'coin2ActionIndex']);
            emissionCollector.add('LINK', params);
        },
        broadcast: (params) => {
            charge();
            emissionCollector.add('BROADCAST', params);
        },
        message: (params) => {
            charge();
            validateRequired(params, ['destination']);
            emissionCollector.add('MESSAGE', params);
        }
    };
}

module.exports = { buildEmitAPI };
