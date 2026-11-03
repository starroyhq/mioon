



import type {FixtureStoryboardExport,FixtureExport, FixtureProject, FixtureTimeline} from './helpers/strict-timeline-core-types.ts';
type StrictIntersection<T> = (T extends unknown ? (value: T)=>void : never) extends ((value: infer I)=>void) ? I : never;
import type {TypedStore as FixtureStore, TypedServices as FixtureServices} from './helpers/strict-service-responses.ts';
import type {SQLInputValue,SQLOutputValue} from 'node:sqlite';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID, createHash} from 'node:crypto';
import {mkdtemp, mkdir, readFile, writeFile, readdir, rm, stat} from 'node:fs/promises';
import {readdirSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {isTimelineRenderRecord, publicValue} from '@mioon/contracts';
import {isTimelineExportAudioOutcome} from '@mioon/contracts/timeline-export-float';
import {isProjectDatabase} from '../packages/business/src/project-file/held-files.ts';
import {createServices} from '../packages/business/src/services.ts';
import {testProjectAppLibrary} from '../packages/business/src/project-service-application.ts';
import {databaseFiles, dataFileSnapshot} from './helpers/data-file-snapshot.ts';
import {startWorker} from '../packages/business/src/jobs.ts';
import {onMediaProcess, type MediaProcessEvent} from '../packages/business/src/media-processes.ts';


import {createTimelineFloatAudioAccumulator} from '../packages/business/src/timeline-float-audio-check.ts';
import {claimFloatTimelineExport, bindFloatTimelineMeasurement, bindFloatTimelineFailure, ownedFloatTimelineMeasurement,
  floatSnapshotSha256} from '../packages/business/src/timeline-float-outcome.ts';
import {schemaObjects,withoutForeignKeys,withoutProcessTargetRevisions,createServerProject,openServerProject,foreignKeyCheck} from './helpers/project-database.ts';
import {withNativeTriggerFault} from './helpers/current-native-fault.ts';
import {storeTableSchema} from '../packages/business/src/store-layout.ts';
import type { BinaryLike } from 'crypto';

const PROFILE = 'mp4_h264_float_checked_v2';
const settings = () => ({profileId: PROFILE, resolution: 'short_360', rateControl: {mode: 'crf', quality: 'standard'}});
const sha = (value: Buffer<ArrayBuffer>|BinaryLike) => createHash('sha256').update(value).digest('hex');
const plain = <T>(value:T):T => JSON.parse(JSON.stringify(value));
const byName = (a: {name: string}, b: {name: string}) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
// Rows keep the loose type the SQL table listing gave them; tests name the columns they read.
const rows = (db: DatabaseSync): Record<string, Record<string,SQLOutputValue>[]> => Object.fromEntries(schemaObjects(db).filter(({type}) => type === 'table').sort(byName)
  .map(({schema,name}) => [isProjectDatabase(db) ? `${schema}.${name}` : name, plain(db.prepare(`SELECT rowid AS __rowid__,* FROM "${schema}"."${name}" ORDER BY rowid`).all())]));
const badSnapshot = (error?: Error&{ code: string; status?: number; details?: { mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[];[key: string]: unknown; }; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; }) => (error as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; terminationUnconfirmed?: boolean}).code === 'INVALID_TIMELINE_SNAPSHOT';
const receipt = (f: Awaited<ReturnType<typeof fixture>>, input: { requestId: unknown; }) => f.store.db.prepare('SELECT * FROM timeline_requests WHERE requestId=?').get(((((input.requestId) as unknown as SQLInputValue | Record<string, SQLInputValue>)) as unknown as Parameters<NonNullable<(ReturnType<(((typeof f)["store"])["db"])["prepare"]>)["get"]>>[0]));

