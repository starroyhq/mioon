import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectPackageClient, ProjectPackageRequestError } from '../apps/web/src/project-package-client.ts';
import { projectPackagesBridge, isProjectPackageDestination, revealPlatform } from '../apps/web/src/project-package-bridge.ts';

const ok = (data: unknown, status = 200): Response => new Response(JSON.stringify({ ok: true, data }), { status, headers: { 'content-type': 'application/json' } });
const fail = (code: string, status = 400, details?: unknown): Response => new Response(JSON.stringify({ ok: false, error: { code, message: '/private/path', details } }), { status });
const counts = { shots: 4, assets: 12, versions: 9, clips: 8, subtitles: 2, subjects: 1, luts: 0 };
const status = { id: 'e1', kind: 'export', projectId: 'p1', phase: 'running', stage: 'writing', files: 3, totalFiles: 61, bytes: 10, totalBytes: 100, fileName: 'UI.mioon' };
const importPreview = { id: 'i1', kind: 'import', name: 'UI', suggestedName: 'UI（2）', nameTaken: true, counts, totalBytes: 1600, fileCount: 61, appVersion: '0.4.1', createdAt: '2026-10-21T06:32:00.000Z', timeline: { width: 1080, height: 1920, fps: 30 } };

test('requests use same-origin credentials, exact paths and validated payloads', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const replies = [ok({ projectId: 'p1', counts, totalBytes: 5, assets: { total: 12, used: 9 }, exports: { count: 0, bytes: 0 }, missing: [{ assetId: 'a', name: 'scene-f.mp4', reason: 'missing' }], warnings: { runningTasks: 1 } }), ok(status), ok({ ...status, phase: 'ready', stage: 'done' }), ok({ discarded: true })];
  const client = createProjectPackageClient({ fetcher: (async (url: string, init: RequestInit) => { calls.push({ url, init }); return replies.shift()!; }) as never });
  const preview = await client.exportPreview('p1', 'used');
  assert.equal(preview.missing[0]!.name, 'scene-f.mp4'); assert.equal(preview.warnings.runningTasks, 1);
  assert.equal((await client.startExport('p1', 'all')).phase, 'running');
  assert.equal((await client.exportStatus('e1')).phase, 'ready');
  await client.discardExport('e1');
  assert.deepEqual(calls.map(call => [call.init.method ?? 'GET', call.url]), [['GET', '/api/projects/p1/package-preview?media=used'], ['POST', '/api/project-packages/exports'], ['GET', '/api/project-packages/exports/e1'], ['DELETE', '/api/project-packages/exports/e1']]);
  assert.ok(calls.every(call => call.init.credentials === 'same-origin'));
  assert.deepEqual(JSON.parse(String(calls[1]!.init.body)), { projectId: 'p1', media: 'all' });
  assert.equal(client.downloadUrl('e1'), '/api/project-packages/exports/e1/download');
});

test('server errors keep code and details; malformed bodies are protocol errors', async () => {
  const replies = [fail('PROJECT_PACKAGE_SOURCE_MISSING', 409, { missing: [{ assetId: 'a', name: 'x.mp4', reason: 'changed' }] }), ok({ ...status, phase: 'weird' }), fail('/bad'), fail('ANY', 401)];
  const client = createProjectPackageClient({ fetcher: (async () => replies.shift()!) as never });
  await assert.rejects(client.startExport('p1', 'all'), (error: unknown) => error instanceof ProjectPackageRequestError && error.code === 'PROJECT_PACKAGE_SOURCE_MISSING' && Array.isArray(error.details?.missing) && !error.network && !error.message.includes('private'));
  await assert.rejects(client.exportStatus('e1'), (error: unknown) => (error as ProjectPackageRequestError).code === 'BACKEND_PROTOCOL_ERROR');
  await assert.rejects(client.exportStatus('e1'), (error: unknown) => (error as ProjectPackageRequestError).code === 'BACKEND_PROTOCOL_ERROR');
  await assert.rejects(client.exportStatus('e1'), (error: unknown) => (error as ProjectPackageRequestError).code === 'UNAUTHORIZED');
});

