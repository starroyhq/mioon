import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {installWireGuard} from './inspection-wire-fixture.ts';

export const TOKEN = 'mutation-wire-synthetic-backend-token';
export const NOW = '2026-01-02T03:04:05.000Z';
export const uuid = value => `10000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
export const IDS = Object.freeze({project: uuid(1), other: uuid(2), shot: uuid(10), spare: uuid(11),
  otherShot: uuid(12), node: uuid(20), otherNode: uuid(21), asset: uuid(30), otherAsset: uuid(31),
  job: uuid(40), secondJob: uuid(41), otherJob: uuid(42), version: uuid(50), secondVersion: uuid(51),
  otherVersion: uuid(52), timeline: uuid(60)});

export function snapshot(db) {
  return Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all()
    .map(({name}) => [name, db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all().map(row => ({...row}))]));
}

export async function seedMutationStore(root) {
  const {openStore} = await import('../../packages/business/src/db.ts');
  const store = openStore(root), {put, db} = store;
  try {
    for (const id of [IDS.project, IDS.other]) put('projects', {id, name: `Synthetic mutation project ${id}`, description: '',
      revision: 1, createdAt: NOW, updatedAt: NOW});
    const shot = (id, projectId, orderIndex) => ({id, projectId, title: 'Synthetic saved shot', prompt: 'Saved prompt',
      referenceAssetIds: [], aspectRatio: '9:16', duration: 2, parameters: {}, position: {x: 0, y: 0}, orderIndex,
      revision: 1, selectedVersionId: null, createdAt: NOW, updatedAt: NOW});
    put('shots', shot(IDS.shot, IDS.project, 0)); put('shots', shot(IDS.spare, IDS.project, 1));
    put('shots', shot(IDS.otherShot, IDS.other, 0));
    for (const [id, projectId] of [[IDS.node, IDS.project], [IDS.otherNode, IDS.other]]) put('nodes', {
      id, projectId, type: 'text', label: 'Saved node', text: 'Saved text', position: {x: 5, y: 8}, revision: 1, createdAt: NOW});
    for (const [id, projectId] of [[IDS.asset, IDS.project], [IDS.otherAsset, IDS.other]]) put('assets', {
      id, projectId, name: 'Synthetic metadata only', mimeType: 'video/mp4', width: 720, height: 1280, duration: 2,
      hasVideo: true, hasAudio: false, provenance: 'generated', createdAt: NOW, sha256: '1'.repeat(64)});
    for (const [id, versionId, shotId, projectId, assetId, number] of [
      [IDS.job, IDS.version, IDS.shot, IDS.project, IDS.asset, 1],
      [IDS.secondJob, IDS.secondVersion, IDS.shot, IDS.project, IDS.asset, 2],
      [IDS.otherJob, IDS.otherVersion, IDS.otherShot, IDS.other, IDS.otherAsset, 1],
    ]) {
      put('jobs', {id, projectId, shotId, versionId, providerId: 'mock', model: 'synthetic', status: 'succeeded',
        phase: 'complete', progress: 100, revision: 1, createdAt: NOW, updatedAt: NOW});
      put('versions', {id: versionId, projectId, shotId, jobId: id, assetId, number,
        providerId: 'mock', model: 'synthetic', isMock: true, createdAt: NOW, sha256: '1'.repeat(64)});
    }
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
  } finally { store.close(); }
}

if (process.env.MIOON_MUTATION_WIRE_GUARD === '1') installWireGuard({
  origin: process.env.MIOON_MUTATION_WIRE_ALLOWED_ORIGIN || '', auditPath: process.env.MIOON_MUTATION_WIRE_AUDIT,
});

const direct = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (direct) {
  const root = process.env.MIOON_DATA_DIR;
  if (!root) throw Error('A disposable fixture data directory is required');
  const mode = process.argv[2];
  if (mode === 'seed') await seedMutationStore(root);
  if (mode === 'delete-node') {
    // Test-only storage corruption/removal, after stopping the owned server:
    // retained receipts must never become a way to read a removed target.
    const {openStore} = await import('../../packages/business/src/db.ts');
    const store = openStore(root);
    try {
      const result = store.db.prepare('DELETE FROM nodes WHERE id=?').run(process.env.MIOON_MUTATION_WIRE_NODE_ID);
      process.stdout.write(JSON.stringify({deleted: result.changes}) + '\n');
    } finally { store.close(); }
  }
  if (mode === 'server') {
    if (!fs.existsSync(path.join(root, 'workbench.sqlite'))) await seedMutationStore(root);
    const {startServer} = await import('../../apps/server/src/index.ts');
    const server = await startServer({dataDir: root, port: Number(process.env.PORT || 0), token: TOKEN,
      chatGateway: async function* () {
        fs.appendFileSync(process.env.MIOON_MUTATION_WIRE_AUDIT, '{"kind":"model gateway"}\n');
        throw Error('Mutation replay must not enter the model gateway');
      }});
    process.stdout.write(JSON.stringify({ready: true, url: server.url, pid: process.pid}) + '\n');
    let closing;
    const close = () => closing ??= server.close().catch(() => { process.exitCode = 1; });
    process.on('SIGTERM', close); process.on('SIGINT', close);
  }
  if (mode === 'writer') {
    const {openStore} = await import('../../packages/business/src/db.ts');
    const {createServices} = await import('../../packages/business/src/services.ts');
    // This explicit, isolated test child alone bypasses the backend owner lock
    // to exercise SQLite's real cross-process BEGIN IMMEDIATE serialization.
    const competing = process.env.MIOON_MUTATION_WIRE_COMPETING_WRITER === '1';
    const store = openStore(root, {lock: !competing});
    const boundary = process.env.MIOON_MUTATION_WIRE_BOUNDARY || '';
    const role = process.env.MIOON_MUTATION_WIRE_ROLE || '';
    const request = JSON.parse(process.env.MIOON_MUTATION_WIRE_REQUEST);
    const report = value => process.stdout.write(JSON.stringify(value) + '\n');
    const receipt = value => fs.writeFileSync(path.join(root, `receipt-${boundary}.json`), JSON.stringify(value));
    const nativeTx = store.tx;
    const nativeExec = store.db.exec.bind(store.db);
    if (role) store.db.exec = sql => {
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
    if (boundary) store.tx = fn => {
      const result = nativeTx(() => {
        const value = fn();
        if (boundary === 'rollback' || boundary === 'crash-before-commit') {
          receipt({request, result: value, uncommitted: snapshot(store.db)});
          if (boundary === 'rollback') throw Error('Synthetic failure after journal and business writes, before commit');
          process.kill(process.pid, 'SIGKILL');
        }
        return value;
      });
      if (boundary === 'crash-after-commit') {
        receipt({request, result, committed: snapshot(store.db)});
        process.kill(process.pid, 'SIGKILL');
      }
      return result;
    };
    const services = createServices(store, new Map());
    const run = async () => {
      try { report({event: 'result', ok: true, data: await services.call(request.operation, request.input)}); }
      catch (error) { report({event: 'result', ok: false, error: {code: error.code || 'FIXTURE_FAILURE', message: error.message}}); }
      finally { store.close(); if (process.connected) process.disconnect(); }
    };
    if (process.connected) {
      process.once('message', message => { if (message === 'go') void run(); });
      report({event: 'ready', pid: process.pid});
    } else await run();
  }
}
