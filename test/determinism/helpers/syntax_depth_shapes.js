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
 * Probe shapes for the syntax-depth determinism test: the delimiter-free chains the
 * 64-delimiter scan cannot see, and delimiter nesting with the nesting row off.
 ********************************************************************/
'use strict';

const SHAPES = {
    not: (n) => 'var x = ' + '!'.repeat(n) + '1;',
    assign: (n) => 'var a; var x = ' + 'a = '.repeat(n) + '1;',
    plus: (n) => 'var a = 1; var x = a' + ' + a'.repeat(n) + ';',
    ternary: (n) => 'var a = 1; var x = ' + 'a ? 1 : '.repeat(n) + '1;',
    elseif: (n) => 'var a = 1; ' + 'if (a) a = 1; else '.repeat(n) + 'a = 2;',
    arrow: (n) => 'var f = ' + 'a => '.repeat(n) + '1;',
    calls: (n) => 'var f = function(){ return f; }; var x = f' + '()'.repeat(n) + ';',
    brackets: (n) => 'var x = ' + '['.repeat(n) + ']'.repeat(n) + ';',
};
const wrap = (body) => 'module.exports = function(xchain) {\n' + body + '\nreturn 1;\n};';

module.exports = { SHAPES, wrap };
