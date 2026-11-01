import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createClient } from '@mioon/client';
import * as storage from '@mioon/contracts/private-storage';
import { calculateWorkspaceScope } from '@mioon/contracts/workspace-scope';
import { createClipLutController } from '../apps/web/src/clip-lut-state.ts';
import { createDesktopOrBrowserLutRecovery } from '../apps/web/src/clip-lut-recovery.ts';
import { createDesktopLutRecoveryHost } from '../apps/desktop/src/lut-recovery-host.ts';
import { createDesktopLutRecoveryStore } from '../apps/desktop/src/lut-recovery-store.ts';
import { createDesktopLutRecoveryBridge } from '../apps/desktop/src/lut-recovery-preload.ts';
import { openProjectDatabase, projectDirFor } from './helpers/project-database.ts';

// Synthetic, temporary cloud profile only. These are independent Node backend
// process restarts, not an Electron/native app or real window-ownership proof.
const cube = 'LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n';
const file = () => new File([cube], 'restart.cube');
const token = 'synthetic-desktop-lut-restart-token';
const channel = 'development';
function scope(dataDir: string) {
  const directory = storage.validatePrivateDirectory(dataDir);
  const db = storage.validateManagedFile(path.join(dataDir, 'workbench.sqlite'), { root: dataDir });
  assert.ok(directory && db);
  return calculateWorkspaceScope({ channel, root: dataDir, directory, db });
}

async function startBackend(t: TestContext, dataDir: string) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { startServer } from '@mioon/server';
    const service = await startServer({dataDir:process.env.LUT_TEST_DATA,
      distDir:process.env.LUT_TEST_DATA+'/unused-dist',port:0,
      token:${JSON.stringify(token)},localDraftChannel:${JSON.stringify(channel)}});
    process.on('message', async message => {
      if (message === 'close') { await service.close(); process.disconnect(); }
    });
    process.send({url:service.url});
  `], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, LUT_TEST_DATA: dataDir },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let diagnostics = '';
  child.stdout!.setEncoding('utf8').on('data', (chunk: Buffer) => { diagnostics += chunk; });
  child.stderr!.setEncoding('utf8').on('data', (chunk: Buffer) => { diagnostics += chunk; });
  // Register the exit promise immediately, including before readiness failures.
  const exited = once(child, 'exit');
  let stopped = false;
  async function close() {
    if (stopped) return;
    stopped = true;
    if (child.exitCode === null && child.signalCode === null) child.send('close');
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    try {
      const [code, signal] = await exited;
      assert.equal(signal, null, diagnostics);
      assert.equal(code, 0, diagnostics);
    } finally { clearTimeout(timer); }
  }
  t.after(close);
  const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
  let ready;
  try {
    ready = await Promise.race([
      once(child, 'message').then(([message]) => message),
      exited.then(() => { throw Error('Backend exited before readiness: ' + diagnostics); }),
    ]);
  } finally { clearTimeout(timer); }
  return { url: ready.url, pid: child.pid, close,
    client: createClient({ env: { MIOON_BASE_URL: ready.url, MIOON_TOKEN: token } }) };
}

async function verifyBackendScope(backend: {url: string}, projectId: string, expectedScope: string) {
  const response = await fetch(`${backend.url}/api/local-drafts?projectId=${projectId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200);
  const envelope = await response.json();
  assert.equal(envelope.ok, true);
  assert.equal(envelope.data.workspaceScope, expectedScope, 'Host fingerprint matches actual backend workspace identity');
}

// Inspect only after graceful backend exit, when nobody holds the project:
// openProjectDatabase refuses while a backend still holds it.
function snapshot(dataDir: string, projectId: string) {
  const db = openProjectDatabase(projectDirFor(dataDir, projectId));
  try {
    return {
      resources: db.prepare('SELECT * FROM project_lut_resources ORDER BY id').all(),
      receipts: db.prepare('SELECT * FROM lut_import_requests ORDER BY requestId').all(),
    };
  } finally { db.close(); }
}

