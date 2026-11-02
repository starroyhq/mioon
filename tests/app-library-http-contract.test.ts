import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {startServer} from '../apps/server/src/index.ts';
import {openAppLibrary, MAX_RECENT_PROJECTS} from '../packages/business/src/app-db/index.ts';
import type {AppLibrary} from '../packages/business/src/app-db/index.ts';
import {APP_LIBRARY_HTTP_ERROR_CODES, APP_LIBRARY_HTTP_ERROR_STATUS, appLibraryHttpFailureSchema,
  appLibraryHttpFailureEnvelopeSchema} from '../packages/contracts/src/app-library-http.ts';

const token = 'app-library-http-synthetic-token';
const privateText = 'SYNTHETIC_PRIVATE_DOCUMENT_CONTENT';
const quote = (name: string): string => '"' + name.replaceAll('"', '""') + '"';
function sqlState(db: DatabaseSync) {
  const schema = db.prepare('SELECT type,name,tbl_name,sql FROM main.sqlite_schema ORDER BY type,name').all();
  const rows = Object.fromEntries(schema.filter(row => row.type === 'table').map(row =>
    [String(row.name), db.prepare(`SELECT * FROM main.${quote(String(row.name))} ORDER BY rowid`).all()]));
  return {schema, rows};
}
/** Metadata only while SQLite is held. Never open a live library to hash it. */
function tree(root: string): unknown[] {
  const entries: unknown[] = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const file = path.join(directory, name), info = lstatSync(file);
      entries.push([path.relative(root, file), info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other', info.mode, info.size]);
      if (info.isDirectory()) visit(file);
    }
  };
  visit(root); return entries;
}
const hash = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');
function noPrivateData(value: unknown, root: string): void {
  const wire = JSON.stringify(value);
  for (const secret of [root, token, privateText, 'synthetic-api-key-must-stay-private']) assert.equal(wire.includes(secret), false);
}
async function fixture(t: TestContext, seed: (library: AppLibrary, root: string) => void) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-app-http-contract-'));
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  t.after(async () => {await server?.close(); rmSync(root, {recursive: true, force: true});});
  const library = openAppLibrary({dataDir: root});
  let before: ReturnType<typeof sqlState>, databaseFile: string;
  try {seed(library, root); before = sqlState(library.db); databaseFile = library.databaseFile;}
  finally {library.close();}
  const databaseBefore = hash(databaseFile);
  server = await startServer({dataDir: root, port: 0, token, comfyModule: 'skip'});
  return {root, before, databaseFile, databaseBefore, server,
    async request(route: string, input?: unknown) {
      const response = await fetch(server!.url + route, {method: input === undefined ? 'GET' : 'POST', headers: {
        authorization: `Bearer ${token}`, ...(input === undefined ? {} : {'content-type': 'application/json'}), connection: 'close',
      }, ...(input === undefined ? {} : {body: JSON.stringify(input)})});
      return {status: response.status, body: await response.json() as unknown};
    },
    async assertUnchanged() {
      await server!.close();
      assert.equal(hash(databaseFile), databaseBefore, 'the closed app database retains its exact bytes');
      const reopened = openAppLibrary({dataDir: root});
      try {assert.deepEqual(sqlState(reopened.db), before, 'all app rows and schema remain unchanged');}
      finally {reopened.close();}
    },
  };
}

