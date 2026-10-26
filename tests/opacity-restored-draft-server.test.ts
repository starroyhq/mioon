import test, {after, mock} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import http from 'node:http';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import * as legacy from '../packages/contracts/src/index.ts';
import {LOCAL_DRAFT_LIMITS} from '../packages/contracts/src/local-drafts.ts';
import {OPACITY_RESTORED_DRAFT_PROFILE} from '../packages/contracts/src/local-drafts-opacity-restored.ts';
import {restoreOpacityCandidateWorkspaceBackup} from '../packages/business/src/opacity-candidate-backup.ts';
import {onMediaProcess} from '../packages/business/src/media-processes.ts';
import {createRestoredOpacityCandidateLaunch} from '../apps/server/src/opacity-candidate-launch.ts';
import {createOpacityCandidateRequestApplication} from '../apps/server/src/index.ts';
import {createOpacityCandidateApplication, readOpacityCandidateApplication} from '../apps/web/src/opacity-candidate-application.ts';
import * as draftClients from '../apps/web/src/clip-draft-client.ts';
import {createClipDraftController, clipDraftRaw, clipDraftSource} from '../apps/web/src/clip-draft-state.ts';
import {rawOpacityEnvelopeFields} from '../apps/web/src/clip-opacity-envelope-state.ts';
import {createEditTaskClient} from '../apps/web/src/edit-task-client.ts';
import {createEditTaskController} from '../apps/web/src/edit-task-controller.ts';
import {pinNewWorkspaceIntent} from '../apps/web/src/workspace-origin.ts';
import {rpc} from '../apps/web/src/api.ts';
import {restoredApplicationFixture,request,restoredApplicationToken} from './helpers/opacity-restored-application-fixture.ts';
import type {RestoredHttpResult} from './helpers/strict-opacity-restored-types.ts';
import {logicalTables} from './helpers/opacity-backup-fixture.ts';

// Actual cold42 archive and independent43 publication, exact application launch,
// shared HTTP handler and frontend clients/controllers. No listener, native
// media, provider or external HTTP transport participates.
let forbiddenAttempts = 0;
const forbidden = () => {forbiddenAttempts++; throw Error('No listener, native child, provider or external fetch is permitted.');};
mock.method(http.Server.prototype, 'listen', forbidden);
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const) mock.method(cp, name, forbidden);
mock.method(globalThis, 'fetch', forbidden); syncBuiltinESMExports();
const media: unknown[] = [], off = onMediaProcess(event => media.push(event));
after(() => {off(); mock.restoreAll(); syncBuiltinESMExports(); assert.equal(forbiddenAttempts, 0); assert.deepEqual(media, []);});

const filename = 'local-drafts-restored43-v1.json', clipRoute = '/api/local-drafts/restored43/clip', listRoute = '/api/local-drafts/restored43';
const key = (f: import('./helpers/strict-opacity-restored-types.ts').RestoredFixture) => ({projectId: f.projectId, timelineId: f.timelineId, clipId: f.clipId});
const authority = (f: import('./helpers/strict-opacity-restored-types.ts').RestoredFixture) => ({schemaVersion: 1, expectedWorkspaceOrigin: f.restored.workspaceOrigin});
const url = <List extends boolean=false>(f: import('./helpers/strict-opacity-restored-types.ts').RestoredFixture, list:List = false as List, extra = {}) => `${list ? listRoute : clipRoute}?${new URLSearchParams({...(list ? {projectId: f.projectId} : key(f)),
  schemaVersion: '1', expectedWorkspaceOrigin: f.restored.workspaceOrigin, ...extra})}` as (List extends true?`/api/local-drafts/restored43?${string}`:`/api/local-drafts/restored43/clip?${string}`);
const diskFile = (f: import('./helpers/strict-opacity-restored-types.ts').RestoredFixture) => path.join(f.destination, filename);
const sqlRows = (f: import('./helpers/strict-opacity-restored-types.ts').RestoredFixture) => f.readDb(logicalTables) as import('./helpers/strict-opacity-fixture-types.ts').OpacityBackupFixture['before'];
const raw = (f: import('./helpers/strict-opacity-restored-types.ts').RestoredFixture, name = 'Current origin draft 界') => ({...clipDraftRaw((f.timeline.clips[0] as unknown as Parameters<typeof clipDraftRaw>[0])), ...rawOpacityEnvelopeFields(f.timeline.clips[0]), name,
  opacityEnvelope: {profileId: f.opacityEnvelope.profileId, points: [{frame: '0', opacity: '.'}, {frame: '30', opacity: '1'}]}});