interface RendererSessionOptions {userData: string; dataDir: string; projectId: string; backend: {url: string; pid: number | undefined; close: () => Promise<void>; client: BackendClient}; fault?: unknown}
interface BackendClient {rpc(operation: string, input?: unknown): Promise<Record<string, unknown>>}
function rendererSession({ userData, dataDir, projectId, backend, fault }: RendererSessionOptions) {
  let alive = true;
  const workspaceScope = scope(dataDir), instanceId = randomUUID();
  const calls: Array<Record<string, unknown>> = [], replies: unknown[] = [], edits: unknown[] = [], writes: unknown[] = [];
  let dispatchedImports = 0, generatedIds = 0;
  const event = { url: backend.url, partition: randomUUID() };
  const host = createDesktopLutRecoveryHost({
    ownerForEvent: (input: unknown) => input === event ? { projectId, isCurrent: () => alive } : null,
    currentWorkspaceScope: () => { assert.ok(alive); return scope(dataDir); },
    createStore: (guard: () => void) => {
      const store = createDesktopLutRecoveryStore({ userData, storage: storage as unknown as Parameters<typeof createDesktopLutRecoveryStore>[0]['storage'], guard });
      return { read: (identity: unknown) => store.read(identity as never), verify: (value: unknown) => store.verify(value as never),
        reserve: (value: unknown) => { writes.push('reserve'); store.reserve(value as never); },
        complete: (value: unknown) => { writes.push('complete'); store.complete(value as never); } };
    },
  } as unknown as Parameters<typeof createDesktopLutRecoveryHost>[0]);
  const bridge = createDesktopLutRecoveryBridge({ invoke: (_channel: string, input: unknown) => host.dispatch(event, input) } as unknown as Parameters<typeof createDesktopLutRecoveryBridge>[0]);
  const recovery = createDesktopOrBrowserLutRecovery({ __mioonDesktop: true, __mioonLutRecovery: bridge });
  const assetId = randomUUID(), timelineId = randomUUID(), clipId = randomUUID(), assetSha256 = 'a'.repeat(64);
  const controller = createClipLutController({
    getContext: () => ({ scope: 'synthetic-project', projectId, timelineId, clipId, assetId, assetSha256, blocked: false }),
    imports: new Map(), recovery, newRequestId: () => { generatedIds++; return randomUUID(); },
    // Clip/source UI fixtures are synthetic. Trusted host scope above comes
    // from the actual private backend directory and database stat identities.
    readWorkspace: async key => ({ supported: true, workspaceScope, instanceId, key, revision: 0, targetStatus: 'matching', draft: null }),
    rpc: async (operation, input) => {
      if (operation === 'timeline.colour.source.inspect') return { projectId, assetId, assetSha256,
        streamIndex: 0, evidence: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'limited', pixelFormat: 'yuv420p', bitDepth: 8, hdrMetadata: false }, status: 'compatible', reason: null };
      if (operation === 'lut.import') {
        calls.push(structuredClone(input));
        if (fault === 'before-dispatch') throw Error('Synthetic transport failure before RPC dispatch');
        dispatchedImports++;
        const reply = await backend.client.rpc(operation, input);
        replies.push(reply);
        if (fault === 'lost-ack') throw Error('Backend committed; deliberately discard ACK before controller receives it');
        return reply;
      }
      assert.equal(operation, 'lut.list', 'No unexpected domain mutations');
      return backend.client.rpc(operation, input);
    }, edit: value => edits.push(value),
  });
  return { controller, workspaceScope, event, calls, replies, edits, writes,
    get dispatchedImports() { return dispatchedImports; }, get generatedIds() { return generatedIds; },
    close() { alive = false; controller.dispose(); } };
}

