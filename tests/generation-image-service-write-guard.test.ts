import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {openAppLibrary} from '../packages/business/src/app-db/index.ts';
import type {AppLibrary} from '../packages/business/src/app-db/index.ts';
import {createProjectStore} from '../packages/business/src/project-file/store.ts';
import {createProjectServiceApplication} from '../packages/business/src/project-service-application.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createCustomImageSettingsV2} from '../packages/business/src/images/custom-settings-v2.ts';
import {DEFAULT_CUSTOM_IMAGE_CONFIGURATION_V2} from '../packages/contracts/src/generation-image-settings.ts';
import {generationImageServiceSchemas} from '../packages/contracts/src/generation-image-services.ts';
import {IMAGE_FIXED_OPTIONS} from '../packages/contracts/src/images.ts';

const quote = (value: string): string => `"${value.replaceAll('"', '""')}"`;
function databaseState(db: DatabaseSync) {
  return {
    changes: db.prepare('SELECT total_changes() AS n').get()!.n,
    databases: Object.fromEntries(db.prepare('PRAGMA database_list').all().map(database => {
      const schema = quote(String(database.name));
      const objects = db.prepare(`SELECT type,name,tbl_name,sql FROM ${schema}.sqlite_master ORDER BY type,name`).all();
      return [database.name, {
        version: db.prepare(`PRAGMA ${schema}.data_version`).get()!.data_version,
        schema: objects,
        tables: Object.fromEntries(objects.filter(object => object.type === 'table').map(table =>
          [table.name, db.prepare(`SELECT * FROM ${schema}.${quote(String(table.name))} ORDER BY rowid`).all()])),
      }];
    })),
  };
}

async function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-image-service-write-'));
  const library = openAppLibrary({dataDir: path.join(root, 'app')}), libraries = new Set<AppLibrary>([library]);
  const store = createProjectStore({projectFile: path.join(root, 'Project.mioon'), locate: () => ({localDir: path.join(root, 'records'), cacheDir: path.join(root, 'cache'), tempDir: path.join(root, 'tmp')})});
  store.tx(() => store.put('projects', {id: store.projectId, name: 'Image service write guard', description: '', revision: 1, createdAt: '2026-11-04T00:00:00.000Z', updatedAt: '2026-11-04T00:00:00.000Z'}));
  let settingsReads = 0, settingsWrites = 0, settingsTouches = 0;
  const settings = await createCustomImageSettingsV2({persistence: {load: async () => {settingsReads++; return null;}, save: async () => {settingsWrites++;}}});
  const connectionId = randomUUID(), configuration = {...DEFAULT_CUSTOM_IMAGE_CONFIGURATION_V2, enabled: true, baseUrl: 'https://images.example.com/v1', model: 'guard-model'};
  await settings.create({expectedRevision: 0, connectionId, name: 'Guarded custom images', configuration, secret: {action: 'replace', storage: 'session', value: 'synthetic-guard-image-key'}});
  const observedSettings = new Proxy(settings, {get(target, property, receiver) {settingsTouches++; return Reflect.get(target, property, receiver);}});
  const applicationOwner = new AbortController(), serviceOwner = new AbortController(), ports = createProjectServiceApplication(library, applicationOwner.signal, {});
  const services = createServices(store, new Map(), {application: ports, signal: serviceOwner.signal, env: {}, imageOptions: {autoRun: false, customSettingsV2: observedSettings}, frameOptions: {autoRun: false}, sceneOptions: {autoRun: false}});
  const input = generationImageServiceSchemas['image.service.review.prepare'].parse({connectionId, configurationRevision: 1, input: {projectId: store.projectId, requestId: randomUUID(), providerId: 'openai-compatible', model: configuration.model, name: 'Guarded image', prompt: 'No provider call', options: {...IMAGE_FIXED_OPTIONS}}});
  t.after(async () => {
    try {await services.drain();} finally {await settings.close(); store.close(); for (const current of libraries) current.close(); rmSync(root, {recursive: true, force: true});}
  });
  settingsTouches = 0;
  const state = (application = library) => ({projectAndHistory: databaseState(store.db), application: databaseState(application.db), settings: {reads: settingsReads, writes: settingsWrites, touches: settingsTouches}});
  return {root, library, libraries, store, services, applicationOwner, serviceOwner, input, state};
}

function noSqlPrepare(t: TestContext, databases: DatabaseSync[], operation: () => void) {
  const calls: number[] = databases.map(() => 0);
  const guards = databases.map((db, index) => {
    const prepare = db.prepare.bind(db);
    return t.mock.method(db, 'prepare', (sql: string) => {calls[index]++; return prepare(sql);});
  });
  try {operation(); assert.deepEqual(calls, databases.map(() => 0), 'admission rejects before preparing SQL in either owner');}
  finally {for (const guard of guards) guard.mock.restore();}
}

function privateImageWrites(f: Awaited<ReturnType<typeof fixture>>): (() => unknown)[] {
  const approval = {projectId: f.store.projectId, reviewId: randomUUID(), expectedRevision: 1};
  return [() => f.services.generationImageServices('image.service.review.prepare', f.input),
    () => f.services.imageApproval(approval), () => f.services.imageRejection(approval)];
}

test('an aborted application owner rejects private image review preparation before settings and SQL writes', async t => {
  const f = await fixture(t), before = f.state(), reason = new Error('image preparation application owner stopped');
  assert.ok(Object.hasOwn(before.projectAndHistory.databases, 'main'));
  assert.ok(Object.hasOwn(before.projectAndHistory.databases, 'project'));
  f.applicationOwner.abort(reason);
  noSqlPrepare(t, [f.store.db, f.library.db], () => {
    for (const write of privateImageWrites(f)) assert.throws(write, error => error === reason);
  });
  assert.deepEqual(f.state(), before, 'every project/history/application table, schema and write mark is unchanged');
});

test('an aborted service owner rejects the private image write before borrowing live application admission', async t => {
  const f = await fixture(t), before = f.state(); f.serviceOwner.abort();
  noSqlPrepare(t, [f.store.db, f.library.db], () => {
    for (const write of privateImageWrites(f)) assert.throws(write, {name: 'AbortError', code: 'OPERATION_CANCELLED', status: 503});
  });
  assert.deepEqual(f.state(), before);
});

test('a reopened B1 library cannot authorize private image review writes from the old application capability', async t => {
  const f = await fixture(t); f.library.close();
  const replacement = openAppLibrary({dataDir: path.join(f.root, 'app')}); f.libraries.add(replacement);
  assert.doesNotThrow(() => createProjectServiceApplication(replacement).assertMutationAllowed());
  const before = f.state(replacement), invalid = {name: 'TypeError', message: 'Project services require a live application library owner'};
  noSqlPrepare(t, [f.store.db, replacement.db], () => {
    for (const write of privateImageWrites(f)) assert.throws(write, invalid);
  });
  assert.deepEqual(f.state(replacement), before, 'the old capability cannot write through the replacement B1 owner');
});
