'use strict';

const assert = require('node:assert/strict');

const {
  compare,
  expand,
  mochaArgsFor,
  splitCommand,
} = require('../../../bin/suite-title-map.js');

function mapFor(files) {
  const titleSets = {};
  const mappedFiles = {};
  for (const [file, titles] of Object.entries(files)) {
    const key = `set-${Object.keys(titleSets).length}`;
    titleSets[key] = titles;
    mappedFiles[file] = key;
  }
  return { titleSets, scripts: { test: { files: mappedFiles } } };
}

function keepsQuotedArgumentsWhole() {
  assert.deepEqual(
    splitCommand('mocha --grep "@x.*(a|b)" \'test/**/*.js\''),
    [
      { value: 'mocha', quoted: false },
      { value: '--grep', quoted: false },
      { value: '@x.*(a|b)', quoted: true },
      { value: 'test/**/*.js', quoted: true },
    ],
  );
}

function extractsEnvironmentAssignments() {
  assert.deepEqual(
    mochaArgsFor("FUZZ_RUNS=1000 mocha --timeout 0 'test/fuzz/**/*.js'"),
    {
      args: ['--timeout', '0', 'test/fuzz/**/*.js'],
      env: { FUZZ_RUNS: '1000' },
    },
  );
}

function resolvesCompositeScripts() {
  assert.deepEqual(
    mochaArgsFor('npm run test:unit && npm run test:integration'),
    { composite: ['test:unit', 'test:integration'] },
  );
}

function skipsNonMochaCommands() {
  assert.deepEqual(
    mochaArgsFor('node bin/something.js'),
    { skip: 'not a mocha command (runs node)' },
  );
}

function reportsChangedTitles() {
  const pin = mapFor({ 'test/example.test.js': ['suite old title'] });
  const fresh = mapFor({ 'test/example.test.js': ['suite new title'] });

  assert.deepEqual(compare(pin, fresh, {}), [
    {
      script: 'test',
      kind: 'title_dropped',
      file: 'test/example.test.js',
      title: 'suite old title',
    },
    {
      script: 'test',
      kind: 'title_added',
      file: 'test/example.test.js',
      title: 'suite new title',
    },
  ]);
}

function acceptsFlatPathRenames() {
  const pin = mapFor({ 'test/old.test.js': ['suite title'] });
  const fresh = mapFor({ 'test/new.test.js': ['suite title'] });
  const renames = { 'test/old.test.js': 'test/new.test.js' };

  assert.deepEqual(compare(pin, fresh, renames), []);
}

function reportsOneSidedFiles() {
  const pin = mapFor({
    'test/shared.test.js': ['shared title'],
    'test/dropped.test.js': ['dropped title'],
  });
  const fresh = mapFor({
    'test/shared.test.js': ['shared title'],
    'test/added.test.js': ['added title'],
  });

  assert.deepEqual(compare(pin, fresh, {}), [
    { script: 'test', kind: 'file_added', file: 'test/added.test.js' },
    { script: 'test', kind: 'file_dropped', file: 'test/dropped.test.js' },
  ]);
}

function structuredRenames(newTitle) {
  return {
    paths: { 'old.js': 'new.js' },
    titles: { 'new.js': { 'old title': newTitle } },
  };
}

function acceptsStructuredPathAndTitleRenames() {
  const pin = mapFor({ 'old.js': ['old title'] });
  const fresh = mapFor({ 'new.js': ['new title'] });

  assert.deepEqual(compare(pin, fresh, structuredRenames('new title')), []);
}

function reportsMismatchedStructuredTitleRenames() {
  const pin = mapFor({ 'old.js': ['old title'] });
  const fresh = mapFor({ 'new.js': ['actual title'] });

  assert.deepEqual(compare(pin, fresh, structuredRenames('declared title')), [
    {
      script: 'test',
      kind: 'title_dropped',
      file: 'new.js',
      title: 'declared title',
    },
    {
      script: 'test',
      kind: 'title_added',
      file: 'new.js',
      title: 'actual title',
    },
  ]);
}

function returnsNullForMissingScripts() {
  assert.equal(expand({ titleSets: {}, scripts: {} }, 'test:missing'), null);
}

function expandsAndSortsCollectedFiles() {
  const map = {
    titleSets: {
      first: ['first title'],
      second: ['second title', 'third title'],
    },
    scripts: {
      test: {
        files: {
          'test/z.test.js': 'second',
          'test/a.test.js': 'first',
        },
      },
    },
  };

  assert.deepEqual(expand(map, 'test'), {
    'test/a.test.js': ['first title'],
    'test/z.test.js': ['second title', 'third title'],
  });
}

function splitCommandTests() {
  it('keeps quoted grep patterns and globs as single tokens', keepsQuotedArgumentsWhole);
}

function mochaArgsForTests() {
  it('extracts leading environment assignments', extractsEnvironmentAssignments);
  it('resolves npm run composites', resolvesCompositeScripts);
  it('identifies non-mocha commands in the skip reason', skipsNonMochaCommands);
}

function compareTests() {
  it('reports dropped and added titles', reportsChangedTitles);
  it('accepts flat path renames', acceptsFlatPathRenames);
  it('reports files that exist on only one side', reportsOneSidedFiles);
  it('accepts structured path and title renames', acceptsStructuredPathAndTitleRenames);
  it('reports mismatched structured title renames', reportsMismatchedStructuredTitleRenames);
}

function expandTests() {
  it('returns null for an uncollected script', returnsNullForMissingScripts);
  it('returns the sorted flat file-to-titles view', expandsAndSortsCollectedFiles);
}

function pureHelperTests() {
  describe('splitCommand', splitCommandTests);
  describe('mochaArgsFor', mochaArgsForTests);
  describe('compare', compareTests);
  describe('expand', expandTests);
}

describe('bin/suite-title-map pure helpers', pureHelperTests);