// Tiny explicit IEEE-float WAV generated in memory. The source is never clipped,
// normalized or replaced when a saved timeline gain is changed later.
function floatWav(value: number|undefined = 0.7, frames: number|undefined = 4800) {
  const bytes = Buffer.alloc(44 + frames * 8);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(3, 20); bytes.writeUInt16LE(2, 22);
  bytes.writeUInt32LE(48000, 24); bytes.writeUInt32LE(384000, 28); bytes.writeUInt16LE(8, 32); bytes.writeUInt16LE(32, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(frames * 8, 40);
  for (let offset = 44; offset < bytes.length; offset += 4) bytes.writeFloatLE(value, offset);
  return bytes;
}
function measurement(peak: number|undefined = 0.5, frames: number|undefined = 3) {
  const accumulator = createTimelineFloatAudioAccumulator(frames), samples = Buffer.alloc(frames * 1600 * 8);
  for (let offset = 0; offset < samples.length; offset += 4) samples.writeFloatLE(peak, offset);
  accumulator.write(samples); return accumulator.finish();
}
async function fixture(t: test.TestContext, {gain = 1} = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'mioon-float-recovery-')),created=createServerProject(dataDir,{name:'Float recovery 🎬'}),root=created.store.projectDir;
  let store = (created.store as FixtureStore), checks = 0, inspect:(input?:unknown,context?:unknown)=>Promise<{status:string;code:string}> = async () => {checks++; return {status: 'available', code: 'EXPORT_CAPABILITY_AVAILABLE'};};
  let services = (createServices(store, new Map(), {exportOptions: {inspect: (...args) => inspect(...args)}}) as FixtureServices);
  const _strictFixtureBase = {root, get store() {return store;}, get services() {return services;}, get checks() {return checks;},
    input: <P extends Record<string,unknown>=Record<never,never>>(extra: P = {} as P):P & {projectId:string;expectedRevision:number;requestId:string} => ({projectId: f.project.id, expectedRevision: (f.timeline)!.revision, requestId: randomUUID(), purpose: 'export', exportSettings: settings(), ...extra}),
    setInspect: (fn: (input?:unknown,context?:unknown) => Promise<{ status: string; code: string; }>) => {inspect = fn;}, state: () => rows(store.db),
    async restart() {
      await services.drain(); store.close();
      store = (openServerProject(dataDir,created.projectId) as FixtureStore); services = (createServices(store, new Map(), {exportOptions: {inspect: (...args) => inspect(...args)}}) as FixtureServices);
    },
  };
 const f = _strictFixtureBase as typeof _strictFixtureBase & {project: FixtureProject; timeline?: FixtureTimeline};
  t.after(async () => {await services.drain(); store.close(); await rm(dataDir, {recursive: true, force: true});});
  f.project = store.get('projects',created.projectId) as FixtureProject;
  f.timeline = await services.call('timeline.get', {projectId: f.project.id});
  f.timeline = await services.call('timeline.track.add', {projectId: f.project.id, expectedRevision: f.timeline.revision, requestId: randomUUID(), kind: 'audio'});
  const bytes = floatWav(), id = randomUUID(), relativePath = `media/${id}.wav`;
  await writeFile(path.join(root, relativePath), bytes, {mode: 0o600, flag: 'wx'});
  (f as typeof f & {asset:({ id: `${string}-${string}-${string}-${string}-${string}`; projectId: string; name: string; mimeType: string; sha256: string; relativePath: string; width: number; height: number; duration: number; hasAudio: boolean; sizeBytes: number; provenance: string; createdAt: string; })}).asset = store.put('assets', {id, projectId: f.project.id, name: 'Owned float WAV', mimeType: 'audio/wav', sha256: sha(bytes), relativePath,
    width: 0, height: 0, duration: 0.1, hasAudio: true, sizeBytes: bytes.length, provenance: 'user-import', createdAt: new Date().toISOString()});
  f.timeline = await services.call('timeline.clip.add', {projectId: f.project.id, expectedRevision: f.timeline.revision, requestId: randomUUID(),
    trackId: (f.timeline.tracks.find((track) => track.kind === 'audio'))!.id, assetId: id, startFrame: 0, durationFrames: 3, gain});
  return f;
}
async function tick(f: Awaited<ReturnType<typeof fixture>>, observe?: { (event: { type: string; kind: string; }): void; (event: { type: string; kind: string; pid: unknown; }): void; (arg0: MediaProcessEvent): void; }|undefined) {
  const events: (import("../packages/business/src/media-processes.ts").MediaProcessEvent)[] = [], off = onMediaProcess(event => {events.push(event); observe?.(event);}), worker = startWorker(f.store, f.services, new Map());
  try {await worker.tick();} finally {off(); await worker.stop();}
  return events;
}
function terminal(f: Awaited<ReturnType<typeof fixture>>, accepted: FixtureExport, peak: number|undefined = 1.4, {success = false} = {}) {
  const claim = claimFloatTimelineExport((f.store.get('exports', accepted.id)! as FixtureExport), new Date().toISOString());
  let output = null;
  if (success) {
    const id = randomUUID(), asset = {id, projectId: f.project.id, name: 'Synthetic existing output', mimeType: 'video/mp4',
      relativePath: `media/export-${accepted.id}-${randomUUID()}.mp4`, sha256: 'b'.repeat(64), sizeBytes: 20,
      width: 360, height: 640, duration: 0.1, hasAudio: true, provenance: 'export', createdAt: new Date().toISOString(), url: `/media/${id}`};
    f.store.put('assets', asset); output = {assetId: id, sha256: asset.sha256};
  }
  const report = bindFloatTimelineMeasurement(claim, measurement(peak), new Date().toISOString(), output);
  return f.store.put('exports', {...(claim as unknown as FixtureExport), status: success ? 'succeeded' : 'failed', assetId: output?.assetId ?? null,
    url: output ? `/media/${output.assetId}` : null, audioCheck: report,
    error: success ? null : {code: 'EXPORT_AUDIO_OVER_RANGE', message: 'Lower the saved gains and request a new export.', retryable: false}});
}


async function storyboardFixture(f: Awaited<ReturnType<typeof fixture>>, projectId?: string) {
  const shot = await f.services.call('shot.create', {projectId, requestId: randomUUID(), title: 'Synthetic storyboard'});
  const jobId = randomUUID(), versionId = randomUUID(), assetId = randomUUID(), createdAt = new Date().toISOString();
  f.store.put('assets', {id: assetId, projectId, name: 'Missing synthetic source', mimeType: 'video/mp4',
    relativePath: `media/${assetId}.mp4`, sha256: 'e'.repeat(64), sizeBytes: 20, width: 720, height: 1280,
    duration: 0.1, hasAudio: true, provenance: 'synthetic-mock', createdAt});
  f.store.put('jobs', {id: jobId, projectId, shotId: shot.id, versionId, status: 'succeeded'});
  f.store.put('versions', {id: versionId, projectId, jobId, shotId: shot.id, assetId, sha256: 'e'.repeat(64), createdAt});
  f.store.put('shots', {...shot, selectedVersionId: versionId});
}

