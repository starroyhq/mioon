import test from 'node:test';
import assert from 'node:assert/strict';
import { createPackageFlow, flowPercent, formatPackageBytes, isProjectFileName } from '../apps/web/src/project-package-flow.ts';
import type { PackageFlowDependencies } from '../apps/web/src/project-package-flow.ts';
import { ProjectPackageRequestError } from '../apps/web/src/project-package-client.ts';
import type { ProjectPackageClient } from '../apps/web/src/project-package-client.ts';

const counts = { shots: 1, assets: 2, versions: 1, clips: 1, subtitles: 0, subjects: 0, luts: 0 };
const preview = (missing: unknown[] = []) => ({ projectId: 'p1', counts, totalBytes: 1_600_000_000, assets: { total: 12, used: 9 }, exports: { count: 0, bytes: 0 }, missing, warnings: { runningTasks: 1 } });
const status = (patch: Record<string, unknown> = {}) => ({ id: 'e1', kind: 'export', projectId: 'p1', phase: 'running', stage: 'writing', files: 1, totalFiles: 4, bytes: 25, totalBytes: 100, fileName: 'UI.mioon', ...patch });
const flush = async () => { for (let index = 0; index < 10; index++) await Promise.resolve(); };

function harness(client: Partial<ProjectPackageClient>, deps: Partial<PackageFlowDependencies> = {}) {
  const calls: unknown[][] = [], timers: (() => void)[] = [];
  const base: Partial<ProjectPackageClient> = {
    exportPreview: async (projectId, media) => { calls.push(['preview', projectId, media]); return preview() as never; },
    discardExport: async id => { calls.push(['discardExport', id]); },
    discardImport: async id => { calls.push(['discardImport', id]); },
    downloadUrl: id => `/download/${id}`,
  };
  const flow = createPackageFlow({ client: { ...base, ...client } as ProjectPackageClient, bridge: () => null, randomId: () => 'request-1', schedule: run => { timers.push(run); },
    download: (url, name) => calls.push(['download', url, name]), ...deps });
  return { flow, calls, runTimers: async () => { for (const run of timers.splice(0)) run(); await flush(); } };
}

test('browser export: options preview, start, poll, download, then delayed discard', async () => {
  const statuses = [status(), status({ phase: 'ready', stage: 'done', bytes: 100, files: 4 })];
  const h = harness({ startExport: async () => status() as never, exportStatus: async () => statuses.shift() as never });
  assert.equal(h.flow.openExport({ id: 'p1', name: 'UI' }, { unsaved: true }), true);
  await flush();
  let flow = h.flow.getState().flow!;
  assert.equal(flow.kind, 'export'); assert.equal(flow.view.step, 'options');
  assert.ok(flow.kind === 'export' && flow.unsaved && flow.view.step === 'options' && flow.view.preview?.assets.used === 9);
  h.flow.setExportMedia('used'); await flush();
  assert.deepEqual(h.calls.filter(call => call[0] === 'preview'), [['preview', 'p1', 'all'], ['preview', 'p1', 'used']]);
  await h.flow.confirmExport();
  flow = h.flow.getState().flow!; assert.equal(flow.view.step, 'running'); assert.equal(flowPercent(flow), 25);
  h.flow.toBackground(); assert.equal(h.flow.getState().flow!.background, true);
  await h.runTimers(); assert.equal(h.flow.getState().flow!.view.step, 'running');
  await h.runTimers();
  flow = h.flow.getState().flow!;
  assert.equal(flow.view.step, 'done'); assert.deepEqual(h.calls.find(call => call[0] === 'download'), ['download', '/download/e1', 'UI.mioon']);
  assert.equal(h.calls.some(call => call[0] === 'discardExport'), false, 'the staged file stays until the download stream opens');
  await h.runTimers(); assert.deepEqual(h.calls.filter(call => call[0] === 'discardExport'), [['discardExport', 'e1']]);
  h.flow.dismiss(); assert.equal(h.flow.getState().flow, null);
});

test('desktop export asks for a destination first; cancelling the dialog starts nothing', async () => {
  let started = 0, chosen: unknown = null;
  const saved: unknown[] = [];
  const bridge = { chooseDestination: async (input: unknown) => { chosen = input; return null as never; }, save: async (input: unknown) => { saved.push(input); return { fileName: 'Chosen.mioon' }; }, reveal: async () => true };
  const h = harness({ startExport: async () => { started++; return status() as never; }, exportStatus: async () => status({ phase: 'ready', stage: 'done' }) as never }, { bridge: () => bridge });
  h.flow.openExport({ id: 'p1', name: 'UI / test' }); await flush();
  await h.flow.confirmExport();
  assert.deepEqual(chosen, { suggestedName: 'UI _ test.mioon' }); assert.equal(started, 0);
  const flow = h.flow.getState().flow!; assert.ok(flow.view.step === 'options' && !flow.view.choosing);
  bridge.chooseDestination = async () => ({ token: 'tok', fileName: 'Chosen.mioon' }) as never;
  await h.flow.confirmExport(); await h.runTimers();
  assert.deepEqual(saved, [{ token: 'tok', exportId: 'e1' }]);
  const done = h.flow.getState().flow!; assert.ok(done.kind === 'export' && done.view.step === 'done' && done.view.token === 'tok' && done.view.fileName === 'Chosen.mioon');
  assert.deepEqual(h.calls.filter(call => call[0] === 'discardExport'), [['discardExport', 'e1']]);
  assert.equal(h.calls.some(call => call[0] === 'download'), false);
});