test('commit and duplicate retry a lost answer with the same requestId, never a definitive rejection', async () => {
  const bodies: unknown[] = [], waits: number[] = [];
  let attempt = 0;
  const client = createProjectPackageClient({ wait: async ms => { waits.push(ms); }, fetcher: (async (_url: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); if (attempt++ < 2) throw new TypeError('Failed to fetch'); return ok({ projectId: 'new' }); }) as never });
  assert.deepEqual(await client.commitImport('i1', { requestId: 'request-1', name: 'UI（2）' }), { projectId: 'new' });
  assert.equal(bodies.length, 3); assert.ok(bodies.every(body => JSON.stringify(body) === JSON.stringify({ requestId: 'request-1', name: 'UI（2）' }))); assert.equal(waits.length, 2);
  let calls = 0;
  const rejecting = createProjectPackageClient({ wait: async () => {}, fetcher: (async () => { calls++; return fail('PROJECT_PACKAGE_BUSY', 409); }) as never });
  await assert.rejects(rejecting.duplicate({ projectId: 'p1', requestId: 'request-2', name: 'Copy' }), (error: unknown) => (error as ProjectPackageRequestError).code === 'PROJECT_PACKAGE_BUSY');
  assert.equal(calls, 1);
  const offline = createProjectPackageClient({ wait: async () => {}, fetcher: (async () => { throw new TypeError('offline'); }) as never });
  await assert.rejects(offline.duplicate({ projectId: 'p1', requestId: 'request-3', name: 'Copy' }), (error: unknown) => (error as ProjectPackageRequestError).network);
});

class FakeXhr {
  static last: FakeXhr;
  method = ''; url = ''; headers: Record<string, string> = {}; withCredentials = false; status = 0; responseText = ''; sent: unknown = null; aborted = false;
  upload: { onprogress: ((event: { loaded: number; total: number; lengthComputable: boolean }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null; onerror: (() => void) | null = null; onabort: (() => void) | null = null;
  constructor() { FakeXhr.last = this; }
  open(method: string, url: string) { this.method = method; this.url = url; }
  setRequestHeader(name: string, value: string) { this.headers[name] = value; }
  send(body: unknown) { this.sent = body; }
  abort() { this.aborted = true; this.onabort?.(); }
}

test('import upload streams the raw file with progress and validates the preview', async () => {
  const progress: number[][] = [];
  const client = createProjectPackageClient({ createXhr: () => new FakeXhr() as never });
  const file = new Blob(['MIOON']);
  const pending = client.uploadImport(file, { onProgress: (loaded, total) => progress.push([loaded, total]) });
  const xhr = FakeXhr.last;
  assert.deepEqual([xhr.method, xhr.url, xhr.headers['Content-Type'], xhr.withCredentials, xhr.sent === file], ['POST', '/api/project-packages/imports', 'application/octet-stream', true, true]);
  xhr.upload.onprogress!({ loaded: 2, total: 5, lengthComputable: true });
  xhr.status = 200; xhr.responseText = JSON.stringify({ ok: true, data: importPreview }); xhr.onload!();
  const preview = await pending;
  assert.equal(preview.suggestedName, 'UI（2）'); assert.deepEqual(preview.timeline, { width: 1080, height: 1920, fps: 30 }); assert.deepEqual(progress, [[2, 5]]);

  const rejected = client.uploadImport(file);
  FakeXhr.last.status = 400; FakeXhr.last.responseText = JSON.stringify({ ok: false, error: { code: 'PROJECT_PACKAGE_NEWER_FORMAT', message: 'x', details: { formatVersion: 2, supported: 1 } } }); FakeXhr.last.onload!();
  await assert.rejects(rejected, (error: unknown) => (error as ProjectPackageRequestError).code === 'PROJECT_PACKAGE_NEWER_FORMAT' && (error as ProjectPackageRequestError).details?.formatVersion === 2);

  const abort = new AbortController(), cancelled = client.uploadImport(file, { signal: abort.signal });
  abort.abort();
  await assert.rejects(cancelled, (error: unknown) => (error as ProjectPackageRequestError).code === 'PROJECT_PACKAGE_CANCELLED'); assert.equal(FakeXhr.last.aborted, true);
  const lost = client.uploadImport(file); FakeXhr.last.onerror!();
  await assert.rejects(lost, (error: unknown) => (error as ProjectPackageRequestError).network);
});

test('desktop bridge is accepted only with all three fixed functions', () => {
  assert.equal(projectPackagesBridge({}), null);
  assert.equal(projectPackagesBridge({ __mioonProjectPackages: { chooseDestination() {}, save() {} } }), null);
  const bridge = { chooseDestination: async () => null, save: async () => ({ fileName: 'a.mioon' }), reveal: async () => true };
  assert.equal(projectPackagesBridge({ __mioonProjectPackages: bridge }), bridge);
  assert.equal(isProjectPackageDestination({ token: 't', fileName: 'a.mioon' }), true);
  assert.equal(isProjectPackageDestination({ token: '', fileName: 'a.mioon' }), false);
  assert.equal(isProjectPackageDestination(null), false);
  assert.equal(revealPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X)'), 'finder');
  assert.equal(revealPlatform('Mozilla/5.0 (Windows NT 10.0)'), 'explorer');
  assert.equal(revealPlatform('X11; Linux'), 'files');
});