test('storyboard and float timeline request keys remain separate in both orders and across projects', async t => {
  for (const crossProject of ([false, true] as const)) for (const timelineFirst of ([false, true] as const)) {
    await t.test(`crossProject=${crossProject}, timelineFirst=${timelineFirst}`, async t => {
      const f = await fixture(t), owner = crossProject ? await fixture(t) : f, projectId = owner.project.id;
      const capture = () => [f.state(), ...(owner === f ? [] : [owner.state()])];
      await owner.services.call('timeline.get', {projectId});
      await storyboardFixture(owner, projectId);
      const requestId = randomUUID(), input = f.input({requestId}), legacyInput = {projectId, requestId};
      let legacy, accepted;
      if (timelineFirst) {
        accepted = await f.services.call('timeline.render', input);
        legacy = await owner.services.call('export.create', legacyInput);
      } else {
        legacy = await owner.services.call('export.create', legacyInput);
        accepted = await f.services.call('timeline.render', input);
      }
      assert.notEqual(legacy.id, accepted.id); assert.equal(legacy.requestId, accepted.requestId);
      const saved = receipt(f, input), legacyReceipt = plain(owner.store.db.prepare("SELECT * FROM idempotency WHERE scope='export' AND requestId=?").get(requestId));
      terminal(f, accepted);
      const outputId = randomUUID();
      owner.store.put('assets', {id: outputId, projectId, name: 'Historical storyboard output', mimeType: 'video/mp4',
        relativePath: `media/export-${legacy.id}-${randomUUID()}.mp4`, sha256: 'a'.repeat(64), sizeBytes: 20,
        width: 720, height: 1280, duration: 0.1, hasAudio: true, provenance: 'export', createdAt: new Date().toISOString()});
      for (const status of (['queued', 'succeeded', 'failed'] as const)) {
        const current:FixtureStoryboardExport = {...legacy, status, assetId: status === 'succeeded' ? outputId : null,
          url: status === 'succeeded' ? `/media/${outputId}` : null, error: status === 'failed' ? {code: 'SYNTHETIC_FAILURE', message: 'Known failure', retryable: false} : null};
        owner.store.put('exports', current);
        owner.store.db.prepare('UPDATE exports SET data=? WHERE id=?').run(JSON.stringify(current, null, 2), legacy.id);
        const before = capture();
        assert.deepEqual(await owner.services.call('export.get', {exportId: legacy.id}), publicValue(current));
        assert.deepEqual(await owner.services.call('export.create', legacyInput), current, 'legacy replay retains its existing current-record semantics');
        assert.deepEqual(await f.services.call('timeline.render', input), accepted, 'timeline replay remains its exact queued ACK');
        await owner.services.call('project.get', {projectId});
        await f.services.call('project.get', {projectId: f.project.id});
        assert.deepEqual(capture(), before, 'reading/replaying either namespace cannot mutate either record');
      }
      await f.restart(); if (owner !== f) await owner.restart();
      assert.equal((await owner.services.call('export.get', {exportId: legacy.id})).status, 'failed');
      assert.deepEqual(receipt(f, input), saved);
      assert.deepEqual(plain(owner.store.db.prepare("SELECT * FROM idempotency WHERE scope='export' AND requestId=?").get(requestId)), legacyReceipt);
      if (owner !== f) {
        // Receipt collision checks are local to one kernel. Give the other
        // project's storyboard its own real same-key float receipt too.
        const localFloat = await owner.services.call('timeline.render', owner.input({requestId}));
        assert.notEqual(localFloat.id, accepted.id);
        terminal(owner, localFloat);
      }
      // A same-key receipt mismatch is not a generic legacy exemption: the
      // independent old receipt must still prove this project/request/resource.
      const originalLegacyRow = owner.store.db.prepare('SELECT * FROM exports WHERE id=?').get(legacy.id);
      for (const change of ([
        () => owner.store.db.prepare("UPDATE idempotency SET requestHash=? WHERE scope='export' AND requestId=?").run('f'.repeat(64), requestId),
        () => owner.store.db.prepare("UPDATE idempotency SET resourceId=? WHERE scope='export' AND requestId=?").run(randomUUID(), requestId),
        () => owner.store.db.prepare("UPDATE idempotency SET scope='unrelated' WHERE scope='export' AND requestId=?").run(requestId),
        () => owner.store.db.prepare('UPDATE exports SET data=? WHERE id=?').run(JSON.stringify({...owner.store.get('exports', legacy.id), projectId: randomUUID()}), legacy.id),
      ] as const)) {
        change(); const before = capture();
        await assert.rejects(owner.services.call('export.get', {exportId: legacy.id}), badSnapshot);
        assert.deepEqual(capture(), before);
        owner.store.db.prepare('DELETE FROM idempotency WHERE requestId=?').run(requestId);
        owner.store.db.prepare('INSERT INTO idempotency(scope,requestId,requestHash,resourceId) VALUES(?,?,?,?)')
          .run((legacyReceipt)!.scope, (legacyReceipt)!.requestId, (legacyReceipt)!.requestHash, (legacyReceipt)!.resourceId);
        owner.store.db.prepare('UPDATE exports SET data=? WHERE id=?').run((originalLegacyRow)!.data, legacy.id);
      }
      const float = (f.store.get('exports', accepted.id)! as FixtureExport);
      f.store.put('exports', {...float, renderAttemptId: randomUUID()});
      await assert.rejects(f.services.call('export.get', {exportId: accepted.id}), badSnapshot, 'stale float report still fails closed');
      assert.equal((await owner.services.call('export.get', {exportId: legacy.id})).status, 'failed', 'unrelated legacy record is not a float-report authority');
      f.store.put('exports', float!);
      owner.store.put('exports', {...legacy, status: 'running'});
      const writes: string[] = [], put = owner.store.put;
      owner.store.put = (table, value) => {if (table === 'exports' && (value as typeof value & {id:("malformed-id")}).id === legacy.id) writes.push((value as typeof value & {status:("failed")}).status); return put(table, value);};
      try {await tick(owner);} finally {owner.store.put = put;}
      assert.deepEqual(writes, ['queued', 'running', 'failed'], 'legacy worker recovery/dispatch remains eligible; deliberately missing source fails normally');
      assert.equal((owner.store.get('exports', legacy.id)!.error)!.code, 'MEDIA_MISSING');
      assert.deepEqual(receipt(f, input), saved);
      assert.equal(f.store.list('exports').length + (owner === f ? 0 : owner.store.list('exports').length), owner === f ? 2 : 3);
    });
  }
});

test('a stripped float row cannot borrow a real storyboard row and its receipt, even with an exact copied payload', async t => {
  for (const crossProject of ([false, true] as const)) for (const exactCopy of ([false, true] as const)) {
    await t.test(`crossProject=${crossProject}, exactCopy=${exactCopy}`, async t => {
      const f = await fixture(t), owner = crossProject ? await fixture(t) : f, projectId = owner.project.id;
      const capture = () => [f.state(), ...(owner === f ? [] : [owner.state()])];
      await owner.services.call('timeline.get', {projectId}); await storyboardFixture(owner, projectId);
      const input = f.input(), accepted = await f.services.call('timeline.render', input);
      const legacy = await owner.services.call('export.create', {projectId, requestId: input.requestId});
      const forged = {...legacy, ...(exactCopy ? {} : {status: 'failed', error: {code: 'FORGED', message: 'Different payload', retryable: false}})};
      withNativeTriggerFault(f.store.db,'main',['immutable_timeline_render_snapshot'],()=>f.store.db.prepare('UPDATE exports SET data=? WHERE id=?').run(JSON.stringify(forged),accepted.id));
      const before = capture();
      await assert.rejects(f.services.call('export.get', {exportId: accepted.id}), badSnapshot);
      await assert.rejects(f.services.call('project.get', {projectId: f.project.id}), badSnapshot);
      assert.deepEqual(await owner.services.call('export.get', {exportId: legacy.id}), publicValue(legacy));
      assert.deepEqual(capture(), before);
    });
  }
});

