/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 ********************************************************************/
// @ts-nocheck

const ARGUMENT_LENGTH = 12000;
const FUNCTIONS = Object.freeze([
    'encodeURIComponent',
    'decodeURIComponent',
    'encodeURI',
    'decodeURI',
    'escape',
    'unescape',
    'parseInt',
    'parseFloat',
]);
const FORMS = Object.freeze([
    ['primitive', 's'],
    ['new String', 'boxed'],
    ['toString', 'custom'],
]);

function contractSource(fn, form, argument) {
    const balanceToStringCall = form === 'toString' ? '' : 'custom.toString();';
    const radix = fn === 'parseInt' ? ',10' : '';
    return `module.exports=function(){
        var s=String(5).repeat(${ARGUMENT_LENGTH});
        var boxed=new String(s);
        var custom={toString:function(){return s;}};
        ${balanceToStringCall}
        var result=${fn}(${argument}${radix});
        return typeof result;
    };`;
}

const VECTORS = Object.freeze(FUNCTIONS.flatMap((fn) => FORMS.map(([form, argument]) => Object.freeze({
    fn,
    form,
    code: contractSource(fn, form, argument),
}))));

module.exports = { ARGUMENT_LENGTH, VECTORS };
