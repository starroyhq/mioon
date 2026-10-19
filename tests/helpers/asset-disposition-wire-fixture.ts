import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {IDS, NOW, TOKEN, seedMutationStore, uuid} from './mutation-wire-fixture.ts';
import {installWireGuard} from './inspection-wire-fixture.ts';

export const DISPOSITION_IDS = Object.freeze({audio: uuid(180), image: uuid(181), unknown: uuid(182),
  batchProject: uuid(183), corruptProject: uuid(184), mismatchedOwner: uuid(185),
  mismatchedId: uuid(186), track: uuid(187), clip: uuid(188), missing: uuid(9999)});
export const BATCH_IDS = Object.freeze(Array.from({length: 100}, (_, index) => uuid(200 + index)));
export const PRIVATE = 'ASSET_DISPOSITION_PRIVATE_FIXTURE_MARKER';
// Deliberately not encoded media: these sentinel bytes only prove metadata edits
// leave original managed files untouched. No route probes, plays or renders it.
export const ORIGINAL_BYTES = Buffer.from('immutable original fixture bytes\n');

async function seed(root: string): Promise<void> {
  await seedMutationStore(root);
  const {openStore} = await import('../../packages/business/src/db.ts');
  const store = openStore(root);
  try {
    // Keep inspection's generated-version relationship unambiguous.
    store.db.prepare('DELETE FROM versions WHERE id=?').run(IDS.secondVersion);
    store.db.prepare('DELETE FROM jobs WHERE id=?').run(IDS.secondJob);
    const asset = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({id, projectId: IDS.project, name: 'Disposition metadata fixture',
      mimeType: 'video/mp4', duration: 2, width: 720, height: 1280, hasVideo: true, hasAudio: false,
      provenance: 'user-import', sha256: '2'.repeat(64), createdAt: NOW, ...extra});
    store.put('assets', asset(DISPOSITION_IDS.audio, {mimeType: 'audio/wav', hasVideo: false, hasAudio: true}));
    store.put('assets', asset(DISPOSITION_IDS.image, {mimeType: 'image/png', duration: 0}));
    store.put('assets', asset(DISPOSITION_IDS.unknown, {duration: undefined}));
    for (const id of [DISPOSITION_IDS.batchProject, DISPOSITION_IDS.corruptProject])
      store.put('projects', {id, name: 'Independent fixture project', description: '', revision: 1, createdAt: NOW, updatedAt: NOW});
    for (const id of BATCH_IDS) store.put('assets', asset(id, {projectId: DISPOSITION_IDS.batchProject}));
    for (const id of [DISPOSITION_IDS.mismatchedOwner, DISPOSITION_IDS.mismatchedId])
      store.put('assets', asset(id, {projectId: DISPOSITION_IDS.corruptProject, name: PRIVATE,
        relativePath: `media/${PRIVATE}.mp4`, url: `https://private.invalid/${PRIVATE}`}));
    store.db.prepare("UPDATE assets SET data=json_set(data,'$.projectId',?) WHERE id=?").run(IDS.other, DISPOSITION_IDS.mismatchedOwner);
    store.db.prepare("UPDATE assets SET data=json_set(data,'$.id',?) WHERE id=?").run(IDS.otherAsset, DISPOSITION_IDS.mismatchedId);
    const original = JSON.parse((store.db.prepare('SELECT data FROM assets WHERE id=?').get(IDS.asset) as {data: string}).data);
    store.put('assets', {...original, relativePath: 'media/original.mp4'});
    fs.writeFileSync(path.join(root, 'media/original.mp4'), ORIGINAL_BYTES);
    // An existing in-use clip must remain byte-for-byte identical when rejected.
    const timeline = JSON.parse((store.db.prepare('SELECT data FROM timelines WHERE id=?').get(IDS.timeline) as {data: string}).data);
    store.put('timelines', {...timeline, durationFrames: 30,
      tracks: [{id: DISPOSITION_IDS.track, name: 'Existing video', kind: 'video', orderIndex: 0, hidden: false, muted: false}],
      clips: [{id: DISPOSITION_IDS.clip, trackId: DISPOSITION_IDS.track, assetId: IDS.asset, name: 'Already in use',
        startFrame: 0, sourceInFrame: 3, durationFrames: 30, rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 1}],
    });
  } finally { store.close(); }
}

// This opt-in is set only by the owned CLI test child, not production config.
let phaseCount = 0;
const phaseTrace = process.env.MIOON_DISPOSITION_PHASE_TRACE === '1' ? (stage: string): void => {
  if (++phaseCount > 16 || !['preload-ready', 'fetch-start', 'fetch-headers', 'fetch-rejected'].includes(stage)) return;
  const {userCPUTime, systemCPUTime, maxRSS} = process.resourceUsage();
  process.stderr.write('MIOON_WIRE_PHASE ' + JSON.stringify({stage,
    uptimeMs: Math.round(process.uptime() * 1000), userCPUTime, systemCPUTime, maxRSS}) + '\n');
} : undefined;
phaseTrace?.('preload-ready');
if (process.env.MIOON_DISPOSITION_WIRE_GUARD === '1') installWireGuard({
  origin: process.env.MIOON_DISPOSITION_WIRE_ALLOWED_ORIGIN || '', auditPath: process.env.MIOON_DISPOSITION_WIRE_AUDIT, onFetchStage: phaseTrace,
});

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.env.MIOON_DATA_DIR;
  if (!root) throw Error('An isolated asset-disposition fixture is required');
  const dataRoot: string = root;
  if (process.argv[2] === 'move-asset') {
    // Only after the owned backend has stopped: retained receipts must not reveal
    // an asset whose current ownership no longer matches the original request.
    const {openStore} = await import('../../packages/business/src/db.ts');
    const store = openStore(dataRoot);
    try {
      const moved = store.db.prepare("UPDATE assets SET projectId=?,data=json_set(data,'$.projectId',?) WHERE id=?")
        .run(IDS.other, IDS.other, IDS.asset).changes;
      process.stdout.write(JSON.stringify({moved}) + '\n');
    } finally { store.close(); }
  } else if (process.argv[2] === 'server') {
    if (!fs.existsSync(path.join(dataRoot, 'workbench.sqlite'))) await seed(dataRoot);
    const {startServer} = await import('../../apps/server/src/index.ts');
    const server = await startServer({dataDir: dataRoot, port: Number(process.env.PORT || 0), token: TOKEN,
      chatGateway: async function* () {
        fs.appendFileSync(process.env.MIOON_DISPOSITION_WIRE_AUDIT ?? '', '{"kind":"model gateway"}\n');
        throw Error('Asset dispositions must never enter the model gateway');
      }});
    process.stdout.write(JSON.stringify({ready: true, url: server.url, pid: process.pid}) + '\n');
    let closing: Promise<unknown>|undefined;
    const close = (): Promise<unknown> => closing ??= server.close().catch(() => { process.exitCode = 1; });
    process.on('SIGTERM', close); process.on('SIGINT', close);
  } else throw Error('Unknown asset-disposition fixture mode');
}