test('pristine 140fa882 receipts and six business tables replay byte-exact after explicit asset locator adaptation; raw old locators refuse without writes', async t => {
  const bytes = await readFile(new URL('./fixtures/float-checked-export-legacy-140fa882.json', import.meta.url));
  assert.equal(sha(bytes), 'fafe232360d51726403dfbe67bc18341c9f29d7fce65b12c243156bbc81a36c2');
  const baseline:{tables:Record<string,Record<string,SQLInputValue>[]>;sequence:{__rowid__:number;name:string;seq:number}[];media:{relativePath:string;base64:string};renders:{inputJson:string;responseJson:string;exportId:string;requestId:string}[];projectId:string}=JSON.parse(bytes.toString('utf8'));
  const dataDir=await mkdtemp(path.join(tmpdir(),'mioon-float-golden-')),created=createServerProject(dataDir,{projectId:baseline.projectId,name:'Pristine legacy export bytes 🎬'}),root=created.store.projectDir;
  let store=created.store as FixtureStore,services:FixtureServices|undefined;
  t.after(async()=>{await services?.drain();store.close();await rm(dataDir,{recursive:true,force:true});});
  const db=store.db,frozenTables=['projects','assets','timelines','timeline_history','timeline_history_cursors','timeline_requests','exports'];
  const frozenNames=new Set(frozenTables);
  assert.deepEqual(Object.keys(baseline.tables).filter(name=>!frozenNames.has(name)).sort(),['agent_chat_quota','schema_version']);
  assert.deepEqual(baseline.sequence,[],'the independent fixture has no sequence rows to transplant');
  // Only original business payloads are transplanted. Current canonical kernel
  // DDL and metadata stay authoritative; old workspace lineage/v1 quota retire.
  // Suspend foreign-key emulations for the entire explicit fixture transaction.
  withoutForeignKeys(db,()=>{
    db.exec('BEGIN IMMEDIATE');
    try{
      for(const table of frozenTables){
        db.prepare(`DELETE FROM "${table}"`).run();
        for(const value of baseline.tables[table]){
          const keys=Object.keys(value).filter(key=>key!=='__rowid__');
          db.prepare(`INSERT INTO "${table}"(rowid,${keys.map(key=>'"'+key+'"').join(',')}) VALUES(${Array(keys.length+1).fill('?').join(',')})`).run(value.__rowid__,...keys.map(key=>value[key]));
        }
      }
      db.exec('COMMIT');
    }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
  });
  assert.deepEqual(foreignKeyCheck(db),[]);
  await mkdir(path.dirname(path.join(root,baseline.media.relativePath)),{recursive:true,mode:0o700});
  await writeFile(path.join(root,baseline.media.relativePath),Buffer.from(baseline.media.base64,'base64'));
  const rawBefore=rows(db);
  function assertFrozenGolden(actual:ReturnType<typeof rows>,expectedAssets:typeof baseline.tables.assets,allBefore:ReturnType<typeof rows>){
    for(const table of frozenTables){
      const schema=storeTableSchema(store.db,table);assert.ok(schema);
      const values=actual[`${schema}.${table}`],expected=table==='assets'?expectedAssets:baseline.tables[table];
      assert.deepEqual(values.map(row=>Object.fromEntries(Object.keys(expected[0]??row).map(key=>[key,row[key]]))),expected,`${table}: independently hashed business rows remain byte-exact`);
    }
    assert.deepEqual(actual,allBefore,'all three current native catalogs retain their exact rows during open/read/replay');
  }
  assertFrozenGolden(rawBefore,baseline.tables.assets,rawBefore);
  const assemble=()=>createServices(store,new Map(),{exportOptions:{inspect:async()=>{throw Error('Old replay must not probe');}}}) as FixtureServices;
  services=assemble();
  const library=()=>{const owned=testProjectAppLibrary(store);assert.ok(owned);return owned;};
  const sqlState=(connection:DatabaseSync)=>({schema:schemaObjects(connection),rows:rows(connection),
    dataVersions:connection.prepare('PRAGMA database_list').all().map(row=>[row.name,connection.prepare(`PRAGMA "${row.name}".data_version`).get()!.data_version]),
    changes:connection.prepare('SELECT total_changes() AS n').get()!.n});
  const allSql=()=>({project:sqlState(store.db),application:sqlState(library().db)});
  const files=()=>dataFileSnapshot(dataDir,[...databaseFiles(store.db),...databaseFiles(library().db)]);
  const rawSql=allSql(),rawFiles=await files();
  // A current project never accepts a raw old relativePath as a locator, even
  // when the immutable request exists. Refusal cannot repair any stored bytes.
  for(const render of baseline.renders){
    await assert.rejects(services.call('timeline.render',JSON.parse(render.inputJson)),{code:'TIMELINE_SOURCE_UNAVAILABLE',status:404});
    assertFrozenGolden(rows(store.db),baseline.tables.assets,rawBefore);
    assert.deepEqual(allSql(),rawSql);assert.deepEqual(await files(),rawFiles);
  }
  assert.equal(baseline.tables.assets.length,1);
  const goldenRow=baseline.tables.assets[0]!,parsed:unknown=JSON.parse(String(goldenRow.data));
  assert.ok(parsed!==null&&typeof parsed==='object'&&!Array.isArray(parsed));
  const goldenAsset=parsed as Record<string,unknown>,sourceFile=path.join(root,baseline.media.relativePath),sourceBytes=Buffer.from(baseline.media.base64,'base64');
  assert.equal(sourceBytes.length,68);assert.equal(sha(sourceBytes),goldenAsset.sha256);
  const sourceStat=await stat(sourceFile,{bigint:true});
  // This explicit TEST-only put converts the fixture representation; it does
  // not grant a production opener compatibility with old project locators.
  store.tx(()=>store.put('assets',goldenAsset));
  const persisted=store.db.prepare('SELECT rowid AS __rowid__,* FROM assets WHERE id=?').get(String(goldenAsset.id));assert.ok(persisted);
  assert.equal(typeof persisted.data,'string');
  const current:unknown=JSON.parse(String(persisted.data));assert.ok(current!==null&&typeof current==='object'&&!Array.isArray(current));
  const canonicalAsset=current as Record<string,unknown>,{relativePath:_oldPath,...goldenFields}=goldenAsset,
    {reference,referenceRevision,...canonicalFields}=canonicalAsset;
  assert.deepEqual(canonicalFields,goldenFields,'every non-locator asset field remains the independent golden value');
  assert.equal(Object.hasOwn(canonicalAsset,'relativePath'),false);assert.equal(referenceRevision,1);
  assert.deepEqual(reference,{pathForm:'relative',path:'media/frozen-source.png',volume:null,sizeBytes:68,
    mtimeMs:Number(sourceStat.mtimeNs/1000n)/1000,sampledSha256:'07ccce9f91c7f24a6485c849360fb7fea8c0efe5c5c1c00259f304f2cdc31eca',
    fullSha256:'07ccce9f91c7f24a6485c849360fb7fea8c0efe5c5c1c00259f304f2cdc31eca'});
  const {data:_canonicalJson,...canonicalColumns}=persisted,{data:_goldenJson,...goldenColumns}=goldenRow;
  assert.deepEqual({...canonicalColumns},goldenColumns,'SQL identity and rowid do not change during fixture normalization');
  assert.deepEqual(await readFile(sourceFile),sourceBytes);
  const canonicalBefore=rows(store.db),schema=storeTableSchema(store.db,'assets');assert.ok(schema);
  const expectedAssets=canonicalBefore[`${schema}.assets`];
  assertFrozenGolden(canonicalBefore,expectedAssets,canonicalBefore);
  await services.drain();services=undefined;store.close();store=openServerProject(dataDir,baseline.projectId) as FixtureStore;
  services=assemble();
  assertFrozenGolden(rows(store.db),expectedAssets,canonicalBefore);
  const readSql=allSql(),readFiles=await files();
  for (const render of baseline.renders) {
    const input = JSON.parse(render.inputJson), expected = JSON.parse(render.responseJson);
    assert.equal(JSON.stringify(await services.call('timeline.render', input)), render.responseJson);
    assert.equal(isTimelineRenderRecord(expected, input), true);
    assert.equal(JSON.stringify(await services.call('export.get', {exportId: render.exportId})), render.responseJson);
    for (const field of (['audioCheck', 'renderAttemptId'] as const)) assert.equal(Object.hasOwn(expected, field), false);
    assert.equal((store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(render.requestId))!.response,
      (baseline.tables.timeline_requests.find((value) => value.requestId === render.requestId))!.response);
  }
  await services.call('project.get', {projectId: baseline.projectId}); assertFrozenGolden(rows(store.db),expectedAssets,canonicalBefore);
  assert.deepEqual(allSql(),readSql);assert.deepEqual(await files(),readFiles);
  assert.deepEqual(await readFile(sourceFile),sourceBytes);
  assert.deepEqual(await readFile(new URL('./fixtures/float-checked-export-legacy-140fa882.json',import.meta.url)),bytes);
});