const write = (f: import('./helpers/strict-opacity-restored-types.ts').RestoredFixture, envelope: { workspaceScope: unknown; instanceId: unknown; revision: unknown; }, value = raw(f)) => ({...key(f), ...authority(f), workspaceScope: envelope.workspaceScope,
  instanceId: envelope.instanceId, expectedRevision: envelope.revision, baseRevision: f.timeline.revision,
  source: {assetId: f.assetId, assetSha256: f.readDb((db) => JSON.parse((db.prepare('SELECT data FROM assets WHERE id=?').get(f.assetId)!.data as string)).sha256)}, raw: value});
const deletion = (f: import('./helpers/strict-opacity-restored-types.ts').RestoredFixture, envelope: { workspaceScope: unknown; instanceId: unknown; revision: unknown; }) => ({...key(f), ...authority(f), workspaceScope: envelope.workspaceScope, instanceId: envelope.instanceId, expectedRevision: envelope.revision});
const accepted = <Data>(response: RestoredHttpResult<Data>) => {assert.equal(response.status, 200, response.text); assert.equal(response.data.ok, true, response.text); return response.data.data;};
const refusalStatus = {LOCAL_DRAFT_VALIDATION: 400, LOCAL_DRAFT_CONFLICT: 409, LOCAL_DRAFT_STALE_INSTANCE: 409,
  LOCAL_DRAFT_SCOPE_MISMATCH: 409, LOCAL_DRAFT_LIMIT: 413, LOCAL_DRAFT_STORAGE_UNAVAILABLE: 503};
const refused = (response: RestoredHttpResult, code: string) => {assert.equal(response.status, refusalStatus[code as keyof typeof refusalStatus], response.text);
  assert.equal(response.data?.ok, false, response.text); assert.equal(response.data.error.code, code, response.text); return response;};
