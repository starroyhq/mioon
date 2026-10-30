import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {projectFileError} from '../packages/business/src/project-file/index.ts';
import {projectAddressErrorDetailsSchemas} from '../packages/contracts/src/project-file.ts';
import {
  asProjectUnavailable, claimProjectFolder, isDatabaseMovedError, numberedProjectFolderName, PROJECT_FOLDER_FALLBACK_NAME, projectFolderName,
  projectHostError, projectIdMismatch, projectNotFound, projectUnavailable,
} from '../apps/server/src/project-host/index.ts';

const REPOSITORY = fileURLToPath(new URL('../', import.meta.url));
const HOST = path.join(REPOSITORY, 'apps/server/src/project-host');
function scratch(t: TestContext): string {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-s0-host-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  return root;
}
const bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

test('projectFolderName normalizes, replaces forbidden characters and trims white space and dots', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['我的短片', '我的短片'],
    ['A/B: "C"?', 'A-B- -C--'],
    ['\tFilm\n', 'Film'],
    ['a\tb', 'a-b'],
    [' .hidden. ', 'hidden'],
    ['...', PROJECT_FOLDER_FALLBACK_NAME],
    ['', PROJECT_FOLDER_FALLBACK_NAME],
    ['   ', PROJECT_FOLDER_FALLBACK_NAME],
    ['Cafe\u0301', 'Caf\u00e9'],
  ];
  for (const [input, expected] of cases) assert.equal(projectFolderName(input), expected, JSON.stringify(input));
  assert.equal(PROJECT_FOLDER_FALLBACK_NAME, '未命名项目');
  assert.throws(() => projectFolderName(42 as unknown as string), TypeError);
});

test('projectFolderName prefixes Windows device names, also with an extension', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['CON', '_CON'], ['con.final', '_con.final'], ['Com1', '_Com1'], ['LPT²', '_LPT²'], ['nul .txt', '_nul .txt'],
    ['COM10', 'COM10'], ['CONSOLE', 'CONSOLE'],
  ];
  for (const [input, expected] of cases) assert.equal(projectFolderName(input), expected, input);
});

test('projectFolderName keeps at most 80 UTF-8 bytes without splitting a character', () => {
  assert.equal(projectFolderName('a'.repeat(100)), 'a'.repeat(80));
  const film = projectFolderName('影'.repeat(40));
  assert.equal(film, '影'.repeat(26));
  assert.equal(bytes(film), 78);
  const clapper = projectFolderName('🎬'.repeat(30));
  assert.equal(clapper, '🎬'.repeat(20));
  assert.equal(bytes(clapper), 80);
  assert.equal(Buffer.from(clapper).toString(), clapper);
  // The cut ends on a dot, which is trimmed again.
  assert.equal(projectFolderName(`${'a'.repeat(79)}. b`), 'a'.repeat(79));
});

test('numberedProjectFolderName appends the sequence within the byte limit', () => {
  assert.equal(numberedProjectFolderName('Film', 1), 'Film');
  assert.equal(numberedProjectFolderName('Film', 2), 'Film 2');
  assert.equal(numberedProjectFolderName('a'.repeat(80), 12), `${'a'.repeat(77)} 12`);
  const numbered = numberedProjectFolderName('影'.repeat(26), 999);
  assert.equal(numbered, `${'影'.repeat(25)} 999`);
  assert.ok(bytes(numbered) <= 80);
  for (const sequence of [0, 1000, 1.5]) assert.throws(() => numberedProjectFolderName('Film', sequence), RangeError, String(sequence));
});

test('claimProjectFolder takes the first free numbered folder and never reuses an entry', t => {
  const parent = scratch(t);
  mkdirSync(path.join(parent, 'Film'));
  writeFileSync(path.join(parent, 'Film 2'), '');
  const claimed = claimProjectFolder(parent, 'Film');
  assert.deepEqual(claimed, {folder: path.join(parent, 'Film 3'), name: 'Film 3', projectFile: path.join(parent, 'Film 3', 'Film 3.mioon')});
  assert.ok(statSync(claimed.folder).isDirectory());
  assert.ok(!existsSync(claimed.projectFile));
  assert.throws(() => claimProjectFolder(path.join(parent, 'missing'), 'Film'), (error: unknown) => (error as {code?: unknown}).code === 'ENOENT');
  const full = path.join(parent, 'full');
  mkdirSync(full);
  writeFileSync(path.join(full, 'X'), '');
  for (let sequence = 2; sequence <= 999; sequence++) writeFileSync(path.join(full, `X ${sequence}`), '');
  assert.throws(() => claimProjectFolder(full, 'X'), (error: unknown) => {
    const failure = error as {code?: unknown; status?: unknown; details?: {projectFile?: unknown}};
    return failure.code === 'PROJECT_FILE_EXISTS' && failure.status === 409 && failure.details?.projectFile === path.join(full, 'X', 'X.mioon');
  });
});