test('missing sources block export, from the preview or from the start response', async () => {
  const missing = [{ assetId: 'a', name: 'scene-f.mp4', reason: 'missing' }];
  const blocked = harness({ exportPreview: async () => preview(missing) as never, startExport: async () => { throw new Error('must not start'); } });
  blocked.flow.openExport({ id: 'p1', name: 'UI' }); await flush();
  await blocked.flow.confirmExport();
  const view = blocked.flow.getState().flow!.view; assert.ok(view.step === 'options' && view.preview?.missing.length === 1);
  const raced = harness({ startExport: async () => { throw new ProjectPackageRequestError('PROJECT_PACKAGE_SOURCE_MISSING', { missing: [{ assetId: 'b', name: 'sound-bed.wav', reason: 'changed' }] }); } });
  raced.flow.openExport({ id: 'p1', name: 'UI' }); await flush(); await raced.flow.confirmExport();
  const after = raced.flow.getState().flow!.view; assert.ok(after.step === 'options' && after.preview?.missing[0]?.reason === 'changed');
});

test('failed and cancelled exports report the server code; cancel discards the session', async () => {
  const h = harness({ startExport: async () => status() as never, exportStatus: async () => status({ phase: 'failed', error: { code: 'PROJECT_PACKAGE_NO_SPACE' } }) as never });
  h.flow.openExport({ id: 'p1', name: 'UI' }); await flush(); await h.flow.confirmExport(); await h.runTimers();
  const view = h.flow.getState().flow!.view; assert.ok(view.step === 'failed' && view.error.code === 'PROJECT_PACKAGE_NO_SPACE');
  const c = harness({ startExport: async () => status() as never, exportStatus: async () => status() as never });
  c.flow.openExport({ id: 'p1', name: 'UI' }); await flush(); await c.flow.confirmExport();
  c.flow.dismiss(); assert.equal(c.flow.getState().flow!.view.step, 'running', 'a running export cannot be dismissed');
  await c.flow.cancelExport(); await flush();
  assert.equal(c.flow.getState().flow, null); assert.deepEqual(c.calls.filter(call => call[0] === 'discardExport'), [['discardExport', 'e1']]);
});

test('import: extension check, upload progress, preview name, commit, just-imported tag', async () => {
  const importPreview = { id: 'i1', kind: 'import', name: 'UI', suggestedName: 'UI（2）', nameTaken: true, counts, totalBytes: 10, fileCount: 3, appVersion: '0.4.1', createdAt: 'x', timeline: null };
  const commits: unknown[] = [];
  const h = harness({ uploadImport: async (_file, options) => { options?.onProgress?.(5, 10); return importPreview as never; }, commitImport: async (id, input) => { commits.push([id, input]); return { projectId: 'new-project' }; } });
  h.flow.openImport({ name: 'notes.txt', size: 3 } as File);
  const rejected = h.flow.getState().flow!.view; assert.ok(rejected.step === 'failed' && rejected.error.code === 'PROJECT_PACKAGE_NOT_MIOON');
  h.flow.dismiss();
  h.flow.openImport({ name: 'UI.MIOON', size: 10 } as File); await flush();
  const shown = h.flow.getState().flow!.view; assert.ok(shown.step === 'preview' && shown.name === 'UI（2）');
  h.flow.setImportName('  Renamed  '); h.flow.confirmImport(); await flush();
  assert.deepEqual(commits, [['i1', { requestId: 'request-1', name: 'Renamed' }]]);
  const state = h.flow.getState(); assert.equal(state.flow!.view.step, 'done'); assert.deepEqual(state.recentImports, ['new-project']); assert.equal(state.created, 1);
  h.flow.openImport({ name: 'b.mioon', size: 1 } as File); await flush();
  h.flow.dismiss(); assert.deepEqual(h.calls.filter(call => call[0] === 'discardImport'), [['discardImport', 'i1']], 'closing a staged preview discards it');
});