const get = async (f: import('./helpers/strict-opacity-restored-types.ts').RestoredFixture) => accepted(await (request as unknown as import('./helpers/strict-opacity-restored-types.ts').RestoredRequest)(f.app, url(f)));
const list = async (f: import('./helpers/strict-opacity-restored-types.ts').RestoredFixture) => accepted(await (request as unknown as import('./helpers/strict-opacity-restored-types.ts').RestoredRequest)(f.app, url(f, true)));
const put = async (f: import('./helpers/strict-opacity-restored-types.ts').RestoredFixture, input: { schemaVersion: number; expectedWorkspaceOrigin: unknown; workspaceScope: unknown; instanceId: unknown; expectedRevision: unknown; baseRevision: unknown; source: { assetId: unknown; assetSha256: unknown; }; raw: { name: string; opacityEnvelope: { profileId: unknown; points: { frame: string; opacity: string; }[]; }; trackId: string; startFrame: string|number; durationFrames: string|number; sourceInFrame: string|number; rect: { x: string|number; y: string|number; width: string|number; height: string|number; }; gain: string|number; fadeInFrames?: string|number|undefined; fadeOutFrames?: string|number|undefined; colour?: { profileId: "mioon-rec709-sdr-clip-v1"; source: { profileId: "rec709-yuv-sdr-v1"; assetSha256: string; streamIndex: number; range: "limited"|"full"; declaredBy: "user"; declaredAt: string; }|null; look: { declaredBy: "user"; resourceId: string; resourceSha256: string; resourceProfile: "mioon-cube3d-normalized-tetrahedral-v1"; purpose: "rec709-sdr-creative"; enabled: boolean; strength: number; }|null; }|{ profileId: "mioon-srgb-image-clip-v1"; source: { profileId: "png-rgb8-srgb-v1"; assetSha256: string; declaredBy: "user"; declaredAt: string; interpretation: "srgb"; evidence: { orientation: 1; width: number; height: number; profileId: "png-rgb8-srgb-v1"; sha256: string; sourceByteLength: number; bitDepth: 8; alphaMode: "opaque"|"straight"; colourTag: "srgb"|"untagged"; }; }|null; look: { declaredBy: "user"; resourceId: string; resourceSha256: string; resourceProfile: "mioon-cube3d-normalized-tetrahedral-v1"; purpose: "rec709-sdr-creative"; enabled: boolean; strength: number; }|null; }|{ profileId: "mioon-jfif-image-clip-v1"; source: { profileId: "jfif-ycbcr8-srgb-v1"; assetSha256: string; declaredBy: "user"; declaredAt: string; interpretation: "srgb"; evidence: { orientation: 1; width: number; height: number; profileId: "jfif-ycbcr8-srgb-v1"; sha256: string; sourceByteLength: number; bitDepth: 8; alphaMode: "opaque"; colourTag: "untagged"; sampling: "444"|"422"|"420"; decoderPolicy: "ffmpeg-mjpeg-int-bt601-full-bilinear-rgb24-v1"; }; }|null; look: { declaredBy: "user"; resourceId: string; resourceSha256: string; resourceProfile: "mioon-cube3d-normalized-tetrahedral-v1"; purpose: "rec709-sdr-creative"; enabled: boolean; strength: number; }|null; }|null|undefined; audioRole?: "human"|"music"|"sfx"|null|undefined; volumeEnvelope?: { profileId: "mioon-clip-linear-attenuation-v1"; points: { frame: string; multiplier: string; }[]; }|null|undefined; }; projectId: unknown; timelineId: unknown; clipId: unknown; }|{ schemaVersion: string; expectedWorkspaceOrigin: unknown; workspaceScope: unknown; instanceId: unknown; expectedRevision: unknown; baseRevision: unknown; source: { assetId: unknown; assetSha256: unknown; }; raw: { name: string; opacityEnvelope: { profileId: unknown; points: { frame: string; opacity: string; }[]; }; trackId: string; startFrame: string|number; durationFrames: string|number; sourceInFrame: string|number; rect: { x: string|number; y: string|number; width: string|number; height: string|number; }; gain: string|number; fadeInFrames?: string|number|undefined; fadeOutFrames?: string|number|undefined; colour?: { profileId: "mioon-rec709-sdr-clip-v1"; source: { profileId: "rec709-yuv-sdr-v1"; assetSha256: string; streamIndex: number; range: "limited"|"full"; declaredBy: "user"; declaredAt: string; }|null; look: { declaredBy: "user"; resourceId: string; resourceSha256: string; resourceProfile: "mioon-cube3d-normalized-tetrahedral-v1"; purpose: "rec709-sdr-creative"; enabled: boolean; strength: number; }|null; }|{ profileId: "mioon-srgb-image-clip-v1"; source: { profileId: "png-rgb8-srgb-v1"; assetSha256: string; declaredBy: "user"; declaredAt: string; interpretation: "srgb"; evidence: { orientation: 1; width: number; height: number; profileId: "png-rgb8-srgb-v1"; sha256: string; sourceByteLength: number; bitDepth: 8; alphaMode: "opaque"|"straight"; colourTag: "srgb"|"untagged"; }; }|null; look: { declaredBy: "user"; resourceId: string; resourceSha256: string; resourceProfile: "mioon-cube3d-normalized-tetrahedral-v1"; purpose: "rec709-sdr-creative"; enabled: boolean; strength: number; }|null; }|{ profileId: "mioon-jfif-image-clip-v1"; source: { profileId: "jfif-ycbcr8-srgb-v1"; assetSha256: string; declaredBy: "user"; declaredAt: string; interpretation: "srgb"; evidence: { orientation: 1; width: number; height: number; profileId: "jfif-ycbcr8-srgb-v1"; sha256: string; sourceByteLength: number; bitDepth: 8; alphaMode: "opaque"; colourTag: "untagged"; sampling: "444"|"422"|"420"; decoderPolicy: "ffmpeg-mjpeg-int-bt601-full-bilinear-rgb24-v1"; }; }|null; look: { declaredBy: "user"; resourceId: string; resourceSha256: string; resourceProfile: "mioon-cube3d-normalized-tetrahedral-v1"; purpose: "rec709-sdr-creative"; enabled: boolean; strength: number; }|null; }|null|undefined; audioRole?: "human"|"music"|"sfx"|null|undefined; volumeEnvelope?: { profileId: "mioon-clip-linear-attenuation-v1"; points: { frame: string; multiplier: string; }[]; }|null|undefined; }; projectId: unknown; timelineId: unknown; clipId: unknown; }|{ schemaVersion: undefined; expectedWorkspaceOrigin: unknown; workspaceScope: unknown; instanceId: unknown; expectedRevision: unknown; baseRevision: unknown; source: { assetId: unknown; assetSha256: unknown; }; raw: { name: string; opacityEnvelope: { profileId: unknown; points: { frame: string; opacity: string; }[]; }; trackId: string; startFrame: string|number; durationFrames: string|number; sourceInFrame: string|number; rect: { x: string|number; y: string|number; width: string|number; height: string|number; }; gain: string|number; fadeInFrames?: string|number|undefined; fadeOutFrames?: string|number|undefined; colour?: { profileId: "mioon-rec709-sdr-clip-v1"; source: { profileId: "rec709-yuv-sdr-v1"; assetSha256: string; streamIndex: number; range: "limited"|"full"; declaredBy: "user"; declaredAt: string; }|null; look: { declaredBy: "user"; resourceId: string; resourceSha256: string; resourceProfile: "mioon-cube3d-normalized-tetrahedral-v1"; purpose: "rec709-sdr-creative"; enabled: boolean; strength: number; }|null; }|{ profileId: "mioon-srgb-image-clip-v1"; source: { profileId: "png-rgb8-srgb-v1"; assetSha256: string; declaredBy: "user"; declaredAt: string; interpretation: "srgb"; evidence: { orientation: 1; width: number; height: number; profileId: "png-rgb8-srgb-v1"; sha256: string; sourceByteLength: number; bitDepth: 8; alphaMode: "opaque"|"straight"; colourTag: "srgb"|"untagged"; }; }|null; look: { declaredBy: "user"; resourceId: string; resourceSha256: string; resourceProfile: "mioon-cube3d-normalized-tetrahedral-v1"; purpose: "rec709-sdr-creative"; enabled: boolean; strength: number; }|null; }|{ profileId: "mioon-jfif-image-clip-v1"; source: { profileId: "jfif-ycbcr8-srgb-v1"; assetSha256: string; declaredBy: "user"; declaredAt: string; interpretation: "srgb"; evidence: { orientation: 1; width: number; height: number; profileId: "jfif-ycbcr8-srgb-v1"; sha256: string; sourceByteLength: number; bitDepth: 8; alphaMode: "opaque"; colourTag: "untagged"; sampling: "444"|"422"|"420"; decoderPolicy: "ffmpeg-mjpeg-int-bt601-full-bilinear-rgb24-v1"; }; }|null; look: { declaredBy: "user"; resourceId: string; resourceSha256: string; resourceProfile: "mioon-cube3d-normalized-tetrahedral-v1"; purpose: "rec709-sdr-creative"; enabled: boolean; strength: number; }|null; }|null|undefined; audioRole?: "human"|"music"|"sfx"|null|undefined; volumeEnvelope?: { profileId: "mioon-clip-linear-attenuation-v1"; points: { frame: string; multiplier: string; }[]; }|null|undefined; }; projectId: unknown; timelineId: unknown; clipId: unknown; }|{ expectedWorkspaceOrigin: undefined; schemaVersion: number; workspaceScope: unknown; instanceId: unknown; expectedRevision: unknown; baseRevision: unknown; source: { assetId: unknown; assetSha256: unknown; }; raw: { name: string; opacityEnvelope: { profileId: unknown; points: { frame: string; opacity: string; }[]; }; trackId: string; startFrame: string|number; durationFrames: string|number; sourceInFrame: string|number; rect: { x: string|number; y: string|number; width: string|number; height: string|number; }; gain: string|number; fadeInFrames?: string|number|undefined; fadeOutFrames?: string|number|undefined; colour?: { profileId: "mioon-rec709-sdr-clip-v1"; source: { profileId: "rec709-yuv-sdr-v1"; assetSha256: string; streamIndex: number; range: "limited"|"full"; declaredBy: "user"; declaredAt: string; }|null; look: { declaredBy: "user"; resourceId: string; resourceSha256: string; resourceProfile: "mioon-cube3d-normalized-tetrahedral-v1"; purpose: "rec709-sdr-creative"; enabled: boolean; strength: number; }|null; }|{ profileId: "mioon-srgb-image-clip-v1"; source: { profileId: "png-rgb8-srgb-v1"; assetSha256: string; declaredBy: "user"; declaredAt: string; interpretation: "srgb"; evidence: { orientation: 1; width: number; height: number; profileId: "png-rgb8-srgb-v1"; sha256: string; sourceByteLength: number; bitDepth: 8; alphaMode: "opaque"|"straight"; colourTag: "srgb"|"untagged"; }; }|null; look: { declaredBy: "user"; resourceId: string; resourceSha256: string; resourceProfile: "mioon-cube3d-normalized-tetrahedral-v1"; purpose: "rec709-sdr-creative"; enabled: boolean; strength: number; }|null; }|{ profileId: "mioon-jfif-image-clip-v1"; source: { profileId: "jfif-ycbcr8-srgb-v1"; assetSha256: string; declaredBy: "user"; declaredAt: string; interpretation: "srgb"; evidence: { orientation: 1; width: number; height: number; profileId: "jfif-ycbcr8-srgb-v1"; sha256: string; sourceByteLength: number; bitDepth: 8; alphaMode: "opaque"; colourTag: "untagged"; sampling: "444"|"422"|"420"; decoderPolicy: "ffmpeg-mjpeg-int-bt601-full-bilinear-rgb24-v1"; }; }|null; look: { declaredBy: "user"; resourceId: string; resourceSha256: string; resourceProfile: "mioon-cube3d-normalized-tetrahedral-v1"; purpose: "rec709-sdr-creative"; enabled: boolean; strength: number; }|null; }|null|undefined; audioRole?: "human"|"music"|"sfx"|null|undefined; volumeEnvelope?: { profileId: "mioon-clip-linear-attenuation-v1"; points: { frame: string; multiplier: string; }[]; }|null|undefined; }; projectId: unknown; timelineId: unknown; clipId: unknown; }) => (request as unknown as import('./helpers/strict-opacity-restored-types.ts').RestoredRequest)(f.app, clipRoute, {method: 'PUT', input});
const remove = async (f: import('./helpers/strict-opacity-restored-types.ts').RestoredFixture, input: { workspaceScope: unknown; instanceId: unknown; expectedRevision: unknown; schemaVersion: number; expectedWorkspaceOrigin: unknown; projectId: unknown; timelineId: unknown; clipId: unknown; }) => (request as unknown as import('./helpers/strict-opacity-restored-types.ts').RestoredRequest)(f.app, clipRoute, {method: 'DELETE', input});
const deferred = () => {let resolve: ((value?:unknown)=>void)|undefined; const promise = new Promise(yes => {resolve = yes;}); return {promise, resolve};};
async function bounded(promise: Promise<unknown>) {
  let timer;
  try {return await Promise.race([promise, new Promise((_, reject) => {timer = setTimeout(() => reject(Error('Owned draft HTTP continuation did not enter within 10 seconds.')), 10000);})]);}
  finally {clearTimeout(timer);}
}