test('failed v2 current report never enters immutable ACK; exact replay precedes changed capability/revision after restart', async t => {
  const f = await fixture(t), input = f.input({deliveryName: 'Explicit float'}), accepted = await f.services.call('timeline.render', input);
  const wire = JSON.stringify(accepted), saved = receipt(f, input), failed = terminal(f, accepted);
  assert.equal(isTimelineRenderRecord(publicValue(failed), input), true);
  assert.equal(failed.audioCheck.snapshotSha256, floatSnapshotSha256(failed.snapshot));
  f.timeline = await f.services.call('timeline.clip.update', {projectId: f.project.id, expectedRevision: (f.timeline)!.revision, requestId: randomUUID(), clipId: (f.timeline)!.clips[0].id, patch: {gain: 0.5}});
  f.setInspect(async () => {throw Error('Historical replay must bypass capability');}); await f.restart();
  const before = f.state(); assert.equal(JSON.stringify(await f.services.call('timeline.render', input)), wire);
  assert.deepEqual(await f.services.call('export.get', {exportId: accepted.id}), publicValue(failed));
  assert.deepEqual(receipt(f, input), saved); assert.deepEqual(f.state(), before);
  await assert.rejects(f.services.call('timeline.render', {...input, exportSettings: {...settings(), profileId: 'mp4_h264_v1'}}), {code: 'IDEMPOTENCY_CONFLICT'});
  assert.equal(f.store.list('exports').length, 1);
});

test('server-only outcome adapter rejects unowned measured JSON and errors that self-assert audio authority', async t => {
  const f = await fixture(t), accepted = await f.services.call('timeline.render', f.input()), claim = claimFloatTimelineExport((f.store.get('exports', accepted.id)! as FixtureExport), new Date().toISOString());
  const measured = measurement();
  assert.throws(() => bindFloatTimelineMeasurement(claim, structuredClone(measured), new Date().toISOString()), badSnapshot);
  assert.throws(() => ownedFloatTimelineMeasurement({audioCheck: structuredClone(measured)}), badSnapshot);
  assert.equal(bindFloatTimelineFailure(claim, Object.assign(Error('Forged'), {code: 'EXPORT_AUDIO_OVER_RANGE', audioCheck: measured, measurement: measured}), new Date().toISOString()), undefined);
  const bound = bindFloatTimelineMeasurement(claim, measured, new Date().toISOString());
  assert.equal(bound.attemptId, claim.renderAttemptId); assert.equal((bound.output as unknown), null);
  assert.equal(Object.hasOwn(accepted, 'renderAttemptId'), false); assert.equal(Object.hasOwn(accepted, 'audioCheck'), false);
});

test('v2 current export and project readers reject foreign attempt, snapshot, report/output hash and stripped profile', async t => {
  const f = await fixture(t), input = f.input(), accepted = await f.services.call('timeline.render', input), succeeded = terminal(f, accepted, 0.5, {success: true});
  assert.deepEqual(await f.services.call('export.get', {exportId: accepted.id}), publicValue(succeeded));
  const original = (f.store.db.prepare('SELECT data FROM exports WHERE id=?').get(accepted.id))!.data, asset = f.store.get('assets', ((succeeded.assetId) as unknown as Parameters<NonNullable<((typeof f)["store"])["get"]>>[1]));
  for (const mutate of ([(value: { requestId: string; }) => {value.requestId = randomUUID();}, (value: { renderAttemptId: string; }) => {value.renderAttemptId = randomUUID();}, (value: { audioCheck: { attemptId: string; }; }) => {value.audioCheck.attemptId = randomUUID();},
(    value: { audioCheck: { projectId: string; }; }) => {value.audioCheck.projectId = randomUUID();}, (value: { audioCheck: { exportId: string; }; }) => {value.audioCheck.exportId = randomUUID();},
(    value: { audioCheck: { snapshotSha256: string; }; }) => {value.audioCheck.snapshotSha256 = 'c'.repeat(64);}, (value: { audioCheck: { output: { sha256: string; }; }; }) => {value.audioCheck.output.sha256 = 'c'.repeat(64);},
(    value: { audioCheck: { output: { assetId: string; }; }; }) => {value.audioCheck.output.assetId = randomUUID();}, (value: { audioCheck: { outputFrames: number; }; }) => {value.audioCheck.outputFrames++;},
(    value: { audioCheck: unknown; }) => {delete value.audioCheck;}, (value: { audioCheck: { path: string; }; }) => {value.audioCheck.path = '/private/source';}] as const)) {
    const changed = structuredClone(succeeded); mutate(((changed) as unknown as StrictIntersection<Parameters<NonNullable<typeof mutate>>[0]>)); f.store.put('exports', changed);
    const before = f.state();
    await assert.rejects(f.services.call('export.get', {exportId: accepted.id}), badSnapshot);
    await assert.rejects(f.services.call('project.get', {projectId: f.project.id}), badSnapshot);
    assert.deepEqual(f.state(), before); f.store.db.prepare('UPDATE exports SET data=? WHERE id=?').run(original, accepted.id);
  }
  f.store.put('assets', {...asset, sha256: 'd'.repeat(64)});
  await assert.rejects(f.services.call('export.get', {exportId: accepted.id}), badSnapshot); f.store.put('assets', asset!);
  for (const patch of ([{mode: 'storyboard'}, {purpose: 'preview'}] as const)) {
    withNativeTriggerFault(f.store.db,'main',['immutable_timeline_render_snapshot'],()=>f.store.put('exports',{...succeeded,...patch}));
    await assert.rejects(f.services.call('export.get', {exportId: accepted.id}), badSnapshot);
    withNativeTriggerFault(f.store.db,'main',['immutable_timeline_render_snapshot'],()=>f.store.db.prepare('UPDATE exports SET data=? WHERE id=?').run(original,accepted.id));
  }
  const stripped = structuredClone(succeeded); delete stripped.snapshot.delivery; delete (stripped as {audioCheck?: unknown}).audioCheck; delete ((stripped as typeof stripped & {renderAttemptId:(`${string}-${string}-${string}-${string}-${string}`)}) as {renderAttemptId?: unknown}).renderAttemptId;
  withNativeTriggerFault(f.store.db,'main',['immutable_timeline_render_snapshot'],()=>f.store.put('exports',stripped));
  await assert.rejects(f.services.call('export.get', {exportId: accepted.id}), badSnapshot);
  await assert.rejects(f.services.call('project.get', {projectId: f.project.id}), badSnapshot);
  assert.equal(((receipt(f, input))!.response as string).includes('audioCheck'), false);
  const forgedId = randomUUID();
  f.store.put('exports', {...stripped, id: forgedId});
  await assert.rejects(f.services.call('export.get', {exportId: forgedId}), badSnapshot,
    'a different ID cannot exempt stripped v2 without a bound legacy export receipt');
  f.store.db.prepare('DELETE FROM exports WHERE id=?').run(forgedId);

  const other = await fixture(t), changedOwner = {...stripped, projectId: other.project.id};
  withoutProcessTargetRevisions(f.store.db, ['exports'], () => withoutForeignKeys(f.store.db, () => f.store.db.prepare('UPDATE exports SET projectId=?,data=? WHERE id=?').run(other.project.id, JSON.stringify(changedOwner), accepted.id)));
  const before = f.state();
  await assert.rejects(f.services.call('export.get', {exportId: accepted.id}), badSnapshot,
    'matching export identity still detects stripped v2 when its relational and JSON project were changed');
  await assert.rejects(f.services.call('project.get', {projectId: other.project.id}), {code: 'NOT_FOUND'});
  const foreignBefore = other.state();
  assert.equal((await other.services.call('project.get', {projectId: other.project.id})).project.id, other.project.id);
  assert.deepEqual(other.state(), foreignBefore);
  assert.deepEqual(f.state(), before);
});

