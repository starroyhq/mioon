import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readdirSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const REPOSITORY = fileURLToPath(new URL('../', import.meta.url));
const SCANNED = ['apps', 'packages', 'scripts', 'server'];
const SKIPPED = new Set(['node_modules', 'dist', 'dist-opacity-candidate', 'build', 'release']);
const EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']);
const MESSAGE = '项目文件只能经 packages/business/src/project-file/ 的内核打开';

/** Production files that may open an SQLite file: the kernel (including its one
 * open of the project file alone before the local records), today's workspace
 * store with its migration, backup and restore code until S0 and S7 remove
 * them, the desktop migration guard, and the app database B1 adds (a connection
 * of its own, not a project file). Entries need not exist. */
const ALLOWED_OPENERS = [
  'packages/business/src/project-file/**',
  'packages/business/src/db.ts',
  'packages/business/src/workspace-*.ts',
  'packages/business/src/opacity-*.ts',
  'apps/desktop/scripts/migration-restore-guard.ts',
  'packages/business/src/app-db/**',
];

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const globPattern = (glob: string): RegExp =>
  new RegExp(`^${glob.split('**').map(part => part.split('*').map(escape).join('[^/]*')).join('.*')}$`);
const ALLOWED = ALLOWED_OPENERS.map(globPattern);
const isAllowed = (relative: string): boolean => ALLOWED.some(pattern => pattern.test(relative));

const IDENTIFIER = '[A-Za-z_$][\\w$]*';
interface Opener {
  readonly line: number;
  readonly text: string;
}
/** Every `new DatabaseSync(…)` in a source text, also as `new x.DatabaseSync(…)`
 * and through the aliases of `import {DatabaseSync as D}` and
 * `const {DatabaseSync: D} = …`, unless its first argument is the literal
 * ':memory:'. Comments count as well. */
function detectOpeners(source: string): Opener[] {
  const aliases = new Set<string>();
  for (const match of source.matchAll(new RegExp(`\\bDatabaseSync\\s+as\\s+(${IDENTIFIER})`, 'g'))) aliases.add(match[1]);
  for (const match of source.matchAll(new RegExp(`\\bDatabaseSync\\s*:\\s*(${IDENTIFIER})`, 'g'))) aliases.add(match[1]);
  const constructors = [`(?:${IDENTIFIER}\\s*\\.\\s*)?DatabaseSync`, ...[...aliases].map(escape)];
  const lines = source.split('\n');
  const openers: Opener[] = [];
  for (const match of source.matchAll(new RegExp(`\\bnew\\s+(?:${constructors.join('|')})\\s*\\(`, 'g'))) {
    const index = match.index ?? 0;
    if (/^\s*(['"`]):memory:\1/.test(source.slice(index + match[0].length))) continue;
    const line = source.slice(0, index).split('\n').length;
    openers.push({line, text: lines[line - 1].trim()});
  }
  return openers;
}

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, {withFileTypes: true})) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.') && !SKIPPED.has(entry.name)) files.push(...sourceFiles(full));
    } else if (entry.isFile() && EXTENSIONS.has(path.extname(entry.name))) {
      files.push(full);
    }
  }
  return files;
}
const relativePath = (file: string): string => path.relative(REPOSITORY, file).split(path.sep).join('/');

test('detectOpeners finds every construction of DatabaseSync, also through aliases', () => {
  const positives = [
    'const db = new DatabaseSync(file);',
    'const db = new sqlite.DatabaseSync(file, {readOnly: true});',
    "import {DatabaseSync as Database} from 'node:sqlite';\nconst db = new Database(file);",
    "const {DatabaseSync: Database} = await import('node:sqlite');\nconst db = new Database(file);",
    "new DatabaseSync('x.mioon')",
    'new DatabaseSync (\n  file)',
    '// new DatabaseSync(projectFile)',
  ];
  for (const source of positives) assert.equal(detectOpeners(source).length, 1, source);
  const negatives = [
    "new DatabaseSync(':memory:')",
    'new DatabaseSync(":memory:", {timeout: 0})',
    'new DatabaseSync(`:memory:`)',
    "import {DatabaseSync as Database} from 'node:sqlite';\nnew Database(':memory:');",
    "import type {DatabaseSync} from 'node:sqlite';\nlet db: DatabaseSync | undefined;\nfunction use(handle: DatabaseSync): DatabaseSync { return handle; }",
    'const prepare = Reflect.apply(DatabaseSync.prototype.prepare, db, [sql]);',
    'new DatabaseSyncOptions(file); new MyDatabaseSync(file);',
  ];
  for (const source of negatives) assert.deepEqual(detectOpeners(source), [], source);
  assert.deepEqual(detectOpeners('x;\n  const db = new DatabaseSync(file);'), [{line: 2, text: 'const db = new DatabaseSync(file);'}]);
});

test('the allow-list matches by prefix and wildcard, whether or not the entries exist', () => {
  for (const allowed of ['packages/business/src/project-file/connection.ts', 'packages/business/src/project-file/cross-file/install.ts',
    'packages/business/src/db.ts', 'packages/business/src/workspace-restore.ts', 'packages/business/src/opacity-upgrade.ts',
    'apps/desktop/scripts/migration-restore-guard.ts', 'packages/business/src/app-db/connection.ts']) {
    assert.ok(isAllowed(allowed), allowed);
  }
  for (const refused of ['apps/server/src/zz-guard-probe.ts', 'packages/business/src/db.tsx', 'packages/business/src/workspaces/restore.ts',
    'packages/business/src/services.ts', 'packages/business/src/project-file.ts', 'packages/contracts/src/project-file.ts']) {
    assert.ok(!isAllowed(refused), refused);
  }
});

test('production code opens SQLite files only through the project-file kernel', () => {
  const offenders: string[] = [];
  for (const top of SCANNED) {
    const directory = path.join(REPOSITORY, top);
    if (!existsSync(directory)) continue;
    for (const file of sourceFiles(directory)) {
      const relative = relativePath(file);
      if (isAllowed(relative)) continue;
      for (const opener of detectOpeners(readFileSync(file, 'utf8'))) offenders.push(`${relative}:${opener.line}: ${opener.text}`);
    }
  }
  assert.deepEqual(offenders, [], `${MESSAGE}：\n${offenders.join('\n')}`);
});

test('the kernel imports db.ts and services.ts only as types', () => {
  const kernel = path.join(REPOSITORY, 'packages', 'business', 'src', 'project-file');
  const forbidden = new Set(['db.ts', 'services.ts'].map(name => path.join(REPOSITORY, 'packages', 'business', 'src', name)));
  const statements = /^[ \t]*(?:import|export)[ \t]+(type[ \t]+)?(?:[^;'"`]*?\sfrom[ \t]*)?(['"])([^'"\n]+)\2|\bimport\s*\(\s*(['"])([^'"\n]+)\4\s*\)/gm;
  const offenders: string[] = [];
  let typeOnly = 0;
  for (const file of sourceFiles(kernel)) {
    for (const match of readFileSync(file, 'utf8').matchAll(statements)) {
      const specifier = match[3] ?? match[5];
      if (!specifier.startsWith('.') || !forbidden.has(path.resolve(path.dirname(file), specifier))) continue;
      if (match[1] !== undefined) typeOnly++;
      else offenders.push(`${relativePath(file)}: ${match[0].trim()}`);
    }
  }
  assert.deepEqual(offenders, [], 'S0 makes db.ts open its stores through the kernel, so the kernel may not load db.ts or services.ts');
  assert.ok(typeOnly > 0, 'store.ts takes WorkspaceStore from db.ts as a type');
});
