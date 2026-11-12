import {mediaReferenceFixture,mp4HeaderFixture} from './media-reference-fixtures.ts';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {IDS, NOW, TOKEN, seedMutationStore, uuid} from './mutation-wire-fixture.ts';
import {installWireGuard} from './inspection-wire-fixture.ts';
import type {InspectProject} from '../../apps/server/src/index.ts';

export const RANGE_IDS = Object.freeze({audio: uuid(80), long: uuid(81), boundary: uuid(82), image: uuid(83),
  unknown: uuid(84), corruptProject: uuid(85), mismatchedOwner: uuid(86), mismatchedId: uuid(87), missing: uuid(9999)});
export const PRIVATE = 'SOURCE_RANGE_PRIVATE_FIXTURE_MARKER';

async function seed(root: string): Promise<void> {
  await seedMutationStore(root);
  const {createServerProject, openServerProject, projectDirFor, withoutForeignKeys} = await import('./project-database.ts');
  const asset = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({id, projectId: IDS.project, name: 'Metadata-only range fixture',
    mimeType: 'video/mp4', duration: 2, width: 720, height: 1280, hasVideo: true, hasAudio: false,
    provenance: 'user-import', sha256: '2'.repeat(64),sizeBytes:1,referenceRevision:1,reference:mediaReferenceFixture(`media/${id}.mp4`,1,'2'.repeat(64)), createdAt: NOW, ...extra});
  const store = openServerProject(root, IDS.project);
  try {
    // The shared mutation fixture's zero-track timeline is an intentionally
    // opaque preservation sentinel, not a service-produced aggregate. This
    // scenario later edits the timeline, so give it the three default tracks
    // produced by timeline.get; leave the shared fixture/journal sentinels alone.
    store.put('timelines', {...(store.get('timelines', IDS.timeline) as Record<string, unknown>),
      tracks: [['video', 'Video 1'], ['video', 'Video 2'], ['audio', 'Audio 1']].map(([kind, name], orderIndex) =>
        ({id: uuid(88 + orderIndex), name, kind, orderIndex, hidden: false, muted: false}))});
    // The mutation fixture intentionally shares one asset across two versions.
    // Inspection rejects that ambiguous reverse relation, so this wire seed
    // keeps only the single generated version needed by the range scenario.
    store.db.prepare('DELETE FROM versions WHERE id=?').run(IDS.secondVersion);
    store.db.prepare('DELETE FROM jobs WHERE id=?').run(IDS.secondJob);
    const generated=store.get('assets',IDS.asset) as Record<string,unknown>;
    // This metadata-only decoder fixture still needs a genuine completed
    // publication. No decoder runs; the bytes deliberately promise only an MP4 header.
    const {publishOutputFixture,markProjectOutputRegistered}=await import('./project-output-fixture.ts');
    const job=store.get('jobs',IDS.job) as Record<string,unknown>,version=store.get('versions',IDS.version) as Record<string,unknown>;
    const requestId=typeof job.requestId==='string'?job.requestId:IDS.job;
    const requestHash=typeof job.requestHash==='string'?job.requestHash:createHash('sha256').update(JSON.stringify({projectId:IDS.project,jobId:IDS.job,shotId:job.shotId,model:job.model})).digest('hex');
    const published=await publishOutputFixture(store,{assetId:IDS.asset,owner:{kind:'generation',id:IDS.job,requestId,inputHash:requestHash},
      bytes:mp4HeaderFixture('Metadata-only source range lineage; no decoder runs'),mimeType:'video/mp4'});
    store.tx(()=>{
      store.put('jobs',{...job,requestId,requestHash});
      store.put('assets',{...generated,...published,producer:{kind:'generation',id:IDS.job}});
      // The shared seed is not exposed yet. Replace its immutable synthetic
      // version explicitly instead of disabling the production update trigger.
      store.db.prepare('DELETE FROM versions WHERE id=?').run(IDS.version);
      store.put('versions',{...version,sha256:published.sha256});
    });
    await markProjectOutputRegistered(store,published.publication);
    // Inserting this video makes it the project cover. Seed its cache so the
    // independent cover refresh never tries to decode the header-only source.
    const {writeProjectCover} = await import('../../apps/server/src/project-host/covers.ts');
    const {mediaFingerprintToken} = await import('../../packages/business/src/project-asset-references.ts');
    const {pillowJfifFixture} = await import('./timeline-jpeg-fixtures.ts');
    writeProjectCover({cacheDir: store.cacheDir, source: {assetId: IDS.asset, mimeType: 'video/mp4',
      sourceFingerprint: mediaFingerprintToken(published.reference)}, jpeg: pillowJfifFixture()});
    store.put('assets', asset(RANGE_IDS.audio, {mimeType: 'audio/wav', duration: 2.019, hasVideo: false, hasAudio: true}));
    store.put('assets', asset(RANGE_IDS.long, {duration: 1200}));
    store.put('assets', asset(RANGE_IDS.boundary, {duration: (61 - 1e-10) / 30}));
    store.put('assets', asset(RANGE_IDS.image, {mimeType: 'image/png', duration: 2}));
    store.put('assets', asset(RANGE_IDS.unknown, {duration: undefined}));
  } finally { store.close(); }
  const {store: corrupt} = createServerProject(root, {name: PRIVATE, projectId: RANGE_IDS.corruptProject});
  try {
    for (const id of [RANGE_IDS.mismatchedOwner, RANGE_IDS.mismatchedId]) {
      corrupt.put('assets', asset(id, {projectId: RANGE_IDS.corruptProject, name: PRIVATE,
        relativePath: `media/${PRIVATE}.mp4`, url: `https://private.invalid/${PRIVATE}`}));
    }

  } finally { corrupt.close(); }
}