test('worker restart removes interrupted v2 attempt without rewriting its receipt and the next attempt remeasures', {timeout: 60_000}, async t => {
  const f = await fixture(t, {gain: 0.5}), input = f.input(), accepted = await f.services.call('timeline.render', input), saved = receipt(f, input);
  const abandoned = claimFloatTimelineExport((f.store.get('exports', accepted.id)! as FixtureExport), new Date().toISOString()); f.store.put('exports', abandoned);
  await f.restart();
  // startWorker immediately auto-ticks after constructor recovery. Capture the
  // exact writes to observe clearing before its next synchronous running claim.
  const writes: FixtureExport[] = [], put = f.store.put;
  f.store.put = (table, value) => {if (table === 'exports' && (value as typeof value & {id:("malformed-id")}).id === accepted.id) writes.push(((structuredClone(value)) as unknown as Parameters<NonNullable<(typeof writes)["push"]>>[0])); return put(table, value);};
  const worker = startWorker(f.store, f.services, new Map());
  try {
    const queued = writes[0]; assert.equal(queued.status, 'queued');
    assert.equal(Object.hasOwn(queued, 'renderAttemptId'), false); assert.equal(Object.hasOwn(queued, 'audioCheck'), false);
    assert.equal(writes[1].status, 'running'); assert.notEqual(writes[1].renderAttemptId, abandoned.renderAttemptId);
    await worker.tick();
  } finally {await worker.stop(); f.store.put = put;}
  const result = (f.store.get('exports', accepted.id)! as FixtureExport); assert.equal(result!.status, 'succeeded', JSON.stringify(result!.error));
  assert.notEqual(result!.renderAttemptId, abandoned.renderAttemptId); assert.equal((result!.audioCheck)!.attemptId, result!.renderAttemptId);
  assert.equal(((result!.audioCheck)!.measurement)!.sampleFrames, 4800); assert.deepEqual(receipt(f, input), saved);
  assert.deepEqual(await f.services.call('timeline.render', input), accepted);
});

test('replaced attempt or newer completed outcome cannot receive an old worker report or publication', {timeout: 60_000}, async t => {
  for (const state of (['running', 'failed', 'succeeded'] as const)) await t.test(state, async t => {
    const f = await fixture(t, {gain: 0.5}), input = f.input(), accepted = await f.services.call('timeline.render', input), saved = receipt(f, input);
    let replacement!: unknown;
    const events = await tick(f, (((event: { type: string; kind: string; }) => {
      if (replacement || event.type !== 'exited' || event.kind !== 'ffprobe') return;
      const current = (f.store.get('exports', accepted.id)! as FixtureExport);
      assert.equal(current!.status, 'running'); assert.ok(current!.renderAttemptId);
      const newer = {...current, renderAttemptId: randomUUID(), status: state};
      // A terminal replacement is a race fixture, never a production publication.
      // The old worker has no authority to repair or overwrite these bytes.
      if (state === 'failed') newer.error = {code: 'NEWER_ATTEMPT_FAILED', message: 'Newer result', retryable: false};
      f.store.put('exports', newer); replacement = (f.store.db.prepare('SELECT data FROM exports WHERE id=?').get(accepted.id))!.data;
    }) as unknown as Parameters<NonNullable<typeof tick>>[1]));
    assert.ok(replacement); assert.equal((f.store.db.prepare('SELECT data FROM exports WHERE id=?').get(accepted.id))!.data, replacement);
    assert.equal(events.some(event => event.type === 'started' && event.kind === 'ffmpeg'), false);
    assert.equal(f.store.list('assets').some(asset => asset.provenance === 'export'), false);
    assert.deepEqual(receipt(f, input), saved); assert.equal(Object.hasOwn((f.store.get('exports', accepted.id)! as FixtureExport), 'audioCheck'), false);
  });
});

