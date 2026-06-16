// @ts-nocheck
//
// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Determinism probe: a contract that recurses without bound and CATCHES the
// resulting stack fault, then tries to commit the depth it reached into hashed
// state. Native V8 stack depth is architecture-dependent (and varies with the
// host stack remaining at execution entry), so committing a caught native depth
// would diverge validators on different CPUs → fork.
//
// With the deterministic in-isolate depth bound in place, the fault thrown when
// the fixed limit is reached is un-swallowable: the catch cannot resume to read
// or commit any depth value, and execution fails with a deterministic
// out_of_stack status that is identical on every node. This fixture exists so the
// corpus has a catch-the-overflow scenario (the regression that previously had
// none).
module.exports = {
    // Recurse, catch the fault, and attempt to record the depth reached. If the
    // bound is enforced correctly this set() is never reached (the catch re-faults
    // before it can run), so no 'depth' key is ever committed.
    probe: function (xchain) {
        function f(n) {
            try {
                return f(n + 1);
            } catch (e) {
                return n;
            }
        }
        xchain.state.set('depth', String(f(0)));
        return 'committed';
    },

    // Bounded recursion well under the limit — must still succeed and commit its
    // result, so the guard does not break legitimate recursive contracts.
    bounded: function (xchain) {
        function sum(n) {
            if (n <= 0) return 0;
            return n + sum(n - 1);
        }
        xchain.state.set('sum', String(sum(100)));
        return 'ok';
    }
};