/** Module names of every static and dynamic import in a source text. */
function importedModules(source: string): string[] {
  const modules: string[] = [];
  for (const match of source.matchAll(/\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s+['"]([^'"]+)['"]/gmu)) {
    modules.push(match[1] ?? match[2] ?? match[3]);
  }
  return modules;
}

test('types, naming and errors import no Node module, so the web app can use them', () => {
  const read = (file: string): string => readFileSync(file, 'utf8');
  for (const name of ['types.ts', 'naming.ts', 'errors.ts']) {
    const modules = importedModules(read(path.join(HOST, name)));
    assert.deepEqual(modules.filter(module => module.startsWith('node:')), [], name);
  }
  assert.deepEqual(importedModules(read(path.join(HOST, 'types.ts'))), []);
  assert.deepEqual(importedModules(read(path.join(HOST, 'naming.ts'))), []);
  const contracts = [...new Set(importedModules(read(path.join(HOST, 'errors.ts'))))].sort();
  assert.deepEqual(contracts, ['../../../../packages/contracts/src/app-error.ts', '../../../../packages/contracts/src/project-file.ts']);
  for (const contract of contracts) {
    const modules = importedModules(read(path.resolve(HOST, contract)));
    assert.deepEqual(modules.filter(module => module.startsWith('node:')), [], contract);
  }
  assert.deepEqual(importedModules("import {a} from 'x';\nimport type {B} from \"node:y\";\nawait import('z');\nimport 'w';"), ['x', 'node:y', 'z', 'w']);
});

test('addressing and host errors carry the contract codes, statuses and details', () => {
  const projectId = randomUUID();
  const notFound = projectNotFound(projectId);
  assert.equal(notFound.code, 'PROJECT_NOT_FOUND');
  assert.equal(notFound.status, 404);
  projectAddressErrorDetailsSchemas.PROJECT_NOT_FOUND.parse(notFound.details);
  const mismatch = projectIdMismatch(projectId);
  assert.equal(mismatch.code, 'PROJECT_ID_MISMATCH');
  assert.equal(mismatch.status, 400);
  projectAddressErrorDetailsSchemas.PROJECT_ID_MISMATCH.parse(mismatch.details);
  const cause = new Error('locked');
  const unavailable = projectUnavailable(projectId, 'PROJECT_LOCKED', cause);
  assert.equal(unavailable.code, 'PROJECT_UNAVAILABLE');
  assert.equal(unavailable.status, 409);
  assert.deepEqual(projectAddressErrorDetailsSchemas.PROJECT_UNAVAILABLE.parse(unavailable.details), {projectId, reason: 'PROJECT_LOCKED'});
  assert.equal(unavailable.cause, cause);
  const kernel = projectFileError('PROJECT_INVALID', {database: 'project', reason: 'not-a-project-file'});
  const mapped = asProjectUnavailable(projectId, kernel) as {code?: unknown; details?: {reason?: unknown}; cause?: unknown};
  assert.equal(mapped.code, 'PROJECT_UNAVAILABLE');
  assert.equal(mapped.details?.reason, 'PROJECT_INVALID');
  assert.equal(mapped.cause, kernel);
  const other = new Error('x');
  assert.equal(asProjectUnavailable(projectId, other), other);
  const stopped = projectHostError('PROJECT_HOST_STOPPED');
  assert.equal(stopped.code, 'PROJECT_HOST_STOPPED');
  assert.equal(stopped.status, 503);
  assert.equal(projectHostError('PROJECT_FILE_MOVED').status, 409);
});

test('isDatabaseMovedError recognizes SQLITE_READONLY_DBMOVED, also as the cause of a kernel error', () => {
  const moved = Object.assign(new Error('attempt to write a readonly database'), {errcode: 1032});
  assert.equal(isDatabaseMovedError(moved), true);
  const kernel = projectFileError('PROJECT_INVALID', {database: 'project', reason: 'unusable'});
  kernel.cause = moved;
  assert.equal(isDatabaseMovedError(kernel), true);
  // SQLITE_READONLY itself is a read-only location, not a move.
  assert.equal(isDatabaseMovedError(Object.assign(new Error('readonly'), {errcode: 8})), false);
  assert.equal(isDatabaseMovedError(null), false);
});