test('real overrange v2 fails with one stored report and no final asset; explicit saved gain edit and new key succeeds', {timeout: 90_000}, async t => {
  const f = await fixture(t, {gain: 2}), input = f.input(), accepted = await f.services.call('timeline.render', input), saved = receipt(f, input);
  const source = await readFile(path.join(f.root, (f as typeof f & {asset:({ id: `${string}-${string}-${string}-${string}-${string}`; projectId: string; name: string; mimeType: string; sha256: string; relativePath: string; width: number; height: number; duration: number; hasAudio: boolean; sizeBytes: number; provenance: string; createdAt: string; })}).asset.relativePath)), timelineBytes = JSON.stringify(f.timeline);
  await tick(f);
  const failed = (f.store.get('exports', accepted.id)! as FixtureExport);
  assert.equal(failed!.status, 'failed', JSON.stringify(failed!.error)); assert.equal((failed!.error)!.code, 'EXPORT_AUDIO_OVER_RANGE'); assert.equal((failed!.error)!.retryable, false);
  assert.equal((failed!.audioCheck)!.status, 'complete'); assert.equal((failed!.audioCheck)!.code, 'EXPORT_AUDIO_OVER_RANGE');
  assert.ok((failed!.audioCheck)!.measurement.peakLinear > 1.39 && (failed!.audioCheck)!.measurement.peakLinear < 1.41);
  assert.equal((failed!.audioCheck)!.measurement.sampleFrames, 4800); assert.equal(((failed!.audioCheck)!.output as unknown), null);
  assert.equal((failed!.assetId as unknown), null); assert.equal((failed!.url as unknown), null); assert.equal(f.store.list('assets').some(asset => asset.provenance === 'export'), false);
  assert.equal((await readdir(path.join(f.root, 'media'))).some(name => name.startsWith('export-')), false);
  assert.equal(JSON.stringify(f.store.get('timelines', (f.timeline)!.id)), timelineBytes);
  assert.deepEqual(receipt(f, input), saved); assert.deepEqual(await f.services.call('timeline.render', input), accepted);
  await f.restart(); assert.equal((f.store.get('exports', accepted.id)! as FixtureExport).status, 'failed');
  const before = f.state(); await tick(f); assert.deepEqual(f.state(), before, 'failure/restart never retries automatically');
  f.timeline = await f.services.call('timeline.clip.update', {projectId: f.project.id, expectedRevision: (f.timeline)!.revision, requestId: randomUUID(), clipId: (f.timeline)!.clips[0].id, patch: {gain: 0.5}});
  const freshInput = f.input(), fresh = await f.services.call('timeline.render', freshInput); await tick(f);
  const succeeded = (f.store.get('exports', fresh.id)! as FixtureExport), output = f.store.get('assets', ((succeeded!.assetId) as unknown as Parameters<NonNullable<((typeof f)["store"])["get"]>>[1]));
  assert.equal(succeeded!.status, 'succeeded', JSON.stringify(succeeded!.error));
  assert.equal((succeeded!.audioCheck)!.code, 'EXPORT_AUDIO_WITHIN_LIMIT'); assert.ok((succeeded!.audioCheck)!.measurement.peakLinear <= 1);
  assert.deepEqual((succeeded!.audioCheck)!.output, {assetId: output!.id, sha256: output!.sha256});
  assert.equal(isTimelineExportAudioOutcome(succeeded, {snapshotSha256: floatSnapshotSha256(succeeded!.snapshot), assetSha256: output!.sha256}), true);
  assert.notEqual(succeeded!.renderAttemptId, failed!.renderAttemptId); assert.equal(f.store.list('exports').length, 2);
  assert.equal(sha(await readFile(path.join(f.root, (f as typeof f & {asset:({ id: `${string}-${string}-${string}-${string}-${string}`; projectId: string; name: string; mimeType: string; sha256: string; relativePath: string; width: number; height: number; duration: number; hasAudio: boolean; sizeBytes: number; provenance: string; createdAt: string; })}).asset.relativePath))), sha(source));
  assert.deepEqual(receipt(f, input), saved); assert.deepEqual(await f.services.call('timeline.render', input), accepted);
  await f.restart(); assert.deepEqual(await f.services.call('export.get', {exportId: fresh.id}), publicValue(succeeded));
});



test('v2 read guards fail closed for malformed relational identities and corrupted immutable receipt fields', async t => {
  for (const target of (['row id', 'row project', 'foreign row project', 'row request', 'row request malformed', 'receipt status', 'receipt attempt', 'receipt hash', 'receipt JSON'] as const)) await t.test(target, async t => {
    const f = await fixture(t), input = f.input(), accepted = await f.services.call('timeline.render', input), failed = terminal(f, accepted), db = f.store.db;
    withNativeTriggerFault(db,'main',[target.startsWith('row')||target==='foreign row project'?'immutable_timeline_render_snapshot':'immutable_timeline_responses'],()=>{
    if (target.startsWith('row') || target === 'foreign row project') {
      const changed = structuredClone(failed);
      if (target === 'row id') (changed as typeof changed & {id:("malformed-id")}).id = 'malformed-id';
      else if (target === 'row project') (changed as typeof changed & {projectId:(`${string}-${string}-${string}-${string}-${string}`)|(null)}).projectId = (null as unknown as (typeof changed & {projectId:(`${string}-${string}-${string}-${string}-${string}`)|(null)})["projectId"]);
      else if (target === 'foreign row project') (changed as typeof changed & {projectId:(`${string}-${string}-${string}-${string}-${string}`)|(null)}).projectId = randomUUID();
      else if (target === 'row request malformed') (changed as typeof changed & {requestId:(`${string}-${string}-${string}-${string}-${string}`)|({ untrusted: boolean; })}).requestId = ({untrusted: true} as unknown as (typeof changed & {requestId:(`${string}-${string}-${string}-${string}-${string}`)|({ untrusted: boolean; })})["requestId"]);
      else (changed as typeof changed & {requestId:(`${string}-${string}-${string}-${string}-${string}`)|({ untrusted: boolean; })}).requestId = randomUUID();
      db.prepare('UPDATE exports SET data=? WHERE id=?').run(JSON.stringify(changed), accepted.id);
    } else {
      const saved = receipt(f, input), changed = JSON.parse((((saved)!.response) as unknown as Parameters<typeof JSON.parse>[0]));
      if (target === 'receipt hash') db.prepare('UPDATE timeline_requests SET requestHash=? WHERE requestId=?').run('not-a-hash', input.requestId);
      else if (target === 'receipt JSON') db.prepare('UPDATE timeline_requests SET response=? WHERE requestId=?').run('{', input.requestId);
      else {
        if (target === 'receipt status') changed.status = 'failed';
        else changed.renderAttemptId = randomUUID();
        db.prepare('UPDATE timeline_requests SET response=? WHERE requestId=?').run(JSON.stringify(changed), input.requestId);
      }
    }});
    const before = f.state();
    await assert.rejects(f.services.call('export.get', {exportId: accepted.id}), badSnapshot);
    await assert.rejects(f.services.call('project.get', {projectId: f.project.id}), badSnapshot);
    assert.deepEqual(f.state(), before);
  });
});

