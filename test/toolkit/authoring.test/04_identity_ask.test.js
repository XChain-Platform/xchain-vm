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
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const { renderIdentityAsk } = require('../../../src/toolkit/authoring/prompt_builders.js');

describe('Toolkit authoring: identity ask', function () {
    it('asks the model for both identity fields when neither is supplied', function () {
        const ask = renderIdentityAsk({});

        assert(!ask.includes('Use exactly this'));
        assert(ask.endsWith(
            'Choose a name and a one-line description that describes what the contract does, from the request below.'
        ));
    });

    it('pins a supplied description and asks the model for only the name', function () {
        const ask = renderIdentityAsk({ description: 'Two-party escrow.' });

        assert(ask.includes('Use exactly this description: "Two-party escrow.".'));
        assert(ask.includes('Choose a name that describes what the contract does'));
        assert(!ask.includes('Use exactly this name'));
    });

    it('treats a blank name and null description as missing', function () {
        assert.strictEqual(
            renderIdentityAsk({ name: '   ', description: null }),
            renderIdentityAsk({})
        );
    });

    it('trims and pins both supplied identity fields without asking the model to choose', function () {
        const ask = renderIdentityAsk({ name: '  Vault ', description: 'Holds funds.' });

        assert(ask.includes('Use exactly this name: "Vault".'));
        assert(!ask.includes('Choose'));
    });

    it('stringifies a non-string name before pinning it', function () {
        const ask = renderIdentityAsk({ name: 42 });

        assert(ask.includes('Use exactly this name: "42".'));
    });
});