function assertEnvelope(f: import('./helpers/strict-opacity-restored-types.ts').RestoredFixture, envelope: { supported: unknown; schemaVersion: unknown; profileId: unknown; workspaceOrigin: unknown; }) {
  assert.equal(envelope.supported, true); assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.profileId, OPACITY_RESTORED_DRAFT_PROFILE); assert.equal(envelope.workspaceOrigin, f.restored.workspaceOrigin);
}
function sourceExcluded(f: import('./helpers/strict-opacity-restored-types.ts').RestoredFixture) {
  assert.deepEqual(fs.readFileSync(path.join(f.source, 'local-drafts-v3.json')), f.draftBytes);
}

test('actual43 new-origin draft endpoint starts empty while captured42 v3 stays excluded and old endpoints stay unsupported', async t => {
  const f = await (restoredApplicationFixture(t) as unknown as Promise<import('./helpers/strict-opacity-restored-types.ts').RestoredFixture>), before = sqlRows(f);
  assert.equal(fs.existsSync(diskFile(f)), false); assert.equal(fs.existsSync(path.join(f.destination, 'local-drafts-v3.json')), false);
  const envelope = await get(f), listing = await list(f); assertEnvelope(f, envelope); assertEnvelope(f, listing);
  assert.equal(envelope.revision, 0); assert.equal(envelope.draft, null); assert.deepEqual(listing.items, []);
  assert.equal(listing.instanceId, envelope.instanceId); assert.equal(listing.workspaceScope, envelope.workspaceScope);
  assert.equal(fs.existsSync(diskFile(f)), false, 'a read does not create a new companion');
  // A deliberately copied old companion remains an isolated old file. Neither
  // endpoint converts or adopts its captured unfinished text into a new origin.
  const old = path.join(f.destination, 'local-drafts-v3.json'); fs.copyFileSync(path.join(f.source, 'local-drafts-v3.json'), old, fs.constants.COPYFILE_EXCL);
  const oldBytes = fs.readFileSync(old), unsupported = {supported: false, reason: 'RESTORED_WORKSPACE_UNSUPPORTED'};
  assert.deepEqual(accepted(await (request as unknown as import('./helpers/strict-opacity-restored-types.ts').RestoredRequest)(f.app, `/api/local-drafts/clip?${new URLSearchParams(key(f))}`)), unsupported);
  assert.deepEqual(accepted(await (request as unknown as import('./helpers/strict-opacity-restored-types.ts').RestoredRequest)(f.app, `/api/local-drafts?projectId=${f.projectId}`)), unsupported);
  for (const method of ['PUT', 'DELETE'] as const) assert.deepEqual(accepted(await (request as unknown as import('./helpers/strict-opacity-restored-types.ts').RestoredRequest)(f.app, '/api/local-drafts/clip', {method, input: {}})), unsupported);
  assert.equal((await get(f)).draft, null); assert.deepEqual((await list(f)).items, []);
  assert.equal(fs.existsSync(diskFile(f)), false); assert.deepEqual(fs.readFileSync(old), oldBytes); sourceExcluded(f);
  assert.deepEqual(sqlRows(f), before);
});

