/*********************************************************************
 * XChain VM — Error Types
 ********************************************************************/

class ContractRevertError extends Error {
    constructor(reason) {
        super(reason);
        this.name = 'ContractRevertError';
    }
}

class GasExhaustedError extends Error {
    constructor(used, ceiling) {
        super('gas exhausted: used ' + used + ' of ' + ceiling);
        this.name = 'GasExhaustedError';
        this.used = used;
        this.ceiling = ceiling;
    }
}

module.exports = { ContractRevertError, GasExhaustedError };
