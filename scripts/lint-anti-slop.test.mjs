import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkDiagnostics, parseReport } from './lint-anti-slop.mjs';

const source = 'const value = input as User;\n';

const error = {
  filename: 'src/example.ts',
  code: 'anti-slop(require-safety-comment-for-type-assertion)',
  message: 'Missing safety comment',
  severity: 'error',
  labels: [{ span: { line: 1, column: 15 } }],
};

const readSource = () => source;
const baseline = checkDiagnostics([error], {}, readSource).entries;

test('accepts existing debt and allows resolved errors to be pruned', () => {
  assert.equal(checkDiagnostics([error], baseline, readSource).accepted, 1);
  assert.deepEqual(
    checkDiagnostics([error], baseline, readSource).unexpected,
    []
  );
  assert.deepEqual(checkDiagnostics([], baseline, readSource).entries, {});
});

test('rejects new rules, files, source, and duplicate occurrences', () => {
  for (const diagnostic of [
    { ...error, code: 'anti-slop(no-chained-type-assertions)' },
    { ...error, filename: 'src/new.ts' },
  ]) {
    assert.equal(
      checkDiagnostics([diagnostic], baseline, readSource).unexpected.length,
      1
    );
  }

  assert.equal(
    checkDiagnostics([error], baseline, () => 'const other = data as User;')
      .unexpected.length,
    1
  );
  assert.equal(
    checkDiagnostics([error, error], baseline, readSource).unexpected.length,
    1
  );
});

test('line shifts, CRLF, indentation, and path separators preserve identity', () => {
  const shifted = {
    ...error,
    filename: 'src\\example.ts',
    labels: [{ span: { line: 2, column: 17 } }],
  };

  assert.deepEqual(
    checkDiagnostics(
      [shifted],
      baseline,
      () => `// unrelated\r\n  ${source.trim()}\r\n`
    ).unexpected,
    []
  );
});

test('parser/config and unrelated errors cannot enter the baseline', () => {
  for (const diagnostic of [
    { ...error, code: 'oxc(parser)' },
    { ...error, code: 'eslint(no-undef)' },
    { ...error, labels: [] },
    { ...error, filename: undefined },
  ]) {
    const result = checkDiagnostics([diagnostic], {}, readSource);
    assert.deepEqual(result.entries, {});
    assert.equal(result.unexpected.length, 1);
  }
});

test('native companion errors are baselineable; warnings remain non-blocking', () => {
  const native = { ...error, code: 'oxc(no-accumulating-spread)' };
  assert.equal(
    Object.keys(checkDiagnostics([native], {}, readSource).entries).length,
    1
  );
  assert.deepEqual(
    checkDiagnostics([{ ...error, severity: 'warning' }], {}, readSource),
    { entries: {}, unexpected: [], accepted: 0 }
  );
});

test('fails closed on process failures or invalid linter output', () => {
  const report = (diagnostics) => JSON.stringify({ diagnostics });
  assert.deepEqual(parseReport({ status: 1, stdout: report([error]) }), [
    error,
  ]);
  assert.deepEqual(parseReport({ status: 0, stdout: report([]) }), []);

  for (const result of [
    { error: new Error('spawn failed') },
    { status: null, stderr: 'killed' },
    { status: 2, stderr: 'bad config' },
    { status: 0, stdout: 'not json' },
    { status: 0, stdout: '{}' },
    { status: 1, stdout: report([]) },
  ]) {
    assert.throws(() => parseReport(result));
  }
});
