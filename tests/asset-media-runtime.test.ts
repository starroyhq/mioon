import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, readFileSync, readdirSync, lstatSync, renameSync, unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openStore} from '../packages/business/src/project-file/test-store.ts';
import {openAppLibrary} from '../packages/business/src/app-db/index.ts';
import {createProjectServiceApplication} from '../packages/business/src/project-service-application.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createAssetMediaServices} from '../packages/business/src/asset-media-services.ts';
import {assetMediaDtoSchema} from '../packages/contracts/src/asset-media.ts';
import {projectMediaPath} from '../packages/contracts/src/project-file.ts';
import {png} from './helpers/timeline-image-fixtures.ts';
import {run} from '../packages/business/src/media.ts';
import {onMediaProcess} from '../packages/business/src/media-processes.ts';
import {writePrivateFileAtomic} from '../packages/contracts/src/private-storage.ts';

const hash = (value: Buffer): string => createHash('sha256').update(value).digest('hex');
function row(value: unknown): Record<string, unknown> {assert.ok(value && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>;}
async function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-full-asset-runtime-'));
  const projectDir = path.join(root, 'project'), external = path.join(root, 'external');
  mkdirSync(projectDir, {mode: 0o755}); mkdirSync(external, {mode: 0o755});
  const store = openStore(projectDir), app = openAppLibrary({dataDir: path.join(root, 'application')});
  store.put('projects', {id: store.projectId, name: 'Referenced assets'});
  const services = createServices(store, new Map(), {application: createProjectServiceApplication(app)});
  const media = createAssetMediaServices(store, {outsidePaths: app.outsidePaths});
  t.after(async () => {await services.drain(); store.close(); app.close(); rmSync(root, {recursive: true, force: true});});
  const upload = (requestId?: string, bytes = png()) => ({projectId: store.projectId, name: 'image.png', mimeType: 'image/png', dataBase64: bytes.toString('base64'), ...(requestId ? {requestId} : {})});
  return {root, store, app, services, media, projectDir, external, upload};
}

test('web uploads publish once in 素材 and expose only a complete-hash DTO', async t => {
  const f = await fixture(t), bytes = png(), input = f.upload(randomUUID(), bytes);
  const result = row(await f.services.call('asset.import', input)), replay = row(await f.services.call('asset.import', input));
  assetMediaDtoSchema.parse(result); assert.equal(replay.id, result.id);
  assert.equal(result.sha256, hash(bytes)); assert.equal(result.referenceRevision, 1);
  assert.equal(result.url, projectMediaPath(f.store.projectId, String(result.id)));
  assert.ok(!Object.hasOwn(result, 'reference') && !Object.hasOwn(result, 'relativePath'));
  const stored = row(f.store.get('assets', String(result.id))), reference = row(stored.reference);
  assert.equal(reference.fullSha256, result.sha256); assert.ok(String(reference.path).startsWith('素材/'));
  assert.equal(readdirSync(path.join(f.projectDir, '素材')).length, 1);
  await assert.rejects(f.services.call('asset.import', {...input, name: 'different.png'}), {code: 'IDEMPOTENCY_CONFLICT'});
  assert.equal(readdirSync(path.join(f.projectDir, '素材')).length, 1);
});

test('path import admits an ordinary file without copying or changing its bytes', async t => {
  const f = await fixture(t), file = path.join(f.projectDir, 'original.png'), bytes = png();
  writeFileSync(file, bytes, {mode: 0o644}); const before = lstatSync(file);
  const asset = row(await f.services.call('asset.import', {projectId: f.store.projectId, requestId: randomUUID(), sourcePath: file}));
  assert.equal(asset.sha256, hash(bytes)); assert.deepEqual(readFileSync(file), bytes);
  assert.equal(lstatSync(file).mtimeMs, before.mtimeMs); assert.equal(lstatSync(file).ino, before.ino);
  assert.equal(readdirSync(f.projectDir).filter(name => name === '素材').length, 0);
  assert.equal(row(row(f.store.get('assets', String(asset.id))).reference).path, 'original.png');
});