for (const fault of ['lost-ack', 'before-dispatch']) {
  test(`desktop recovery after independent backend process restart: ${fault === 'lost-ack' ? 'committed receipt survives lost ACK and replays without duplication' : 'uncommitted transport failure creates exactly one resource and receipt on retry'}`, { timeout: 60000 }, async t => {
    const root = mkdtempSync(path.join(tmpdir(), 'mioon-lut-restart-'));
    const dataDir = path.join(root, 'data'), userData = path.join(root, 'synthetic-user-data');
    mkdirSync(userData, { mode: 0o700 });
    // The finally block below closes both backends before this cleanup hook.
    t.after(() => rmSync(root, { recursive: true, force: true }));
    let firstBackend: Awaited<ReturnType<typeof startBackend>> | undefined, secondBackend: Awaited<ReturnType<typeof startBackend>> | undefined;
    try {
      firstBackend = await startBackend(t, dataDir);
      const project = await firstBackend.client.rpc('project.create', { name: 'Synthetic restart recovery' }) as {id: string};
      const first = rendererSession({ userData, dataDir, projectId: project.id, backend: firstBackend, fault });
      t.after(() => first.close());
      await verifyBackendScope(firstBackend, project.id, first.workspaceScope);
      first.controller.open();
      await first.controller.checkRecovery();
      assert.equal(await first.controller.importFile(file()), false);
      assert.equal(first.controller.getState().importRecord!.phase, 'unknown');
      assert.equal(first.calls.length, 1);
      assert.equal(first.dispatchedImports, fault === 'lost-ack' ? 1 : 0);
      const original = first.calls[0], originalReply = first.replies[0];
      const pendingPath = path.join(userData, 'lut-import-pending-v1.json');
      const pending = readFileSync(pendingPath, 'utf8');
      const pendingInode = statSync(pendingPath).ino;
      assert.ok(!pending.includes(String(original.dataBase64)));
      assert.equal(JSON.parse(pending).records[0].requestId, original.requestId);
      assert.deepEqual(first.edits, []);
      first.close();
      await firstBackend.close();
      const before = snapshot(dataDir, project.id);
      assert.equal(before.resources.length, fault === 'lost-ack' ? 1 : 0);
      assert.equal(before.receipts.length, fault === 'lost-ack' ? 1 : 0);
      if (originalReply) assert.equal(before.resources[0]?.id, (originalReply as {resource: {id: string}}).resource.id);

      secondBackend = await startBackend(t, dataDir);
      assert.notEqual(secondBackend.pid, firstBackend.pid, 'A genuinely new backend process');
      const second = rendererSession({ userData, dataDir, projectId: project.id, backend: secondBackend });
      t.after(() => second.close());
      assert.equal(second.workspaceScope, first.workspaceScope);
      await verifyBackendScope(secondBackend, project.id, second.workspaceScope);
      assert.notEqual(second.event.partition, first.event.partition);
      second.controller.open();
      await second.controller.checkRecovery();
      assert.equal(second.controller.getState().recovery!.requestId, original.requestId);
      assert.equal(await second.controller.retryImport(), false, 'Metadata alone is not authority to retry');
      assert.equal(await second.controller.reselectImportFile(new File([cube.replace('0 0 0', '0 0 1')], 'restart.cube')), false);
      assert.equal(await second.controller.reselectImportFile(file()), true);
      assert.deepEqual(second.calls, []);
      assert.deepEqual(second.writes, []);
      assert.equal(readFileSync(pendingPath, 'utf8'), pending);
      assert.equal(statSync(pendingPath).ino, pendingInode);
      assert.equal(await second.controller.retryImport(), true);
      assert.deepEqual(second.calls, [original], 'Exact original request, including bytes and requestId');
      assert.equal(second.generatedIds, 0);
      assert.equal(second.dispatchedImports, 1);
      if (originalReply) assert.deepEqual(second.replies[0], originalReply, 'Original committed receipt response, not a replacement');
      assert.deepEqual(second.writes, ['complete']);
      assert.deepEqual(JSON.parse(readFileSync(pendingPath, 'utf8')).records, []);
      assert.deepEqual(second.edits, []);
      assert.deepEqual(((await secondBackend.client.rpc('lut.list', { projectId: project.id })) as {items: unknown[]}).items, [(second.replies[0] as {resource: unknown}).resource]);
      assert.deepEqual(await secondBackend.client.rpc('asset.list', { projectId: project.id }), []);
      second.close();
      await secondBackend.close();
      const after = snapshot(dataDir, project.id);
      assert.equal(after.resources.length, 1);
      assert.equal(after.receipts.length, 1);
      assert.equal(after.receipts[0].requestId, original.requestId);
      assert.equal(after.resources[0]?.id, (second.replies[0] as {resource: {id: string}}).resource.id);
      if (fault === 'lost-ack') assert.deepEqual(after, before, 'Persisted resource and receipt rows remain byte-for-byte unchanged');
    } finally {
      await secondBackend?.close();
      await firstBackend?.close();
    }
  });
}
