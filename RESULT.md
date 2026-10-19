# Lane report: cx-xc-5722

## Files touched
- scripts/mutation-report.js -> bin/mutation-report.js (git mv, content unchanged; ROOT resolves the same since bin/ and scripts/ are both one level deep)
- package.json: mutation:report now runs node bin/mutation-report.js

## Verify status: NOT MET (blocked by files outside Surfaces)
- test -z "$(git ls-files scripts)": pass
- git ls-files --error-unmatch bin/mutation-report.js: pass
- git grep for (node|bash|sh) scripts/ in package.json and .github: pass (no matches)
- npm test: FAIL. Mocha aborts at load (exit 1, no pass/fail counts) because
  test/unit/meta/scripts_mutation_report.test.js line 27 reads ../../../scripts/mutation-report.js (ENOENT).

## Needed outside Surfaces (not edited)
- test/unit/meta/scripts_mutation_report.test.js: change SRC to bin/mutation-report.js (and its describe title if pins require).
- bin/pins/at1-suite-titles.json, bin/pins/suite-title-renames.json, bin/pins/dead-code-sweep.txt (line 18 lists scripts/mutation-report.js): path/title references; may need updates depending on pin checks.
- README.md mentions only "mutation-report scripting" in prose; no change required.
- bin/reachability.js already treats bin/ as tooling; no change needed.

Orchestrator: a follow-up row covering the test and pin files is required before npm test can pass.

RUN-COMPLETE db5da5cc92ee984caa73a8ca54c0a289
