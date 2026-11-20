// Run after next build, before copying the three trees into the runtime image.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const next = 'node_modules/next';
const vendor = `${next}/dist/compiled/picomatch/index.js`;

// Original bytes verified against the exact SQL081 runtime image and the installed package.
const originals = new Map([
  [vendor, '607dc79784c1161c33076903769dba23e63d9d9ccfe3c4695a32ebe3a5ab892d'],
  [
    `${next}/dist/shared/lib/match-local-pattern.js`,
    'cc23677cf4fc74d286018f8d5f045e51e443942f3856c3f050d5ba911e3333f4',
  ],
  [
    `${next}/dist/shared/lib/match-remote-pattern.js`,
    'badb6bbe2005556fcb6ed70e39b2327475bf6da0e7ac5ccf32e9983e5ee18c20',
  ],
]);

const launcherDigest =
  '725d2150a28b8355d7b1e2cbaa32e9b80ea162fd027d247c9aa57e87b5aea2ea';

const marker =
  /picomatch|Expected pattern to be a non-empty string|POSIX_REGEX_SOURCE|\bmakeRe\b/i;

// Same fixed predicate as the prototype; it never compiles the input pattern.
const replacement = `exports.makeRe = (pattern, opts) => pattern === '**' && opts?.dot === true && Object.keys(opts).length === 1
  ? {test: path => typeof path === 'string' && !/[\\n\\r\\u2028\\u2029]/u.test(path) && !path.split('/').some(s => s === '.' || s === '..')}
  : {test: () => false};`;

function requireCondition(ok, message) {
  if (!ok) throw new Error(message);
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON in ${label}`);
  }
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function* shippedJs(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    requireCondition(!entry.isSymbolicLink(), `Symlink not allowed: ${file}`);

    if (entry.isDirectory()) {
      yield* shippedJs(file);
    } else {
      requireCondition(entry.isFile(), `Not a regular file: ${file}`);

      if (/\.[cm]?js$/i.test(entry.name)) yield file;
    }
  }
}

function requireImageRule(images, label) {
  requireCondition(
    isDeepStrictEqual(images?.localPatterns, [
      { pathname: '**', search: '' },
    ]) &&
      isDeepStrictEqual(images?.remotePatterns, []) &&
      isDeepStrictEqual(images?.domains, []),
    `Unexpected image rules in ${label}`
  );
}

function fix(args) {
  requireCondition(
    args.length === 3,
    'Usage: node <file> <standalone root> <static dir> <public dir>'
  );
  const roots = args.map((arg) => resolve(arg));

  for (const root of roots) {
    requireCondition(fs.realpathSync(root) === root, `Symlinked root: ${root}`);
    requireCondition(
      fs.lstatSync(root).isDirectory(),
      `Not a directory: ${root}`
    );
  }

  const [standalone] = roots;

  const pinned = new Map(
    [...originals].map(([file, hash]) => [join(standalone, file), hash])
  );

  let scanned = 0;

  // The builder owns these trees exclusively. Reject even internal symlinks so no shipped file is skipped.
  for (const root of roots) {
    for (const file of shippedJs(root)) {
      scanned++;
      const bytes = fs.readFileSync(file);

      if (pinned.has(file)) {
        requireCondition(
          digest(bytes) === pinned.get(file),
          `Unexpected original bytes: ${file}`
        );
      } else {
        requireCondition(
          !marker.test(file.slice(root.length)) &&
            !marker.test(bytes.toString('utf8')),
          `Unexpected matcher reference: ${file}`
        );
      }
    }
  }

  for (const file of pinned.keys()) {
    requireCondition(
      fs.existsSync(file) && fs.lstatSync(file).isFile(),
      `Missing original file: ${file}`
    );
  }

  const read = (file) => {
    const path = join(standalone, file);
    requireCondition(
      fs.lstatSync(path).isFile(),
      `Not a regular file: ${path}`
    );

    return fs.readFileSync(path, 'utf8');
  };

  requireCondition(
    parseJson(read(`${next}/package.json`), 'Next package.json')?.version ===
      '16.4.6',
    'Expected Next 16.4.6'
  );
  const launcher = read('server.js');
  const assignment = /^const nextConfig = ([^\n]+)$/m;
  const serialized = assignment.exec(launcher)?.[1];
  // Verify the launcher actually uses the literal as its config without executing the launcher.
  requireCondition(
    serialized &&
      digest(launcher.replace(assignment, 'const nextConfig = <JSON>')) ===
        launcherDigest,
    'Unexpected standalone server.js layout'
  );
  const config = parseJson(serialized, 'standalone server.js');
  requireCondition(
    JSON.stringify(config) === serialized,
    'Expected Next JSON serialization in standalone server.js'
  );

  const manifest = parseJson(
    read('.next/required-server-files.json'),
    'required-server-files.json'
  );

  requireImageRule(config?.images, 'standalone server.js');
  requireImageRule(manifest?.config?.images, 'required-server-files.json');
  requireCondition(
    isDeepStrictEqual(config.images, manifest.config.images),
    'Standalone and manifest image config differ'
  );

  // Next may have hardlinked the traced file to the builder's dependency. Replace only its directory entry.
  const destination = join(standalone, vendor);
  const temp = fs.mkdtempSync(join(dirname(destination), '.matcher-'));

  try {
    const staged = join(temp, 'index.js');
    fs.writeFileSync(staged, replacement, { flag: 'wx' });
    fs.chmodSync(staged, fs.statSync(destination).mode & 0o777);
    fs.renameSync(staged, destination);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }

  console.log(
    `Standalone image matcher replaced after scanning ${scanned} shipped JS files.`
  );
}

try {
  fix(process.argv.slice(2));
} catch (error) {
  console.error(`Standalone image matcher guard: ${error.message}`);
  process.exitCode = 1;
}