test('the application HTTP error contract accepts only observed codes and exact public details', () => {
  assert.deepEqual(APP_LIBRARY_HTTP_ERROR_CODES, ['APP_LIBRARY_LIMIT', 'APP_LIBRARY_INVALID']);
  assert.deepEqual(APP_LIBRARY_HTTP_ERROR_STATUS, {APP_LIBRARY_LIMIT: 507, APP_LIBRARY_INVALID: 422});
  const full = {code: 'APP_LIBRARY_LIMIT', message: '应用库的记录已达上限', details: {limit: MAX_RECENT_PROJECTS}, retryable: false};
  const invalid = {code: 'APP_LIBRARY_INVALID', message: '应用库的结构无效', details: {reason: 'unusable'}, retryable: false};
  for (const error of [full, invalid]) {
    assert.deepEqual(appLibraryHttpFailureEnvelopeSchema.parse({ok: false, error}), {ok: false, error});
    assert.equal(appLibraryHttpFailureSchema.safeParse({...error, file: '/private/app-library.db'}).success, false);
    assert.equal(appLibraryHttpFailureSchema.safeParse({...error, details: {...error.details, path: '/private/app-library.db'}}).success, false);
    assert.equal(appLibraryHttpFailureSchema.safeParse({...error, retryable: true}).success, false);
    assert.equal(appLibraryHttpFailureEnvelopeSchema.safeParse({ok: false, error, data: {}}).success, false);
  }
  for (const code of ['APP_LIBRARY_LOCKED', 'APP_LIBRARY_FORMAT_NEWER', 'APP_LIBRARY_CLOSED']) {
    assert.equal(appLibraryHttpFailureSchema.safeParse({...invalid, code}).success, false);
  }
  assert.equal(appLibraryHttpFailureSchema.safeParse({...full, details: {limit: 0}}).success, false);
  assert.equal(appLibraryHttpFailureSchema.safeParse({...invalid, details: {reason: 'schema', differences: ['private source']}}).success, false);
});

test('a full real application registry returns HTTP 507 without creating project files or changing app SQL', {timeout: 60_000}, async t => {
  const f = await fixture(t, (library, root) => library.tx(() => {
    for (let index = 0; index < MAX_RECENT_PROJECTS; index++) library.registry.upsert({
      projectId: randomUUID(), projectFile: path.join(root, privateText, String(index), 'missing.mioon'),
      fileIdentity: {dev: '0', ino: '0'}, name: 'Synthetic missing project', lastOpenedAt: null, summary: null,
    });
  }));
  assert.equal(existsSync(path.join(f.root, 'projects')), false);
  const beforeTree = tree(f.root);
  const response = await f.request('/api/rpc', {operation: 'project.create', input: {name: 'Must not be created'}});
  assert.equal(response.status, APP_LIBRARY_HTTP_ERROR_STATUS.APP_LIBRARY_LIMIT);
  const envelope = appLibraryHttpFailureEnvelopeSchema.parse(response.body), error = envelope.error;
  assert.equal(error.code, 'APP_LIBRARY_LIMIT'); assert.deepEqual(error.details, {limit: MAX_RECENT_PROJECTS});
  noPrivateData(envelope, f.root);
  assert.deepEqual(tree(f.root), beforeTree, 'registry admission rejects before any project tree mutation');
  assert.equal(existsSync(path.join(f.root, 'projects')), false);
  await f.assertUnchanged();
});

test('a malformed real diagnostic document returns HTTP 422 without exposing its contents or acquiring a project', async t => {
  const f = await fixture(t, (library, root) => {
    library.db.prepare('INSERT INTO app_documents(name,data) VALUES(?,?)').run('agent-diagnostic-summary-v1.json',
      JSON.stringify({privatePath: path.join(root, privateText), apiKey: 'synthetic-api-key-must-stay-private'}));
  });
  const beforeTree = tree(f.root);
  const response = await f.request('/api/agent/tasks/v2/diagnostics/latest');
  assert.equal(response.status, APP_LIBRARY_HTTP_ERROR_STATUS.APP_LIBRARY_INVALID);
  const envelope = appLibraryHttpFailureEnvelopeSchema.parse(response.body);
  assert.equal(envelope.error.code, 'APP_LIBRARY_INVALID'); assert.deepEqual(envelope.error.details, {reason: 'unusable'});
  noPrivateData(envelope, f.root);
  assert.deepEqual(tree(f.root), beforeTree);
  assert.equal(existsSync(path.join(f.root, 'projects')), false); assert.equal(existsSync(path.join(f.root, 'records')), false);
  await f.assertUnchanged();
});
