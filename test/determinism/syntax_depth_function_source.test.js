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
 **********************************************************************
 * Function source parity across the syntax-depth activation: a contract can read
 * String(fn) of anything it reaches, and that text and the gas to build it land in
 * hashed state. The activation changes only lint verdicts, never the metered source,
 * so these readings, taken from develop before it existed, must hold on every network.
 ********************************************************************/
'use strict';

const assert = require('assert');
const { createVM, execute, XChainVM } = require('../fuzz/helpers/harness.js');

const CODE = "module.exports = function(xchain) {\n    function add(a, b) { var c = a + b; if (c > 1) { return c; } return !!c ? 1 : 0; }\n    var twice = (x) => x * 2;\n    return String(add) + '|' + String(twice) + '|' + String(module.exports);\n};";
// [success, error, gasUsed, returnValue] per network, read on develop.
const DEVELOP = {
    "mainnet": [
        true,
        null,
        1543,
        "\"function add(a, b) {\\n      __depth_enter();\\n      try {\\n        __gas(1);\\n        var c = __concat(a, b);\\n        if (c > 1) {\\n          __gas(1);\\n          return c;\\n        }\\n        return (__gas(1), !!c) ? 1 : 0;\\n      } finally {\\n        __depth_exit();\\n      }\\n    }|x => {\\n      __depth_enter();\\n      try {\\n        return (__gas(1), x * 2);\\n      } finally {\\n        __depth_exit();\\n      }\\n    }|function (xchain) {\\n  __depth_enter();\\n  try {\\n    __gas(1);\\n    function add(a, b) {\\n      __depth_enter();\\n      try {\\n        __gas(1);\\n        var c = __concat(a, b);\\n        if (c > 1) {\\n          __gas(1);\\n          return c;\\n        }\\n        return (__gas(1), !!c) ? 1 : 0;\\n      } finally {\\n        __depth_exit();\\n      }\\n    }\\n    var twice = x => {\\n      __depth_enter();\\n      try {\\n        return (__gas(1), x * 2);\\n      } finally {\\n        __depth_exit();\\n      }\\n    };\\n    return __concat(__concat(__concat(__concat((__gas(1), String(add)), '|'), (__gas(1), String(twice))), '|'), (__gas(1), String(module.exports)));\\n  } finally {\\n    __depth_exit();\\n  }\\n}\""
    ],
    "testnet": [
        true,
        null,
        1546,
        "\"function add(a, b) {\\n      __depth_enter();\\n      try {\\n        __gas(1);\\n        var c = __concat(a, b);\\n        if (c > 1) {\\n          __gas(1);\\n          return c;\\n        }\\n        return (__gas(1), !!c) ? 1 : 0;\\n      } finally {\\n        __depth_exit();\\n      }\\n    }|x => {\\n      __depth_enter();\\n      try {\\n        return (__gas(1), x * 2);\\n      } finally {\\n        __depth_exit();\\n      }\\n    }|function (xchain) {\\n  __depth_enter();\\n  try {\\n    __gas(1);\\n    function add(a, b) {\\n      __depth_enter();\\n      try {\\n        __gas(1);\\n        var c = __concat(a, b);\\n        if (c > 1) {\\n          __gas(1);\\n          return c;\\n        }\\n        return (__gas(1), !!c) ? 1 : 0;\\n      } finally {\\n        __depth_exit();\\n      }\\n    }\\n    var twice = x => {\\n      __depth_enter();\\n      try {\\n        return (__gas(1), x * 2);\\n      } finally {\\n        __depth_exit();\\n      }\\n    };\\n    return __concat(__concat(__concat(__concat((__gas(1), String(add)), '|'), (__gas(1), String(twice))), '|'), (__gas(1), String(module.exports)));\\n  } finally {\\n    __depth_exit();\\n  }\\n}\""
    ],
    "regtest": [
        true,
        null,
        1546,
        "\"function add(a, b) {\\n      __depth_enter();\\n      try {\\n        __gas(1);\\n        var c = __concat(a, b);\\n        if (c > 1) {\\n          __gas(1);\\n          return c;\\n        }\\n        return (__gas(1), !!c) ? 1 : 0;\\n      } finally {\\n        __depth_exit();\\n      }\\n    }|x => {\\n      __depth_enter();\\n      try {\\n        return (__gas(1), x * 2);\\n      } finally {\\n        __depth_exit();\\n      }\\n    }|function (xchain) {\\n  __depth_enter();\\n  try {\\n    __gas(1);\\n    function add(a, b) {\\n      __depth_enter();\\n      try {\\n        __gas(1);\\n        var c = __concat(a, b);\\n        if (c > 1) {\\n          __gas(1);\\n          return c;\\n        }\\n        return (__gas(1), !!c) ? 1 : 0;\\n      } finally {\\n        __depth_exit();\\n      }\\n    }\\n    var twice = x => {\\n      __depth_enter();\\n      try {\\n        return (__gas(1), x * 2);\\n      } finally {\\n        __depth_exit();\\n      }\\n    };\\n    return __concat(__concat(__concat(__concat((__gas(1), String(add)), '|'), (__gas(1), String(twice))), '|'), (__gas(1), String(module.exports)));\\n  } finally {\\n    __depth_exit();\\n  }\\n}\""
    ]
};
const HEIGHTS = { mainnet: 961000, testnet: 156230, regtest: 100 };