test('path imports larger than 30 MiB are streamed and keep the original file', async t => {
  const f = await fixture(t), bytes = Buffer.alloc(31 * 1024 * 1024 + 44);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(44100, 24); bytes.writeUInt32LE(88200, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  const file = path.join(f.projectDir, 'large.wav'); writeFileSync(file, bytes, {mode: 0o644});
  const before = lstatSync(file), input = {projectId: f.store.projectId, requestId: randomUUID(), sourcePath: file};
  const asset = row(await f.services.call('asset.import', input));
  assert.equal(asset.sizeBytes, bytes.length); assert.equal(asset.sha256, hash(bytes));
  assert.equal(asset.mimeType, 'audio/wav'); assert.equal(lstatSync(file).mtimeMs, before.mtimeMs);
  assert.equal(lstatSync(file).ino, before.ino); assert.equal(readdirSync(f.projectDir).includes('素材'), false);
});

test('a sampled video gains a full hash only through revision-checked strong preparation', async t => {
  const f = await fixture(t), file = path.join(f.projectDir, 'sampled.mp4');
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=32x32:d=0.1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', file]);
  const asset = row(await f.services.call('asset.import', {projectId: f.store.projectId, requestId: randomUUID(), sourcePath: file}));
  assert.equal(asset.sha256, null); assert.equal(asset.hashState, 'sampled');
  await assert.rejects(f.services.call('asset.media.prepare', {projectId: f.store.projectId, assets: [{assetId: asset.id, referenceRevision: 2}], purpose: 'frame'}), {code: 'REVISION_CONFLICT'});
  assert.equal(row(f.store.get('assets', String(asset.id))).sha256, null);
  const prepared = row(await f.services.call('asset.media.prepare', {projectId: f.store.projectId, assets: [{assetId: asset.id, referenceRevision: 1}], purpose: 'frame'}));
  const complete = row((prepared.assets as unknown[])[0]);
  assert.equal(complete.sha256, hash(readFileSync(file))); assert.equal(complete.referenceRevision, 1);
  assert.equal(complete.hashState, 'full'); assert.ok(!Object.hasOwn(complete, 'reference'));
});

test('concurrent identical uploads produce one asset and one published file', async t => {
  const f = await fixture(t), input = f.upload(randomUUID());
  const [a, b] = await Promise.all([f.services.call('asset.import', input), f.services.call('asset.import', input)]);
  assert.equal(row(a).id, row(b).id); assert.equal(f.store.list('assets', f.store.projectId).length, 1);
  assert.equal(readdirSync(path.join(f.projectDir, '素材')).length, 1);
});

test('ordinary RPC cannot confirm; trusted import confirms one directory and replay cannot undo revocation', async t => {
  const f = await fixture(t), file = path.join(f.external, 'outside.png'); writeFileSync(file, png());
  const input = {projectId: f.store.projectId, requestId: randomUUID(), sourcePath: file};
  await assert.rejects(f.services.call('asset.import', input), {code: 'MEDIA_OUTSIDE_NOT_CONFIRMED'});
  assert.equal(f.app.outsidePaths.list(f.store.projectId).length, 0);
  await assert.rejects(f.services.call('asset.media.outside.confirm', {...input, locationToken: randomUUID()}));
  assert.equal(f.app.outsidePaths.list(f.store.projectId).length, 0);
  const trusted = row(await f.media.trustedCall('asset.import.path', input)), asset = row(trusted.asset);
  assert.deepEqual(trusted.confirmedDirectories, [f.external]);
  const child = path.join(f.external, 'child'); mkdirSync(child); const nested = path.join(child, 'nested.png'); writeFileSync(nested, png());
  await assert.rejects(f.services.call('asset.import', {...input, requestId: randomUUID(), sourcePath: nested}), {code: 'MEDIA_OUTSIDE_NOT_CONFIRMED'});
  f.app.outsidePaths.revoke(f.store.projectId, f.external);
  await f.media.trustedCall('asset.import.path', input);
  assert.equal(f.app.outsidePaths.list(f.store.projectId).length, 0);
  const state = row(await f.media.call('asset.media.status.list', {projectId: f.store.projectId, assetIds: [asset.id]}));
  const status = row((state.items as unknown[])[0]); assert.equal(status.readable, false); assert.equal(status.outside, true);
});

test('ordinary and trusted import handlers share one request receipt under concurrency', async t => {
  const f = await fixture(t), file = path.join(f.projectDir, 'shared-request.png'); writeFileSync(file, png());
  const input = {projectId: f.store.projectId, requestId: randomUUID(), sourcePath: file};
  const before = Number(f.store.db.prepare('SELECT contentSequence FROM project_file').get()!.contentSequence);
  const [ordinary, trusted] = await Promise.all([f.services.call('asset.import', input), f.media.trustedCall('asset.import.path', input)]);
  assert.equal(row(ordinary).id, row(row(trusted).asset).id);
  assert.equal(f.store.list('assets', f.store.projectId).length, 1);
  const concurrentDelta=Number(f.store.db.prepare('SELECT contentSequence FROM project_file').get()!.contentSequence)-before;
  const singleBefore=Number(f.store.db.prepare('SELECT contentSequence FROM project_file').get()!.contentSequence);
  await f.services.call('asset.import',{...input,requestId:randomUUID()});
  const singleDelta=Number(f.store.db.prepare('SELECT contentSequence FROM project_file').get()!.contentSequence)-singleBefore;
  assert.ok(singleDelta>0);assert.equal(concurrentDelta,singleDelta,'two handlers register exactly one import, including its semantic target row');
  assert.equal(f.store.list('assets',f.store.projectId).length,2);
  assert.deepEqual(readFileSync(file), png());
  assert.equal(readdirSync(f.projectDir).includes('素材'), false);
});

test('status reports changed and missing without accepting the new content', async t => {
  const f = await fixture(t), file = path.join(f.projectDir, 'state.png'); writeFileSync(file, png());
  const asset = row(await f.services.call('asset.import', {projectId: f.store.projectId, requestId: randomUUID(), sourcePath: file}));
  const original = JSON.stringify(f.store.get('assets', String(asset.id)));
  writeFileSync(file, png({width: 32}));
  let result = row(await f.media.call('asset.media.status.list', {projectId: f.store.projectId, assetIds: [asset.id]}));
  assert.equal(row((result.items as unknown[])[0]).status, 'changed');
  assert.equal(JSON.stringify(f.store.get('assets', String(asset.id))), original);
  unlinkSync(file); result = row(await f.media.call('asset.media.status.list', {projectId: f.store.projectId, assetIds: [asset.id]}));
  assert.equal(row((result.items as unknown[])[0]).status, 'missing');
  assert.equal(JSON.stringify(f.store.get('assets', String(asset.id))), original);
});

test('relink keeps identity and advances revision while accepting changed bytes creates another identity', async t => {
  const f = await fixture(t), file = path.join(f.projectDir, 'before.png'); writeFileSync(file, png());
  const asset = row(await f.services.call('asset.import', {projectId: f.store.projectId, requestId: randomUUID(), sourcePath: file}));
  const moved = path.join(f.projectDir, 'moved.png'); renameSync(file, moved);
  const preview = row(await f.media.call('asset.media.relink.preview', {projectId: f.store.projectId, assetId: asset.id, sourcePath: moved, expectedReferenceRevision: 1}));
  const input = {projectId: f.store.projectId, requestId: randomUUID(), previewToken: preview.previewToken};
  const applied = row(await f.media.call('asset.media.relink.apply', input)), linked = row((applied.assets as unknown[])[0]);
  assert.equal(linked.id, asset.id); assert.equal(linked.referenceRevision, 2);
  assert.deepEqual(await f.media.call('asset.media.relink.apply', input), applied);
  const original = JSON.stringify(f.store.get('assets', String(asset.id))); writeFileSync(moved, png({width: 32}));
  const changedInput = {projectId: f.store.projectId, requestId: randomUUID(), assetId: asset.id, expectedReferenceRevision: 2};
  const accepted = row(await f.media.call('asset.media.acceptChanged', changedInput)), replacement = row(accepted.asset);
  assert.notEqual(replacement.id, asset.id); assert.equal(replacement.width, 32);
  assert.equal(JSON.stringify(f.store.get('assets', String(asset.id))), original);
  assert.deepEqual(await f.media.call('asset.media.acceptChanged', changedInput), accepted);
  // Model an acknowledgement lost after the SQLite commit but before the
  // private response receipt. Replaying must not read or import new content.
  const key = createHash('sha256').update(JSON.stringify(['asset.media.acceptChanged', changedInput.requestId])).digest('hex');
  const directory = path.join(f.store.tempDir, 'asset-media'), receiptFile = path.join(directory, `request-${key}.json`);
  const receipt: unknown = JSON.parse(readFileSync(receiptFile, 'utf8'));
  writePrivateFileAtomic(receiptFile, JSON.stringify({digest: row(receipt).digest, phase: 'intent'}), {root: directory, maxBytes: 512 * 1024});
  unlinkSync(moved);
  assert.deepEqual(await f.media.call('asset.media.acceptChanged', changedInput), accepted);
  assert.equal(f.store.list('assets', f.store.projectId).length, 2);
});


test('a relink preview refuses a concurrent asset revision rather than binding an old candidate to it', async t => {
  const f = await fixture(t), file = path.join(f.projectDir, 'race.png'); writeFileSync(file, png());
  const asset = row(await f.services.call('asset.import', {projectId: f.store.projectId, requestId: randomUUID(), sourcePath: file}));
  const pending = f.media.call('asset.media.relink.preview', {projectId: f.store.projectId, assetId: asset.id, sourcePath: file, expectedReferenceRevision: 1});
  f.store.put('assets', {...row(f.store.get('assets', String(asset.id))), referenceRevision: 2});
  await assert.rejects(pending, {code: 'REVISION_CONFLICT'});
  assert.equal(row(f.store.get('assets', String(asset.id))).referenceRevision, 2);
});

test('invalid uploads are rejected before creating project media', async t => {
  const f = await fixture(t);
  await assert.rejects(f.services.call('asset.import', {...f.upload(randomUUID()), mimeType: 'audio/wav'}), {code: 'INVALID_MEDIA'});
  assert.equal(f.store.list('assets', f.store.projectId).length, 0);
  assert.equal(readdirSync(f.projectDir).includes('素材'), false);
});


for(const mode of ['overwrite','revoke'] as const)test(`acceptChanged refuses a real probe-time ${mode} without registering a replacement`,async t=>{
 const f=await fixture(t),file=path.join(mode==='revoke'?f.external:f.projectDir,'probe-race.png');writeFileSync(file,png());
 if(mode==='revoke')f.app.outsidePaths.confirm({projectId:f.store.projectId,directory:f.external,confirmedAt:new Date().toISOString()});
 const imported=row(await f.services.call('asset.import',{projectId:f.store.projectId,requestId:randomUUID(),sourcePath:file})),original=f.store.get('assets',String(imported.id));
 const second=png({pixel:()=>[1,2,3,255]}),third=png({pixel:()=>[4,5,6,255]});writeFileSync(file,second);
 let changed=false;
 const off=onMediaProcess(event=>{if(event.type==='started'&&event.kind==='ffprobe'&&!changed){changed=true;if(mode==='overwrite')writeFileSync(file,third);else f.app.outsidePaths.revoke(f.store.projectId,f.external);}});
 const input={projectId:f.store.projectId,requestId:randomUUID(),assetId:imported.id,expectedReferenceRevision:1};
 try{await assert.rejects(f.media.call('asset.media.acceptChanged',input),{code:mode==='overwrite'?'MEDIA_CHANGED_DURING_READ':'MEDIA_OUTSIDE_NOT_CONFIRMED'});}finally{off();}
 assert.equal(changed,true);assert.equal(f.store.list('assets',f.store.projectId).length,1);assert.deepEqual(f.store.get('assets',String(imported.id)),original);
 assert.equal(f.store.db.prepare('SELECT 1 FROM idempotency WHERE scope=? AND requestId=?').get('asset.media.acceptChanged',input.requestId),undefined);
 if(mode==='overwrite')assert.deepEqual(readFileSync(file),third);else assert.equal(f.app.outsidePaths.list(f.store.projectId).length,0);
});
