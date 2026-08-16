const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// The coverage ratchet keeps its floors in two places: bin/coverage-thresholds.json,
// which is what a human reads, and the c8 flags inside the coverage:check npm script,
// which is what CI obeys. Every one of those files says "keep both in sync" and
// nothing enforced it, so a floor could describe a ratchet the job was not running.
// The failure mode is not hypothetical: xchain-dashboard's ci.yml called a
// coverage:check script that did not exist in that repo at all, a job that could only
// ever exit 1, and the missing-script case is asserted here for that reason.
describe('coverage ratchet floors', () => {
  const repoRoot = path.join(__dirname, '..', '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const declared = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'bin', 'coverage-thresholds.json'), 'utf8'),
  );

  it('ships the coverage:check script the CI coverage job invokes', () => {
    assert.equal(
      typeof (pkg.scripts || {})['coverage:check'],
      'string',
      'ci.yml runs `npm run coverage:check`; without the script the job can only exit 1',
    );
  });

  it('enforces every declared floor, at the declared value', () => {
    const script = pkg.scripts['coverage:check'];
    for (const metric of ['lines', 'statements', 'branches', 'functions']) {
      const flag = script.match(new RegExp('--' + metric + '\\s+([0-9.]+)'));
      assert.ok(flag, `coverage:check does not enforce --${metric}, so that floor is decorative`);
      assert.equal(
        Number(flag[1]),
        declared[metric],
        `${metric} floor drifted: thresholds.json says ${declared[metric]}, coverage:check enforces ${flag[1]}`,
      );
    }
  });

  it('fails the job on a shortfall rather than only reporting it', () => {
    assert.match(pkg.scripts['coverage:check'], /--check-coverage/);
  });
});

// The ratchet also has a SCOPE, and scope drift breaks it as quietly as a floor
// does. src/process-executor.js forks a child and speaks IPC to it: the unit suite
// can construct it and read a knob back, nothing more, so it is measured by
// coverage:subprocess against the integration suite instead. It stayed out of the
// unit report by accident until a unit test required it, at which point it entered
// at 53% and dropped the whole ratchet 1.9 points with no coverage actually lost.
// Excluding it is only honest while it is still measured somewhere, so that is
// asserted here too, and the excludes on coverage:check and coverage have to agree
// or the report a human reads describes a different set than the job enforces.
describe('coverage ratchet scope', () => {
  const repoRoot = path.join(__dirname, '..', '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const declared = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'bin', 'coverage-thresholds.json'), 'utf8'),
  );

  const excludesOf = (script) =>
    [...script.matchAll(/--exclude\s+'([^']+)'/g)].map((m) => m[1]);
  const includesOf = (script) =>
    [...script.matchAll(/--include\s+'([^']+)'/g)].map((m) => m[1]);

  it('declares the unit-scope excludes it enforces', () => {
    assert.ok(
      Array.isArray(declared.unitScopeExcludes),
      'thresholds.json must declare unitScopeExcludes, or nothing states what the ratchet leaves out',
    );
    assert.deepEqual(
      excludesOf(pkg.scripts['coverage:check']).sort(),
      [...declared.unitScopeExcludes].sort(),
      'thresholds.json and coverage:check disagree about what the unit ratchet measures',
    );
  });

  it('measures the same set in the report a human reads', () => {
    assert.deepEqual(
      excludesOf(pkg.scripts.coverage).sort(),
      excludesOf(pkg.scripts['coverage:check']).sort(),
      'coverage and coverage:check must scope identically or the report cannot explain the gate',
    );
    assert.deepEqual(includesOf(pkg.scripts.coverage), includesOf(pkg.scripts['coverage:check']));
  });

  it('still measures every excluded file under the subprocess ratchet', () => {
    const subprocessIncludes = includesOf(pkg.scripts['coverage:subprocess']);
    for (const excluded of declared.unitScopeExcludes) {
      assert.ok(
        subprocessIncludes.includes(excluded),
        `${excluded} is excluded from the unit ratchet and measured by no other one, so it is unmeasured`,
      );
    }
  });

  it('excludes only files that exist, so a rename cannot leave a dead exclude', () => {
    for (const excluded of declared.unitScopeExcludes) {
      assert.ok(
        fs.existsSync(path.join(repoRoot, excluded)),
        `${excluded} is excluded from the ratchet but no such file exists`,
      );
    }
  });
});