test('actual43 PUT CAS, exact replay, list and explicit discard only change the current-origin companion', async t => {
  const f = await (restoredApplicationFixture(t) as unknown as Promise<import('./helpers/strict-opacity-restored-types.ts').RestoredFixture>), before = sqlRows(f), initial = await get(f), input = write(f, initial);
  const saved = accepted(await put(f, input)); assertEnvelope(f, saved);
  assert.equal(saved.revision, 1); assert.deepEqual(saved.draft!.raw, input.raw); assert.equal(saved.targetStatus, 'matching');
  const bytes = fs.readFileSync(diskFile(f)); assert.deepEqual(accepted(await put(f, input)), saved); assert.deepEqual(fs.readFileSync(diskFile(f)), bytes);
  refused(await put(f, {...input, raw: {...input.raw, name: 'Conflicting next text'}}), 'LOCAL_DRAFT_CONFLICT');
  assert.deepEqual(fs.readFileSync(diskFile(f)), bytes); assert.deepEqual((await get(f)).draft, saved.draft);
  const listing = await list(f); assert.equal(listing.items.length, 1); assert.deepEqual(listing.items[0].key, key(f)); assert.equal(listing.items[0].name, input.raw.name);
  const discarded = accepted(await remove(f, deletion(f, saved))); assert.equal(discarded.revision, 2); assert.equal(discarded.draft, null);
  assert.deepEqual(accepted(await remove(f, deletion(f, saved))), discarded); assert.deepEqual((await list(f)).items, []);
  refused(await put(f, input), 'LOCAL_DRAFT_CONFLICT');
  const next = accepted(await put(f, write(f, discarded, raw(f, 'After tombstone 界')))); assert.equal(next.revision, 3);
  assert.deepEqual(sqlRows(f), before); sourceExcluded(f);
});

