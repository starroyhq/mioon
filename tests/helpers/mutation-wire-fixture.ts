import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {installWireGuard} from './inspection-wire-fixture.ts';
import type {InspectProject} from '../../apps/server/src/index.ts';

export const TOKEN = 'mutation-wire-synthetic-backend-token';
export const NOW = '2026-01-02T03:04:05.000Z';
export const uuid = (value: number|string): string => `10000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
export const IDS = Object.freeze({project: uuid(1), other: uuid(2), shot: uuid(10), spare: uuid(11),
  otherShot: uuid(12), node: uuid(20), otherNode: uuid(21), asset: uuid(30), otherAsset: uuid(31),
  job: uuid(40), secondJob: uuid(41), otherJob: uuid(42), version: uuid(50), secondVersion: uuid(51),
  otherVersion: uuid(52), timeline: uuid(60)});

export async function seedMutationStore(root: string): Promise<void> {
  // Keep business imports inside the seed: CLI/MCP preload this module to
  // install their guard before any production module is loaded.
  const {createServerProject} = await import('./project-database.ts');
  for (const projectId of [IDS.project, IDS.other]) {
    const {store} = createServerProject(root, {name: `Synthetic mutation project ${projectId}`, projectId});
    try {
      const {put, db} = store;
      const shot = (id: string, projectId: string, orderIndex: number): Record<string, unknown> => ({id, projectId, title: 'Synthetic saved shot', prompt: 'Saved prompt',
        referenceAssetIds: [], aspectRatio: '9:16', duration: 2, parameters: {}, position: {x: 0, y: 0}, orderIndex,
        revision: 1, selectedVersionId: null, createdAt: NOW, updatedAt: NOW});
      if (projectId === IDS.project) {
        put('shots', shot(IDS.shot, projectId, 0)); put('shots', shot(IDS.spare, projectId, 1));
      } else put('shots', shot(IDS.otherShot, projectId, 0));
      put('nodes', {id: projectId === IDS.project ? IDS.node : IDS.otherNode,
        projectId, type: 'text', label: 'Saved node', text: 'Saved text', position: {x: 5, y: 8}, revision: 1, createdAt: NOW});
      put('assets', {id: projectId === IDS.project ? IDS.asset : IDS.otherAsset,
        projectId, name: 'Synthetic metadata only', mimeType: 'video/mp4', width: 720, height: 1280, duration: 2,
        hasVideo: true, hasAudio: false, provenance: 'generated', createdAt: NOW, sha256: '1'.repeat(64)});
      for (const [id, versionId, shotId, assetId, number] of projectId === IDS.project ? [
        [IDS.job, IDS.version, IDS.shot, IDS.asset, 1],
        [IDS.secondJob, IDS.secondVersion, IDS.shot, IDS.asset, 2],
      ] as const : [
        [IDS.otherJob, IDS.otherVersion, IDS.otherShot, IDS.otherAsset, 1],
      ] as const) {
        put('jobs', {id, projectId, shotId, versionId, providerId: 'mock', model: 'synthetic', status: 'succeeded',
          phase: 'complete', progress: 100, revision: 1, createdAt: NOW, updatedAt: NOW});
        put('versions', {id: versionId, projectId, shotId, jobId: id, assetId, number,
          providerId: 'mock', model: 'synthetic', isMock: true, createdAt: NOW, sha256: '1'.repeat(64)});
      }
      if (projectId === IDS.project) {
        put('timelines', {id: IDS.timeline, projectId: IDS.project, revision: 4, fps: 30, width: 720, height: 1280,
          durationFrames: 0, tracks: [], clips: [], createdAt: NOW, updatedAt: NOW});
        // Nonempty older journals establish that this additive feature does not
        // rewrite previous responses or invent timeline/history activity.
        db.prepare('INSERT INTO timeline_requests VALUES(?,?,?)').run('mutation-preserved-timeline', 'preserved-hash', '{"preserved":"timeline"}');
        db.prepare('INSERT INTO reference_requests VALUES(?,?,?)').run('mutation-preserved-reference', 'preserved-hash', '{"preserved":"reference"}');
        db.prepare('INSERT INTO idempotency VALUES(?,?,?,?)').run('generation', 'mutation-preserved-generation', 'preserved-hash', IDS.job);
        db.prepare('INSERT INTO timeline_history VALUES(?,?,?,?,?,?,?)').run(uuid(61), IDS.project, 1, 'timeline.track.add', NOW, '{"preserved":"before"}', '{"preserved":"after"}');
        db.prepare('INSERT INTO timeline_history_cursors VALUES(?,?)').run(IDS.project, 1);
        db.prepare('INSERT INTO job_events(jobId,event,createdAt) VALUES(?,?,?)').run(IDS.job, '{"preserved":"event"}', NOW);
        db.prepare('INSERT INTO workspace_preferences VALUES(?,?,?)').run(IDS.project, 1, '{"preserved":"workspace"}');
      }
    } finally { store.close(); }
  }
}

if (process.env.MIOON_MUTATION_WIRE_GUARD === '1') installWireGuard({
  origin: process.env.MIOON_MUTATION_WIRE_ALLOWED_ORIGIN || '', auditPath: process.env.MIOON_MUTATION_WIRE_AUDIT,
});

const direct = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (direct) {
  const root = process.env.MIOON_DATA_DIR;
  if (!root) throw Error('A disposable fixture data directory is required');
  const dataRoot: string = root;
  const mode = process.argv[2];
  if (mode === 'seed') await seedMutationStore(dataRoot);
  if (mode === 'delete-node') {
    // Test-only storage corruption/removal, after stopping the owned server:
    // retained receipts must never become a way to read a removed target.
    const {openStore} = await import('../../packages/business/src/db.ts');
    const store = openStore(dataRoot);
    try {
      const result = store.db.prepare('DELETE FROM nodes WHERE id=?').run(process.env.MIOON_MUTATION_WIRE_NODE_ID as never);
      process.stdout.write(JSON.stringify({deleted: result.changes}) + '\n');
    } finally { store.close(); }
  }
  if (mode === 'server') {
    if (!fs.existsSync(path.join(dataRoot, 'workbench.sqlite'))) await seedMutationStore(dataRoot);
    const {startServer} = await import('../../apps/server/src/index.ts');
    const {readProjectState, changeMarks} = await import('./project-state.ts');
    let inspect: InspectProject|undefined;
    const server = await startServer({dataDir: dataRoot, port: Number(process.env.PORT || 0), token: TOKEN,
      inspectProject: received => { inspect = received; }});
    // The parent asks the running server to read on its own connection.
    if (process.connected) process.on('message', (raw: unknown) => {
      const message = raw as {type?: unknown; id?: unknown; projectId?: unknown}|null;
      if (typeof message?.id !== 'string') return;
      let reply: unknown;
      try {
        if (message.type !== 'storage') throw Error('Unsupported mutation fixture message');
        if (!inspect) throw Error('The server has not handed over its connection');
        const data = inspect(String(message.projectId), db => ({rows: readProjectState(db).tables, version: changeMarks(db)}));
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
  if (mode === 'writer') {
    const {openStore} = await import('../../packages/business/src/db.ts');
    const {createServices} = await import('../../packages/business/src/services.ts');
    const {readProjectState} = await import('./project-state.ts');
    // This explicit, isolated test child alone bypasses the backend owner lock
    // to exercise SQLite's real cross-process BEGIN IMMEDIATE serialization.
    const competing = process.env.MIOON_MUTATION_WIRE_COMPETING_WRITER === '1';
    const store = openStore(dataRoot, {lock: !competing});
    const boundary = process.env.MIOON_MUTATION_WIRE_BOUNDARY || '';
    const role = process.env.MIOON_MUTATION_WIRE_ROLE || '';
    const request = JSON.parse(process.env.MIOON_MUTATION_WIRE_REQUEST as string) as {operation: string; input: Record<string, unknown>};
    const report = (value: unknown): void => { process.stdout.write(JSON.stringify(value) + '\n'); };
    const receipt = (value: unknown): void => { fs.writeFileSync(path.join(dataRoot, `receipt-${boundary}.json`), JSON.stringify(value)); };
    const nativeTx = store.tx;
    const nativeExec = store.db.exec.bind(store.db);
    if (role) store.db.exec = (sql: string): void => {
      if (/^BEGIN IMMEDIATE\s*;?$/i.test(sql.trim())) report({event: 'begin-attempt', pid: process.pid});
      const result = nativeExec(sql);
      if (/^BEGIN IMMEDIATE\s*;?$/i.test(sql.trim()) && role === 'holder') {
        report({event: 'holding-transaction', pid: process.pid});
        const deadline = Date.now() + 5_000;
        while (!fs.existsSync(path.join(root, 'release-writer'))) {
          if (Date.now() >= deadline) throw Error('Parent did not release owned transaction within five seconds');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
      }
      return result;
    };
    if (boundary) store.tx = <T>(fn: ()=>T): T => {
      const result = nativeTx(() => {
        const value = fn();
        if (boundary === 'rollback' || boundary === 'crash-before-commit') {
          receipt({request, result: value, uncommitted: readProjectState(store.db).tables});
          if (boundary === 'rollback') throw Error('Synthetic failure after journal and business writes, before commit');
          process.kill(process.pid, 'SIGKILL');
        }
        return value;
      });
      if (boundary === 'crash-after-commit') {
        receipt({request, result, committed: readProjectState(store.db).tables});
        process.kill(process.pid, 'SIGKILL');
      }
      return result;
    };
    const services = createServices(store, new Map());
    const run = async () => {
      try { report({event: 'result', ok: true, data: await services.call(request.operation, request.input)}); }
      catch (error) { const failure=error as {code?: string; message?: string}; report({event: 'result', ok: false, error: {code: failure.code || 'FIXTURE_FAILURE', message: failure.message ?? String(error)}}); }
      finally { store.close(); if (process.connected) process.disconnect(); }
    };
    if (process.connected) {
      process.once('message', (message: unknown) => { if (message === 'go') void run(); });
      report({event: 'ready', pid: process.pid});
    } else await run();
  }
}