function renderConcatPhase(root: string) {
  const directory = path.join(root, 'media');
  return readdirSync(directory).some(name => name.startsWith('.timeline-render-') && existsSync(path.join(directory, name, 'segments.txt')));
}

test('late replacement after float measurement cannot publish the old attempt report or overwrite a newer failure', {timeout: 60_000}, async t => {
  const f = await fixture(t, {gain: 0.5}), input = f.input(), accepted = await f.services.call('timeline.render', input), saved = receipt(f, input);
  let concatStarts = 0, replacement;
  await tick(f, (((event: { type: string; kind: string; }) => {
    if (event.type !== 'started' || event.kind !== 'ffmpeg' || !renderConcatPhase(f.root) || ++concatStarts !== 2) return;
    // The first render-owned concat process measures float PCM. The second
    // starts final AAC, so the entire sample check has already completed.
    const current = (f.store.get('exports', accepted.id)! as FixtureExport);
    f.store.put('exports', {...current, renderAttemptId: randomUUID(), status: 'failed',
      error: {code: 'NEWER_ATTEMPT_FAILED', message: 'Newer outcome owns this row', retryable: false}});
    replacement = (f.store.db.prepare('SELECT data FROM exports WHERE id=?').get(accepted.id))!.data;
  }) as unknown as Parameters<NonNullable<typeof tick>>[1]));
  assert.equal(concatStarts, 2); assert.ok(replacement);
  assert.equal((f.store.db.prepare('SELECT data FROM exports WHERE id=?').get(accepted.id))!.data, replacement);
  assert.equal(Object.hasOwn((f.store.get('exports', accepted.id)! as FixtureExport), 'audioCheck'), false);
  assert.equal(f.store.list('assets').some(asset => asset.provenance === 'export'), false); assert.deepEqual(receipt(f, input), saved);
  assert.equal((await readdir(path.join(f.root, 'media'))).some(name => name.startsWith('export-')), false);
});

test('cancellation after a complete float check requeues without token/report and cleans the exact owned part', {timeout: 60_000}, async t => {
  const f = await fixture(t, {gain: 0.5}), input = f.input(), accepted = await f.services.call('timeline.render', input), saved = receipt(f, input);
  const controller = new AbortController(); let concatStarts = 0, attempt;
  const off = onMediaProcess(event => {
    if (event.type !== 'started' || event.kind !== 'ffmpeg' || !renderConcatPhase(f.root) || ++concatStarts !== 2) return;
    attempt = (f.store.get('exports', accepted.id)! as FixtureExport).renderAttemptId; controller.abort();
  }), worker = startWorker(f.store, f.services, new Map(), {signal: controller.signal});
  try {await worker.tick();} finally {off(); await worker.stop();}
  assert.equal(concatStarts, 2); assert.ok(attempt);
  const queued = (f.store.get('exports', accepted.id)! as FixtureExport); assert.equal(queued!.status, 'queued');
  assert.equal(Object.hasOwn(queued!, 'renderAttemptId'), false); assert.equal(Object.hasOwn(queued!, 'audioCheck'), false);
  assert.equal((queued!.assetId as unknown), null); assert.equal((queued!.url as unknown), null); assert.deepEqual(receipt(f, input), saved);
  assert.deepEqual((await readdir(path.join(f.root, 'media'))).sort(), [path.basename((f as typeof f & {asset:({ id: `${string}-${string}-${string}-${string}-${string}`; projectId: string; name: string; mimeType: string; sha256: string; relativePath: string; width: number; height: number; duration: number; hasAudio: boolean; sizeBytes: number; provenance: string; createdAt: string; })}).asset.relativePath)]);
  await tick(f); const succeeded = (f.store.get('exports', accepted.id)! as FixtureExport);
  assert.equal(succeeded!.status, 'succeeded', JSON.stringify(succeeded!.error)); assert.notEqual(succeeded!.renderAttemptId, attempt);
  assert.equal((succeeded!.audioCheck)!.attemptId, succeeded!.renderAttemptId); assert.deepEqual(receipt(f, input), saved);
});

test('final AAC spawn failure retains the complete same-attempt within-limit report with no published output', {timeout: 60_000}, async t => {
  const f = await fixture(t, {gain: 0.5}), input = f.input(), accepted = await f.services.call('timeline.render', input), saved = receipt(f, input);
  const prior = process.env.MIOON_FFMPEG_PATH; let decoder:unknown, changed = false;
  try {
    await tick(f, (((event: { type: string; kind: string; pid: unknown; }) => {
      if (event.type === 'started' && event.kind === 'ffmpeg' && renderConcatPhase(f.root) && decoder === undefined) decoder = event.pid;
      if (event.type === 'exited' && event.pid === decoder && !changed) {changed = true; process.env.MIOON_FFMPEG_PATH = path.join(f.root, 'missing-owned-final-encoder');}
    }) as unknown as Parameters<NonNullable<typeof tick>>[1]));
  } finally {if (prior === undefined) delete process.env.MIOON_FFMPEG_PATH; else process.env.MIOON_FFMPEG_PATH = prior;}
  assert.equal(changed, true);
  const failed = (f.store.get('exports', accepted.id)! as FixtureExport); assert.equal(failed!.status, 'failed'); assert.equal((failed!.error)!.code, 'MEDIA_SPAWN_FAILED');
  assert.equal((failed!.audioCheck)!.code, 'EXPORT_AUDIO_WITHIN_LIMIT'); assert.equal((failed!.audioCheck)!.status, 'complete');
  assert.equal((failed!.audioCheck)!.attemptId, failed!.renderAttemptId); assert.equal((failed!.audioCheck)!.measurement.sampleFrames, 4800);
  assert.equal(((failed!.audioCheck)!.output as unknown), null); assert.equal((failed!.assetId as unknown), null); assert.equal((failed!.url as unknown), null);
  assert.equal(f.store.list('assets').some(asset => asset.provenance === 'export'), false); assert.deepEqual(receipt(f, input), saved);
  assert.deepEqual((await readdir(path.join(f.root, 'media'))).sort(), [path.basename((f as typeof f & {asset:({ id: `${string}-${string}-${string}-${string}-${string}`; projectId: string; name: string; mimeType: string; sha256: string; relativePath: string; width: number; height: number; duration: number; hasAudio: boolean; sizeBytes: number; provenance: string; createdAt: string; })}).asset.relativePath)]);
});