test('cold43 reopen retains origin, scope and raw while rotating instance and requiring explicit frontend restore/discard', async t => {
  const f = await (restoredApplicationFixture(t) as unknown as Promise<import('./helpers/strict-opacity-restored-types.ts').RestoredFixture>), before = sqlRows(f), initial = await get(f), input = write(f, initial);
  const saved = accepted(await put(f, input)), bytes = fs.readFileSync(diskFile(f));
  await f.close(); assert.equal(fs.existsSync(path.join(f.destination, 'server.lock')), false); await f.reopen();
  const reopened = await get(f); assertEnvelope(f, reopened);
  assert.equal(reopened.workspaceScope, saved.workspaceScope); assert.notEqual(reopened.instanceId, saved.instanceId); assert.deepEqual(reopened.draft, saved.draft);
  assert.deepEqual(fs.readFileSync(diskFile(f)), bytes);
  refused(await put(f, {...input, expectedRevision: saved.revision}), 'LOCAL_DRAFT_STALE_INSTANCE');
  refused(await remove(f, deletion(f, saved)), 'LOCAL_DRAFT_STALE_INSTANCE');
  assert.deepEqual(fs.readFileSync(diskFile(f)), bytes);
  const session = await frontend(t, f); assert.deepEqual(session.controller.getState().candidate!.raw, input.raw);
  assert.equal(session.controller.hasUnsaved(), false); assert.notDeepEqual(session.controller.getState().raw, input.raw);
  assert.equal(session.controller.restore(), true); assert.deepEqual(session.controller.getState().raw, input.raw);
  assert.equal(session.controller.hasUnsaved(), true); assert.equal(await session.controller.flushForClose(), true);
  assert.equal(await session.controller.discard(session.controller.capture()), true);
  assert.equal((await get(f)).draft, null); assert.equal(session.controller.hasUnsaved(), false);
  assert.deepEqual(sqlRows(f), before); sourceExcluded(f);
});

test('shared43 HTTP refuses old wire, missing/cross origin, foreign scope, old42 files and excessive bodies without overwriting', async t => {
  const f = await (restoredApplicationFixture(t) as unknown as Promise<import('./helpers/strict-opacity-restored-types.ts').RestoredFixture>), before = sqlRows(f), saved = accepted(await put(f, write(f, await get(f))));
  const bytes = fs.readFileSync(diskFile(f)), input = write(f, saved);
  for (const patch of [{schemaVersion: 2}, {schemaVersion: '1'}, {schemaVersion: undefined}, {expectedWorkspaceOrigin: undefined}] as const)
    refused(await put(f, {...input, ...patch}), 'LOCAL_DRAFT_VALIDATION');
  refused(await put(f, {...input, expectedWorkspaceOrigin: randomUUID()}), 'LOCAL_DRAFT_SCOPE_MISMATCH');
  refused(await put(f, {...input, workspaceScope: 'f'.repeat(64)}), 'LOCAL_DRAFT_SCOPE_MISMATCH');
  refused(await (request as unknown as import('./helpers/strict-opacity-restored-types.ts').RestoredRequest)(f.app, url(f, false, {schemaVersion: '2'})), 'LOCAL_DRAFT_VALIDATION');
  refused(await (request as unknown as import('./helpers/strict-opacity-restored-types.ts').RestoredRequest)(f.app, `${clipRoute}?${new URLSearchParams(key(f))}`), 'LOCAL_DRAFT_VALIDATION');
  refused(await (request as unknown as import('./helpers/strict-opacity-restored-types.ts').RestoredRequest)(f.app, url(f, true, {expectedWorkspaceOrigin: randomUUID()})), 'LOCAL_DRAFT_SCOPE_MISMATCH');
  const oldWire = {...input}; delete (oldWire as unknown as Record<PropertyKey,unknown>).schemaVersion; delete (oldWire as unknown as Record<PropertyKey,unknown>).expectedWorkspaceOrigin;
  refused(await put(f, oldWire), 'LOCAL_DRAFT_VALIDATION');
  refused(await (request as unknown as import('./helpers/strict-opacity-restored-types.ts').RestoredRequest)(f.app, clipRoute, {method: 'PUT', input: {}, headers: {'content-length': String(LOCAL_DRAFT_LIMITS.httpBytes + 1)}}), 'LOCAL_DRAFT_LIMIT');
  refused(await (request as unknown as import('./helpers/strict-opacity-restored-types.ts').RestoredRequest)(f.app, clipRoute, {method: 'PUT', input: {padding: 'x'.repeat(LOCAL_DRAFT_LIMITS.httpBytes)}, headers: ({'content-length': undefined} as unknown as Record<string,string>)}), 'LOCAL_DRAFT_LIMIT');
  assert.deepEqual(fs.readFileSync(diskFile(f)), bytes); assert.deepEqual(sqlRows(f), before);
  const destination = path.join(f.base, 'other-restored43'), restored = await (restoreOpacityCandidateWorkspaceBackup({directory: f.backup, destination}) as unknown as Promise<import('./helpers/strict-opacity-fixture-types.ts').OpacityRestoreResult>);
  const peer = await createOpacityCandidateRequestApplication({opacityCandidateLaunch: createRestoredOpacityCandidateLaunch(destination), port: 4319,
    distDir: f.dist, token: restoredApplicationToken}); f.manage(() => peer.close());
  const other = {...f, destination, restored, app: peer}; fs.writeFileSync(diskFile(other), bytes, {mode: 0o600, flag: 'wx'});
  refused(await (request as unknown as import('./helpers/strict-opacity-restored-types.ts').RestoredRequest)(peer, url(other)), 'LOCAL_DRAFT_SCOPE_MISMATCH'); assert.deepEqual(fs.readFileSync(diskFile(other)), bytes);
  const copied42 = fs.readFileSync(path.join(f.source, 'local-drafts-v3.json')); fs.writeFileSync(diskFile(f), copied42, {mode: 0o600});
  refused(await (request as unknown as import('./helpers/strict-opacity-restored-types.ts').RestoredRequest)(f.app, url(f)), 'LOCAL_DRAFT_STORAGE_UNAVAILABLE'); assert.deepEqual(fs.readFileSync(diskFile(f)), copied42);
  assert.deepEqual(sqlRows(f), before); sourceExcluded(f);
});