// The regtest reading while the native stack activation is armed there: its metering
// transform weighs each frame and routes catch and finally through the depth hooks, so the
// metered source a contract reads differs from develop on regtest, independently of the
// syntax-depth activation (which never touches metering).
const NATIVE_STACK_REGTEST = [
    true,
    null,
    2263,
    "\"function add(a, b) {\\n      const __gasd = __depth_enter(1);\\n      try {\\n        __gas(1);\\n        var c = __concat(a, b);\\n        if (c > 1) {\\n          __gas(1);\\n          return c;\\n        }\\n        return (__gas(1), !!c) ? 1 : 0;\\n      } catch (__gasx) {\\n        __depth_exit(__gasx);\\n        throw __gasx;\\n      } finally {\\n        __depth_exit(__gasd, 0);\\n      }\\n    }|x => {\\n      const __gasd = __depth_enter(1);\\n      try {\\n        return (__gas(1), x * 2);\\n      } catch (__gasx) {\\n        __depth_exit(__gasx);\\n        throw __gasx;\\n      } finally {\\n        __depth_exit(__gasd, 0);\\n      }\\n    }|function (xchain) {\\n  const __gasd = __depth_enter(1);\\n  try {\\n    __gas(1);\\n    function add(a, b) {\\n      const __gasd = __depth_enter(1);\\n      try {\\n        __gas(1);\\n        var c = __concat(a, b);\\n        if (c > 1) {\\n          __gas(1);\\n          return c;\\n        }\\n        return (__gas(1), !!c) ? 1 : 0;\\n      } catch (__gasx) {\\n        __depth_exit(__gasx);\\n        throw __gasx;\\n      } finally {\\n        __depth_exit(__gasd, 0);\\n      }\\n    }\\n    var twice = x => {\\n      const __gasd = __depth_enter(1);\\n      try {\\n        return (__gas(1), x * 2);\\n      } catch (__gasx) {\\n        __depth_exit(__gasx);\\n        throw __gasx;\\n      } finally {\\n        __depth_exit(__gasd, 0);\\n      }\\n    };\\n    return __concat(__concat(__concat(__concat((__gas(1), String(add)), '|'), (__gas(1), String(twice))), '|'), (__gas(1), String(module.exports)));\\n  } catch (__gasx) {\\n    __depth_exit(__gasx);\\n    throw __gasx;\\n  } finally {\\n    __depth_exit(__gasd, 0);\\n  }\\n}\""
];

function expected(network) {
    if (network === 'regtest' && XChainVM.isNativeStackTerminalActive('regtest', 'BTC', HEIGHTS.regtest))
        return NATIVE_STACK_REGTEST;
    return DEVELOP[network];
}

describe('syntax-depth activation leaves contract-visible function source unchanged', function () {
    this.timeout(60000);

    for (const network of Object.keys(HEIGHTS)) {
        it('String(fn) of a contract function, an arrow and module.exports match develop on ' + network, async function () {
            const vm = createVM({ maxCpuTimeMs: 5000 });
            vm.beginBlock();
            try {
                const r = await execute(vm, CODE, { network, contractAddress: 'C:BTC:1',
                    blockContext: { height: HEIGHTS[network], timestamp: 4000000000, hash: 'h' } });
                assert.deepStrictEqual([r.success, r.error, r.gasUsed, r.returnValue], expected(network));
            } finally {
                vm.endBlock();
            }
        });
    }
});
