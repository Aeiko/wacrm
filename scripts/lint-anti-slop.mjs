import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const baselinePath = resolve(root, '.anti-slop-baseline.json');

function fingerprint(diagnostic, readSource) {
  const { filename, code, message, labels } = diagnostic;

  if (
    !filename ||
    !labels?.length ||
    !(code?.startsWith('anti-slop(') || code === 'oxc(no-accumulating-spread)')
  ) {
    return null;
  }

  const lines = readSource(filename).split(/\r?\n/);

  const context = labels.map(({ span }) => {
    assert.ok(Number.isInteger(span.line) && span.line > 0);
    assert.ok(span.line <= lines.length);

    return lines[span.line - 1].trim();
  });

  // shortcut: identical diagnostics on identical lines in one file share a count; use AST identities if that proves insufficient.
  const hash = createHash('sha256')
    .update(JSON.stringify([message, context]))
    .digest('hex');

  return `${filename.replaceAll('\\', '/')}|${code}|${hash}`;
}

export function checkDiagnostics(diagnostics, baseline, readSource) {
  const remaining = { ...baseline };
  const entries = {};
  const unexpected = [];
  let accepted = 0;

  for (const diagnostic of diagnostics) {
    if (diagnostic.severity !== 'error') continue;

    const key = fingerprint(diagnostic, readSource);

    if (key) entries[key] = (entries[key] ?? 0) + 1;

    if (key && remaining[key] > 0) {
      remaining[key]--;
      accepted++;
    } else {
      unexpected.push(diagnostic);
    }
  }

  return { entries, unexpected, accepted };
}

export function parseReport(result) {
  if (result.error) throw result.error;

  assert.ok(
    result.status === 0 || result.status === 1,
    `Oxlint failed (exit ${result.status}): ${result.stderr}`
  );
  const report = JSON.parse(result.stdout);
  assert.ok(Array.isArray(report.diagnostics), 'Missing Oxlint diagnostics');
  assert.ok(
    result.status === 0 ||
      report.diagnostics.some((d) => d.severity === 'error'),
    'Oxlint failed without error diagnostics'
  );

  return report.diagnostics;
}

function main() {
  const args = process.argv.slice(2);
  assert.ok(
    args.length === 0 || (args.length === 1 && args[0] === '--update'),
    'Usage: node scripts/lint-anti-slop.mjs [--update]'
  );
  const update = args[0] === '--update';
  const exists = existsSync(baselinePath);
  assert.ok(exists || update, 'Missing .anti-slop-baseline.json');

  const baseline = exists
    ? JSON.parse(readFileSync(baselinePath, 'utf8'))
    : { version: 1, entries: {} };

  assert.equal(baseline.version, 1, 'Unsupported baseline version');
  assert.ok(
    Object.values(baseline.entries).every(
      (count) => Number.isSafeInteger(count) && count > 0
    ),
    'Invalid baseline counts'
  );

  const result = spawnSync(
    process.execPath,
    [resolve(root, 'node_modules/oxlint/bin/oxlint'), '--format', 'json'],
    { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
  );

  const diagnostics = parseReport(result);
  const sources = new Map();

  const readSource = (filename) => {
    if (!sources.has(filename)) {
      sources.set(filename, readFileSync(resolve(root, filename), 'utf8'));
    }

    return sources.get(filename);
  };

  const { entries, unexpected, accepted } = checkDiagnostics(
    diagnostics,
    baseline.entries,
    readSource
  );

  // Only an explicit first capture may add debt; subsequent updates only prune it.
  const failures =
    update && !exists
      ? unexpected.filter((d) => !fingerprint(d, readSource))
      : unexpected;

  if (failures.length) {
    for (const d of failures.slice(0, 30)) {
      const span = d.labels?.[0]?.span;
      console.error(
        `${d.filename ?? '<config>'}:${span?.line ?? 0}:${span?.column ?? 0} ${d.code ?? 'error'}: ${d.message}`
      );
    }

    console.error(
      `${failures.length} new error(s). Fix them; baseline updates cannot add violations. Run npm run lint:anti-slop:full for all diagnostics.`
    );
    process.exitCode = 1;

    return;
  }

  if (update) {
    const sorted = Object.fromEntries(
      Object.entries(entries).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    );

    writeFileSync(
      baselinePath,
      `${JSON.stringify({ version: 1, entries: sorted }, null, 2)}\n`
    );
    console.log('Updated baseline (existing debt only).');
  }

  const errors = diagnostics.filter((d) => d.severity === 'error').length;
  const warnings = diagnostics.filter((d) => d.severity === 'warning').length;

  const removed =
    Object.values(baseline.entries).reduce((sum, n) => sum + n, 0) - accepted;

  console.log(
    `Anti-slop: no new errors; ${errors} existing errors, ${warnings} warnings.`
  );

  if (exists && removed > 0 && !update) {
    console.log(
      `Prune ${removed} resolved entry/entries: npm run lint:anti-slop:update`
    );
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
