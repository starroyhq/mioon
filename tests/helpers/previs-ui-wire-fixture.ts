/** Real format-5 project for the previs-editor headless acceptance. The browser
 * talks to the normal project service over HTTP; only the workbench shell around
 * the editor is a fixture. The previs node is created through the same
 * `sequence.preview` / `sequence.commit` entry the production UI uses, and the
 * subject is a real image asset of the project. */
import {createHash, randomUUID} from 'node:crypto';
import {mkdirSync, mkdtempSync, realpathSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createProjectStore} from '../../packages/business/src/project-file/store.ts';
import type {ProjectStore} from '../../packages/business/src/project-file/store.ts';
import {createServices} from '../../packages/business/src/services.ts';
import {openAppLibrary} from '../../packages/business/src/app-db/index.ts';
import {createProjectServiceApplication} from '../../packages/business/src/project-service-application.ts';
import {referenceTestAsset} from '../../packages/business/src/project-file/test-asset-fixture.ts';
import {renderMockImagePng} from '../../packages/business/src/images/png.ts';

const at = '2026-01-01T00:00:00.000Z';
const id = (number: number): string => `7a000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
export const PREVIS_UI_IDS = {
  project: id(1), root: id(2), previs: id(3), subject: id(10), subjectVersion: id(11),
  imageAsset: id(20), timeline: id(30), videoTrack: id(31),
} as const;

export interface PrevisUiWireFixture {
  readonly store: ProjectStore;
  readonly services: ReturnType<typeof createServices>;
  readonly library: ReturnType<typeof openAppLibrary>;
  readonly projectId: string;
  readonly previsId: string;
  readonly subjectId: string;
  readonly headVersionId: string;
  readonly root: string;
}

export async function createPrevisUiWireFixture(): Promise<PrevisUiWireFixture> {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-previs-ui-wire-'));
  const projectId = PREVIS_UI_IDS.project;
  const store = createProjectStore({projectId, projectFile: path.join(root, 'project.mioon'), targetFormat: 5,
    locate: () => ({localDir: path.join(root, 'records'), cacheDir: path.join(root, 'cache'), tempDir: path.join(root, 'temp')})});
  // A real project-owned PNG for the subject head version.
  const bytes = await renderMockImagePng({width: 64, height: 96});
  const mediaDirectory = path.join(root, 'media');
  mkdirSync(mediaDirectory, {recursive: true});
  const relativePath = 'media/hero.png';
  writeFileSync(path.join(root, relativePath), bytes, {mode: 0o600});
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const asset = referenceTestAsset(root, {id: PREVIS_UI_IDS.imageAsset, projectId, name: 'Hero.png',
    mimeType: 'image/png', provenance: 'user-import', sha256, width: 64, height: 96, sizeBytes: bytes.length,
    relativePath, createdAt: at});
  const timeline = {id: PREVIS_UI_IDS.timeline, projectId, revision: 1, width: 720, height: 1280, fps: 30,
    durationFrames: 0, createdAt: at, updatedAt: at,
    mainTrack: {trackId: PREVIS_UI_IDS.videoTrack, sequenceNodeId: PREVIS_UI_IDS.root},
    tracks: [{id: PREVIS_UI_IDS.videoTrack, name: 'V1', kind: 'video', orderIndex: 0, hidden: false, muted: false}],
    clips: []};
  const version = {id: PREVIS_UI_IDS.subjectVersion, projectId, subjectId: PREVIS_UI_IDS.subject, number: 1,
    assetId: PREVIS_UI_IDS.imageAsset, sha256, mimeType: 'image/png', width: 64, height: 96,
    provenance: {kind: 'user-import', versionId: null, shotId: null, jobId: null}, createdAt: at};
  store.tx(() => {
    store.put('projects', {id: projectId, name: '预演无头夹具', revision: 1, createdAt: at, updatedAt: at});
    store.put('assets', asset);
    store.put('nodes', {id: PREVIS_UI_IDS.root, projectId, type: 'sequence_root', name: '成片', position: {x: -200, y: 0}, createdAt: at});
    store.put('timelines', timeline);
    store.db.prepare('INSERT INTO project.sequence_sync_state(timelineId,projectId,sequenceNodeId,revision,baseline) VALUES(?,?,?,?,?)')
      .run(PREVIS_UI_IDS.timeline, projectId, PREVIS_UI_IDS.root, 1, JSON.stringify({version: 1, board: [], track: []}));
    store.db.prepare(`INSERT INTO project.subjects(id,projectId,kind,name,revision,headVersionId,createdAt,updatedAt)
      VALUES(?,?,?,?,?,?,?,?)`).run(PREVIS_UI_IDS.subject, projectId, 'character', 'Hero', 1, PREVIS_UI_IDS.subjectVersion, at, at);
    store.db.prepare('INSERT INTO project.subject_versions(id,projectId,subjectId,number,assetId,data) VALUES(?,?,?,?,?,?)')
      .run(PREVIS_UI_IDS.subjectVersion, projectId, PREVIS_UI_IDS.subject, 1, PREVIS_UI_IDS.imageAsset, JSON.stringify(version));
  });
  const library = openAppLibrary({dataDir: path.join(root, 'app')});
  const services = createServices(store, new Map(), {env: {}, application: createProjectServiceApplication(library, undefined, {})});
  // One real unified-entry create: the UI opens the node this writes.
  const requestId = `previs-ui-fixture-${randomUUID()}`;
  const input = {projectId, requestId, previsIntent: {side: 'board' as const,
    operation: {kind: 'previs-create' as const, nodeId: PREVIS_UI_IDS.previs, label: '机位预演', position: {x: 120, y: 80}}}};
  const preview = await services.call('sequence.preview', input) as {ok?: boolean; code?: string; envelope?: never; planDigest?: string};
  if (preview.ok === false) throw new Error(`Previs fixture preview failed: ${preview.code}`);
  await services.call('sequence.commit', {projectId, envelope: preview.envelope, expectedPlanDigest: preview.planDigest});
  return {store, services, library, projectId, previsId: PREVIS_UI_IDS.previs,
    subjectId: PREVIS_UI_IDS.subject, headVersionId: PREVIS_UI_IDS.subjectVersion, root};
}
