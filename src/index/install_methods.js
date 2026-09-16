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
 * XChain VM: prototype method installer
 *
 * A class split into part modules has to put the moved methods back on
 * its prototype. Object.assign would do that as ENUMERABLE own properties,
 * while methods written in a class body are non-enumerable, so the split
 * would change what for...in over an instance, Object.keys of the
 * prototype and a spread of it return. installMethods defines each moved
 * method with the flags class syntax gives (writable, configurable, not
 * enumerable), so a split prototype reads the same as the original class.
 * Same shape as the sdk helper (xchain-sdk/src/utils/install_methods.js).
 ********************************************************************/
// @ts-nocheck

// Define each source's own enumerable keys on target with class-method flags.
// Key choice and order match Object.assign (a later source wins a shared key),
// so only the enumerable flag differs. Returns target.
function installMethods(target, ...sources) {
    for (const source of sources) {
        for (const key of Reflect.ownKeys(source)) {
            if (!Object.prototype.propertyIsEnumerable.call(source, key)) continue;
            Object.defineProperty(target, key, {
                value: source[key],
                writable: true,
                enumerable: false,
                configurable: true,
            });
        }
    }
    return target;
}

module.exports = { installMethods };