async function frontend(t: test.TestContext, f: import('./helpers/strict-opacity-restored-types.ts').RestoredFixture, afterResponse?: { (observed: { path: string; method: string; }): Promise<void>; (arg0: { path: string; method: unknown; input: unknown; },arg1: RestoredHttpResult): unknown; }|undefined) {
  const requests: { path: string; method: unknown; input: unknown; }[] = [];
  const fetcher = async (url: string|URL, options: RequestInit = {}) => {
    const address = new URL(url, 'http://127.0.0.1:4319'), input = options.body ? JSON.parse((options.body as string)) : undefined;
    const observed = {path: address.pathname, method: options.method ?? 'GET', input: structuredClone(input)}; requests.push(observed);
    const sent = await (request as unknown as import('./helpers/strict-opacity-restored-types.ts').RestoredRequest)(f.app, address.pathname + address.search, {method: observed.method, input});
    await afterResponse?.(observed, sent);
    return new Response(sent.bytes as unknown as BodyInit, {status: sent.status, headers: sent.headers});
  };
  const application = (readOpacityCandidateApplication(createOpacityCandidateApplication({...legacy, rpc, createEditTaskClient: createEditTaskClient as unknown as Parameters<typeof createOpacityCandidateApplication>[0]['createEditTaskClient']}, ((fetcher) as unknown as Parameters<typeof createOpacityCandidateApplication>[1]))) as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityApplication|null);
  const workspace = await application!.rpc('workspace.restore.inspect');
  let page = await application!.rpc('project.get', {projectId: f.projectId});
  const tasks = (createEditTaskController({client: application!.taskClient, getWorkspace: () => workspace}) as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityTaskController);
  assert.equal((await tasks.load(f.projectId)).phase, 'ready');
  const client = draftClients.createRestoredOpacityCandidateClipDraftClient(workspace, (fetcher as unknown as Parameters<typeof draftClients.createRestoredOpacityCandidateClipDraftClient>[1]));
  const context = () => ({scope: `${workspace.workspaceOrigin}:${f.projectId}:current-origin-draft`, workspaceOrigin: workspace.workspaceOrigin,
    projectId: f.projectId, timelineId: f.timelineId, clipId: f.clipId, restored: true, connected: true, visible: true, busy: false,
    opacityEnvelopeEditable: true, timelineRevision: page.timeline.revision, source: clipDraftSource((page.timeline.clips[0] as unknown as Parameters<typeof clipDraftSource>[0]), (page.assets[0] as unknown as Parameters<typeof clipDraftSource>[1])),
    saved: {...clipDraftRaw((page.timeline.clips[0] as unknown as Parameters<typeof clipDraftRaw>[0])), ...rawOpacityEnvelopeFields(page.timeline.clips[0])}});
  const controller = (createClipDraftController({context: (context() as unknown as import('../apps/web/src/clip-draft-state.ts').ClipDraftContext), client, delay: 60000,
    validateTimeline: (value, projectId) => application!.isTimelineRecord(value, {projectId})}) as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityDraftController);
  t.after(() => controller.dispose()); await controller.load();
  return {application, workspace, tasks, client, controller, requests,
    async save() {
      const result = await controller.save(async (clipId, patch, expectedRevision, options) => {
        const applied = await tasks.submit(((pinNewWorkspaceIntent as unknown as import('./helpers/strict-workspace-boundary-types.ts').PinIntent)({projectId: f.projectId, operation: 'timeline.clip.update',
          input: {projectId: f.projectId, clipId, patch, expectedRevision, requestId: randomUUID()}}, workspace) as unknown as Parameters<typeof tasks.submit>[0]), options);
        assert.equal(applied.task.status, 'applied'); await tasks.acknowledge(applied.task); return applied.result;
      });
      if (result) {page = await application!.rpc('project.get', {projectId: f.projectId}); controller.setContext(context());}
      return result;
    },
  };
}