// Imported before production modules in every server, CLI and MCP child. The
// only allowed outbound connection is the exact disposable backend endpoint.
if (process.env.MIOON_RANGE_WIRE_GUARD === '1') installWireGuard({
  origin: process.env.MIOON_RANGE_WIRE_ALLOWED_ORIGIN || '', auditPath: process.env.MIOON_RANGE_WIRE_AUDIT,
});

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.env.MIOON_DATA_DIR;
  if (!root || process.argv[2] !== 'server') throw Error('An isolated range-wire server fixture is required');
  const dataRoot: string = root;
  if (!fs.existsSync(path.join(dataRoot, 'app-library.db'))) await seed(dataRoot);
  const {startServer} = await import('../../apps/server/src/index.ts');
  const {readProjectState, changeMarks} = await import('./project-state.ts');
  let inspect: InspectProject|undefined;
  const server = await startServer({dataDir: dataRoot, port: Number(process.env.PORT || 0), token: TOKEN,
    inspectProject: received => { inspect = received; }});
  // The parent reads through the running server rather than opening its file.
  if (process.connected) process.on('message', (raw: unknown) => {
    const message = raw as {type?: unknown; id?: unknown; projectId?: unknown}|null;
    if (typeof message?.id !== 'string') return;
    let reply: unknown;
    try {
      const corrupting=message.type==='corrupt-sources';
      if((!corrupting&&message.type!=='storage')||Object.keys(message).some(key=>!(corrupting?['type','id']:['type','id','projectId']).includes(key)))throw Error('Unsupported range fixture message');
      if (!inspect) throw Error('The server has not handed over its connection');
      const data = inspect(corrupting?RANGE_IDS.corruptProject:String(message.projectId), db => {
        if(corrupting){db.prepare("UPDATE assets SET data=json_set(data,'$.projectId',?) WHERE id=?").run(IDS.other,RANGE_IDS.mismatchedOwner);db.prepare("UPDATE assets SET data=json_set(data,'$.id',?) WHERE id=?").run(IDS.otherAsset,RANGE_IDS.mismatchedId);}
        return ({projectDir:path.dirname(String(db.prepare('PRAGMA database_list').all().find(row=>String(row.file).endsWith('.mioon'))!.file)),rows: readProjectState(db).tables, version: changeMarks(db)});});
      reply = {type: 'reply', id: message.id, data};
    } catch (error) {
      const failure = error as {code?: unknown; message?: unknown}|null;
      reply = {type: 'reply', id: message.id, error: {code: failure?.code ?? 'FIXTURE_ERROR', message: String(failure?.message ?? error)}};
    }
    if (process.connected) process.send?.(reply);
  });
  process.stdout.write(JSON.stringify({ready: true, url: server.url, pid: process.pid}) + '\n');
  let closing: Promise<unknown>|undefined;
  const close = (): Promise<unknown> => closing ??= server.close().catch(() => { process.exitCode = 1; })
    .finally(() => { if (process.connected) process.disconnect(); });
  process.on('SIGTERM', close); process.on('SIGINT', close); process.once('disconnect', close);
}