test('import failure with an unknown outcome still refreshes lists; definitive failure discards staging', async () => {
  const importPreview = { id: 'i1', kind: 'import', name: 'UI', suggestedName: 'UI', nameTaken: false, counts, totalBytes: 10, fileCount: 3, appVersion: '0.4.1', createdAt: 'x', timeline: null };
  const lost = harness({ uploadImport: async () => importPreview as never, commitImport: async () => { throw new ProjectPackageRequestError('NETWORK', undefined, true); } });
  lost.flow.openImport({ name: 'a.mioon', size: 1 } as File); await flush(); lost.flow.confirmImport(); await flush();
  assert.equal(lost.flow.getState().created, 1); assert.equal(lost.calls.some(call => call[0] === 'discardImport'), false);
  const bad = harness({ uploadImport: async () => importPreview as never, commitImport: async () => { throw new ProjectPackageRequestError('PROJECT_PACKAGE_MEDIA_REJECTED'); } });
  bad.flow.openImport({ name: 'a.mioon', size: 1 } as File); await flush(); bad.flow.confirmImport(); await flush();
  assert.equal(bad.flow.getState().created, 0); assert.deepEqual(bad.calls.filter(call => call[0] === 'discardImport'), [['discardImport', 'i1']]);
});

test('duplicate uses the default name, size estimate and one requestId; running flows are not replaced', async () => {
  let resolve!: (value: { projectId: string }) => void;
  const inputs: unknown[] = [];
  const h = harness({ duplicate: input => { inputs.push(input); return new Promise(done => { resolve = done; }); } });
  h.flow.openDuplicate({ id: 'p1', name: 'UI' }, 'UI 副本'); await flush();
  const editing = h.flow.getState().flow!.view; assert.ok(editing.step === 'editing' && editing.estimate === 1_600_000_000 && editing.name === 'UI 副本');
  const running = h.flow.confirmDuplicate(); await flush();
  h.flow.toBackground();
  assert.equal(h.flow.openExport({ id: 'p2', name: 'Other' }), false); assert.equal(h.flow.getState().flow!.background, false, 'a new request reveals the running one');
  resolve({ projectId: 'copy' }); await running;
  assert.deepEqual(inputs, [{ projectId: 'p1', requestId: 'request-1', name: 'UI 副本' }]);
  assert.equal(h.flow.getState().flow!.view.step, 'done'); assert.equal(h.flow.getState().recentImports.length, 0);
  assert.equal(h.flow.openExport({ id: 'p2', name: 'Other' }), true, 'a finished flow gives way');
});

test('only the most recent layer owns rendering and the file picker', () => {
  const h = harness({});
  const opened: string[] = [];
  const home = h.flow.claimLayer(); h.flow.registerPicker(home, () => opened.push('home'));
  const embedded = h.flow.claimLayer(); h.flow.registerPicker(embedded, () => opened.push('embedded'));
  assert.equal(h.flow.isTopLayer(embedded), true); assert.equal(h.flow.isTopLayer(home), false);
  assert.equal(h.flow.chooseImportFile(), true); h.flow.releaseLayer(embedded); h.flow.chooseImportFile();
  assert.deepEqual(opened, ['embedded', 'home']);
});

test('sizes use decimal units and file names require the .mioon extension', () => {
  const format = (value: number, options?: Intl.NumberFormatOptions) => new Intl.NumberFormat('en', options).format(value);
  assert.equal(formatPackageBytes(1_600_000_000, format), '1.6 GB');
  assert.equal(formatPackageBytes(860_000_000, format), '860 MB');
  assert.equal(formatPackageBytes(512, format), '512 B');
  assert.equal(isProjectFileName('a.mioon'), true); assert.equal(isProjectFileName('a.mioon.zip'), false);
});

test('a file opened from the OS appears as an import preview once, and waits while another flow runs', async () => {
  const opened = { id: 'i9', kind: 'import', name: '客户 / 片', suggestedName: '客户 / 片（2）', nameTaken: true, counts, totalBytes: 2048, fileCount: 3, appVersion: '0.4.1', createdAt: '2026-10-20T00:00:00.000Z', timeline: null };
  const queue: unknown[] = [opened, null];
  let takes = 0;
  const bridge = { chooseDestination: async () => null as never, save: async () => ({ fileName: 'x.mioon' }), reveal: async () => true };
  const browser = harness({ takeOpenedImport: async () => { takes++; return queue.shift() as never; } });
  await browser.flow.checkOpened();
  assert.equal(takes, 0, 'a browser tab never asks: only the desktop receives OS files');
  const h = harness({ takeOpenedImport: async () => { takes++; return queue.shift() as never; }, duplicate: () => new Promise(() => {}) }, { bridge: () => bridge });
  await h.flow.checkOpened();
  const flow = h.flow.getState().flow!;
  assert.ok(flow.kind === 'import' && flow.view.step === 'preview' && flow.view.name === '客户 / 片（2）' && flow.fileName === '客户 _ 片.mioon' && flow.fileBytes === 2048);
  await h.flow.checkOpened(); assert.equal(h.flow.getState().flow, flow, 'nothing new replaces the shown preview');
  h.flow.dismiss();
  queue.unshift({ ...opened, id: 'i10' });
  h.flow.openDuplicate({ id: 'p1', name: 'UI' }, 'UI 副本');
  void h.flow.confirmDuplicate();
  const before = takes; await h.flow.checkOpened();
  assert.equal(takes, before, 'a running flow leaves the file waiting on the server');
});