test('actual frontend late draft ACK retains newer raw and a new-instance explicit restore/Save only uses current origin', async t => {
  const f = await (restoredApplicationFixture(t) as unknown as Promise<import('./helpers/strict-opacity-restored-types.ts').RestoredFixture>), before = sqlRows(f), entered = deferred(), release = deferred();
  let heldResponse = false;
  const first = await frontend(t, f, ((async (observed: { path: string; method: string; }) => {
    if (observed.path === clipRoute && observed.method === 'PUT' && !heldResponse) {heldResponse = true; entered.resolve!(); await release.promise;}
  }) as unknown as Parameters<typeof frontend>[2]));
  t.after(() => release.resolve!());
  first.controller.edit('name', 'Older current-origin input'); const flight = first.controller.flush(); await bounded(entered.promise);
  first.controller.edit('name', 'Newer current-origin input 界');
  assert.equal(first.controller.editOpacityEnvelope({profileId: f.opacityEnvelope.profileId, points: [{frame: '0', opacity: '.6'}, {frame: '30', opacity: '1'}]}, first.controller.capture()), true);
  const newer = structuredClone(first.controller.getState().raw); release.resolve!(); await flight;
  assert.deepEqual(first.controller.getState().raw, newer); assert.equal(first.controller.hasUnsaved(), true);
  assert.equal((await get(f)).draft!.raw.name, 'Older current-origin input');
  assert.equal(await first.controller.flushForClose(), true); assert.deepEqual((await get(f)).draft!.raw, newer);
  assert.deepEqual(sqlRows(f), before);
  first.controller.dispose(); await f.close(); await f.reopen();
  const second = await frontend(t, f); assert.deepEqual(second.controller.getState().candidate!.raw, newer);
  assert.equal(second.controller.hasUnsaved(), false); assert.equal(second.controller.restore(), true);
  const result = await second.save(); assert.ok(result); assert.equal(result.clips[0].name, newer.name); assert.equal(result.clips[0].opacityEnvelope!.points[0].opacity, .6);
  assert.equal(second.controller.hasUnsaved(), false); assert.equal((await get(f)).draft, null);
  const after = sqlRows(f);
  for (const table of ['workspace_restoration', 'workspace_restore_holds', 'workspace_restore_evidence', 'workspace_restore_timeline_history', 'workspace_restore_timeline_cursors'] as const)
    assert.deepEqual(after[table], before[table]);
  assert.deepEqual(after.edit_tasks.rows.find((row) => row.id === f.taskId), before.edit_tasks.rows.find((row) => row.id === f.taskId));
  assert.deepEqual(after.exports, before.exports, 'fresh clip Save never dispatches a captured render');
  const captured = f.readDb(db => db.prepare('SELECT status,acknowledged,executionEpoch FROM edit_tasks WHERE id=?').get(f.taskId));
  assert.deepEqual({...captured}, {status: 'prepared', acknowledged: 0, executionEpoch: 'captured'});
  assert.deepEqual(f.readDb(db => db.prepare('SELECT DISTINCT executionEpoch FROM edit_tasks WHERE id<>?').all(f.taskId)).map(row => row.executionEpoch), [f.restored.workspaceOrigin]);
  const prepared = second.requests.find(row => row.path === '/api/tasks/prepare')!.input as {expectedWorkspaceOrigin:string;origin:string};
  assert.equal(prepared.expectedWorkspaceOrigin, f.restored.workspaceOrigin); assert.equal(prepared.origin, 'new');
  assert.equal(second.requests.some(row => row.path === '/api/local-drafts/clip'), false); sourceExcluded(f);
  second.controller.dispose(); await f.close(); await f.reopen(); assert.equal((await get(f)).draft, null);
  assert.deepEqual(sqlRows(f), after);
});
