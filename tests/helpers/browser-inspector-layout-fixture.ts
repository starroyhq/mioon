import {createTestSecretCodec, testSecretStorage, testServerSecretCodecs} from './secret-codec.ts';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {newVideoConnection} from '../../apps/web/src/video-settings.ts';
import {computeFullSha256, referenceForFile} from '../../packages/business/src/media-reference/index.ts';
import {listVideoConnections} from '../../packages/business/src/video/generation.ts';
import {createVideoSettingsV2} from '../../packages/business/src/video/settings-v2.ts';
import {projectMediaPath} from '../../packages/contracts/src/project-file.ts';
import {closeQaProject, createQaProject} from './kernel-qa-fixture.mjs';
import {startServer} from './test-server.ts';
import {png} from './timeline-image-fixtures.ts';

const [dataDir, distDir, token] = process.argv.slice(2);
if (!dataDir || !distDir || !token) throw new Error('Expected a temporary data directory, web build and fixture token');

const name = 'Inspector layout fixture';
const plainTitle = 'Synthetic text shot';
const tailTitle = 'Synthetic frame pair';
const fixture = await createQaProject(dataDir, {name, media: false});
async function createFrame(name: string, color: readonly number[]) {
  const {project, store} = fixture;
  const id = randomUUID(), file = path.join(store.projectDir, name);
  const access = {projectDir: store.projectDir, projectFile: store.projectFile, mayReadOutside: () => false};
  const width = 640, height = 360;
  await writeFile(file, png({width, height, rgba: false, pixel: () => color}), {mode: 0o600, flag: 'wx'});
  // Only the known synthetic PNGs bypass decoding; the app uses ordinary
  // project media references, so the browser can load their real previews.
  const sampled = await referenceForFile(access, file);
  const {reference} = await computeFullSha256(access, sampled.reference);
  store.put('assets', {
    id, projectId: project.id, name, mimeType: 'image/png', width, height,
    duration: 0, hasVideo: true, hasAudio: false, reference, referenceRevision: 1,
    sizeBytes: reference.sizeBytes, sha256: reference.fullSha256,
    provenance: 'user-import', url: projectMediaPath(project.id, id),
    createdAt: new Date().toISOString(),
  });
  return id;
}
let tailId: string;
try {
  const firstId = await createFrame('Synthetic first frame.png', [64, 105, 167]);
  tailId = await createFrame('Synthetic last frame.png', [177, 119, 70]);
  const shot = {projectId: fixture.project.id, prompt: 'Synthetic layout test.', duration: 4, aspectRatio: '16:9'};
  await fixture.services.call('shot.create', {...shot, title: plainTitle, requestId: randomUUID()});
  await fixture.services.call('shot.create', {...shot, title: tailTitle, requestId: randomUUID(), referenceAssetIds: [firstId], lastFrameAssetId: tailId});
} finally {
  await closeQaProject(fixture);
}

const settings = await createVideoSettingsV2({secretCodec:createTestSecretCodec(),storage:testSecretStorage,directory: path.join(dataDir, 'fixture-video-directory'), privateRoot: dataDir});
let connections: Awaited<ReturnType<typeof listVideoConnections>>;
try {
  const configuration = newVideoConnection('minimax');
  configuration.enabled = true;
  await settings.put({action: 'save', expectedRevision: 0, configuration, secret: {action: 'replace', storage: 'persistent', value: 'synthetic-only'}});
  connections = await listVideoConnections(settings, '2026-11-17');
} finally {
  await settings.close();
}

const server = await startServer({dataDir, port: 0, distDir, token, ...testServerSecretCodecs()});
process.once('SIGTERM', () => { void server.close(); });
await writeFile(path.join(dataDir, 'ready.json'), JSON.stringify({origin: server.url, name, plainTitle, tailTitle, tailId, connections}), {mode: 0o600, flag: 'wx'});
