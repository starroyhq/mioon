import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {IDS, NOW, TOKEN, seedMutationStore, uuid} from './mutation-wire-fixture.mjs';
import {installWireGuard} from './inspection-wire-fixture.mjs';

export const RANGE_IDS = Object.freeze({audio: uuid(80), long: uuid(81), boundary: uuid(82), image: uuid(83),
  unknown: uuid(84), corruptProject: uuid(85), mismatchedOwner: uuid(86), mismatchedId: uuid(87), missing: uuid(9999)});
export const PRIVATE = 'SOURCE_RANGE_PRIVATE_FIXTURE_MARKER';

async function seed(root) {
  await seedMutationStore(root);
  const {openStore} = await import('../../packages/business/src/db.mjs');
  const store = openStore(root);
  try {
    // The shared mutation fixture's zero-track timeline is an intentionally
    // opaque preservation sentinel, not a service-produced aggregate. This
    // scenario later edits the timeline, so give it the three default tracks
    // produced by timeline.get; leave the shared fixture/journal sentinels alone.
    store.put('timelines', {...store.get('timelines', IDS.timeline),
      tracks: [['video', 'Video 1'], ['video', 'Video 2'], ['audio', 'Audio 1']].map(([kind, name], orderIndex) =>
        ({id: uuid(88 + orderIndex), name, kind, orderIndex, hidden: false, muted: false}))});
    // The mutation fixture intentionally shares one asset across two versions.
    // Inspection rejects that ambiguous reverse relation, so this wire seed
    // keeps only the single generated version needed by the range scenario.
    store.db.prepare('DELETE FROM versions WHERE id=?').run(IDS.secondVersion);
    store.db.prepare('DELETE FROM jobs WHERE id=?').run(IDS.secondJob);
    const asset = (id, extra = {}) => ({id, projectId: IDS.project, name: 'Metadata-only range fixture',
      mimeType: 'video/mp4', duration: 2, width: 720, height: 1280, hasVideo: true, hasAudio: false,
      provenance: 'user-import', sha256: '2'.repeat(64), createdAt: NOW, ...extra});
    store.put('assets', asset(RANGE_IDS.audio, {mimeType: 'audio/wav', duration: 2.019, hasVideo: false, hasAudio: true}));
    store.put('assets', asset(RANGE_IDS.long, {duration: 1200}));
    store.put('assets', asset(RANGE_IDS.boundary, {duration: (61 - 1e-10) / 30}));
    store.put('assets', asset(RANGE_IDS.image, {mimeType: 'image/png', duration: 2}));
    store.put('assets', asset(RANGE_IDS.unknown, {duration: undefined}));
    store.put('projects', {id: RANGE_IDS.corruptProject, name: PRIVATE, description: '', revision: 1,
      createdAt: NOW, updatedAt: NOW});
    for (const id of [RANGE_IDS.mismatchedOwner, RANGE_IDS.mismatchedId]) {
      store.put('assets', asset(id, {projectId: RANGE_IDS.corruptProject, name: PRIVATE,
        relativePath: `media/${PRIVATE}.mp4`, url: `https://private.invalid/${PRIVATE}`}));
    }
    store.db.prepare('UPDATE assets SET data=json_set(data,\'$.projectId\',?) WHERE id=?').run(IDS.other, RANGE_IDS.mismatchedOwner);
    store.db.prepare('UPDATE assets SET data=json_set(data,\'$.id\',?) WHERE id=?').run(IDS.otherAsset, RANGE_IDS.mismatchedId);
  } finally { store.close(); }
}

// Imported before production modules in every server, CLI and MCP child. The
// only allowed outbound connection is the exact disposable backend endpoint.
if (process.env.MIOON_RANGE_WIRE_GUARD === '1') installWireGuard({
  origin: process.env.MIOON_RANGE_WIRE_ALLOWED_ORIGIN || '', auditPath: process.env.MIOON_RANGE_WIRE_AUDIT,
});

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.env.MIOON_DATA_DIR;
  if (!root || process.argv[2] !== 'server') throw Error('An isolated range-wire server fixture is required');
  if (!fs.existsSync(path.join(root, 'workbench.sqlite'))) await seed(root);
  const {startServer} = await import('../../apps/server/src/index.mjs');
  const server = await startServer({dataDir: root, port: Number(process.env.PORT || 0), token: TOKEN,
    chatGateway: async function* () {
      fs.appendFileSync(process.env.MIOON_RANGE_WIRE_AUDIT, '{"kind":"model gateway"}\n');
      throw Error('Source ranges must never enter the model gateway');
    }});
  process.stdout.write(JSON.stringify({ready: true, url: server.url, pid: process.pid}) + '\n');
  let closing;
  const close = () => closing ??= server.close().catch(() => { process.exitCode = 1; });
  process.on('SIGTERM', close); process.on('SIGINT', close);
}
