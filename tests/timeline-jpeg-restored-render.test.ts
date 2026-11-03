import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createServerProject,openServerProject} from './helpers/project-database.ts';
import {validateProjectRetainedRows} from '../packages/business/src/project-retained-validation.ts';
import {createServices} from '../packages/business/src/services.ts';
import {startWorker} from '../packages/business/src/jobs.ts';
import {run, runStreaming} from '../packages/business/src/media-runtime.ts';
import {probe} from '../packages/business/src/media.ts';
import {timelineColourInputFilter} from '../packages/business/src/timeline-colour-lut.ts';
import {greyJfif,jpegColour} from './helpers/timeline-jpeg-workflow-fixtures.ts';
import {png, sha, imageColour, stamp} from './helpers/timeline-image-fixtures.ts';
import type {DatabaseSync} from 'node:sqlite';
interface ExportRowView {id: string; requestId: string; snapshot: Record<string, unknown>; assetId: string; status?: string; [key: string]: unknown}
interface AssetRowView {id: string; relativePath: string; sha256: string; [key: string]: unknown}
interface RenderResultView {id: string; requestId: string; snapshot: {colourPlan: {profileId?: string}; [key: string]: unknown}; [key: string]: unknown}
interface TimelineRowView {id: string; projectId: string; revision: number; tracks: {id: string; kind?: string; [key: string]: unknown}[]; clips: {id: string; trackId: string; assetId: string; startFrame: number; durationFrames: number; [key: string]: unknown}[]; [key: string]: unknown}
interface ExecuteResult {completed: ExportRowView; persisted: unknown; asset: AssetRowView; file: string}
const rowsOf = (db: DatabaseSync, table: string): Record<string, unknown>[] => db.prepare(`SELECT rowid AS retainedRowid, * FROM ${table} ORDER BY rowid`).all() as Record<string, unknown>[];

const retainedTables = ['projects', 'assets', 'timelines', 'timeline_history',
  'timeline_history_cursors', 'timeline_requests', 'exports', 'project_lut_resources', 'lut_import_requests'];
const rawRows = (db: DatabaseSync): Record<string, Record<string, unknown>[]> => Object.fromEntries(retainedTables.map((table: string) => [table, rowsOf(db, table)]));

function assertRetainedRows(db: DatabaseSync, captured: Record<string, Record<string, unknown>[]>): void {
  for (const [table, rows] of Object.entries(captured)) {
    for (const row of rows) {
      assert.deepEqual(db.prepare(`SELECT rowid AS retainedRowid, * FROM ${table} WHERE rowid=?`)
        .get(row.retainedRowid as never), row, `${table}: exact captured row ${row.retainedRowid}`);
    }
  }
}

async function assertSourceBytes(root: string, files: Map<string, Uint8Array>): Promise<void> {
  for (const [relativePath, bytes] of files) {
    assert.deepEqual(await readFile(path.join(root, relativePath)), bytes, relativePath);
  }
}

async function executeQueued(store: ReturnType<typeof openServerProject>, services: ReturnType<typeof createServices>, accepted: RenderResultView): Promise<ExecuteResult> {
  // The real local worker owns preparation, rendering, verification and publication.
  // No server, desktop runtime, provider or synthetic renderer is started.
  const worker = startWorker(store, services, new Map());
  try {
    await worker.tick();
    const completed = await services.call('export.get', {exportId: accepted.id}) as ExportRowView;
    assert.equal(completed.status, 'succeeded', JSON.stringify(completed['error']));
    assert.deepEqual(completed.snapshot, accepted.snapshot);
    const asset = store.get('assets', completed.assetId) as AssetRowView;
    const file = path.join(store.root, asset.relativePath);
    assert.equal(sha(await readFile(file)), asset.sha256);
    return {completed, persisted: store.get('exports', completed.id), asset, file};
  } finally {
    await worker.stop();
  }
}

async function decoded(file: string): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  await runStreaming('ffmpeg', ['-v', 'error', '-threads', '1', '-i', file,
    '-vf', `${timelineColourInputFilter('limited')},format=rgb24`, '-an',
    '-fps_mode', 'passthrough', '-threads', '1', '-f', 'rawvideo', 'pipe:1'], {
    timeout: 20000, maxStdoutBytes: 16 * 1024 * 1024,
    onStdout: (chunk: Uint8Array) => { chunks.push(Buffer.from(chunk)); },
  });
  return Buffer.concat(chunks);
}

function assertMixedPixels(bytes: Buffer): void {
  assert.equal(bytes.length, 6 * 720 * 720 * 3);
  const pixel = (frame: number, x: number, y: number): number[] => {
    const start = (frame * 720 * 720 + y * 720 + x) * 3;
    return [...bytes.subarray(start, start + 3)];
  };
  const expected = .527924914041446 * 255;
  assert.ok(pixel(0,300,350).every(v=>Math.abs(v-expected)<4),'JPEG actual decoded grey follows display transform');
  assert.ok(pixel(0,185,185).every(v=>v<4),'JPEG contain padding stays transparent');
  const mixed=pixel(0,450,450), alpha=128/255;
  for(let c=0;c<3;c++)assert.ok(Math.abs(mixed[c]-(c===2?255*alpha:0)-expected*(1-alpha))<5,`PNG over JPEG channel ${c}: ${mixed}`);
  for (let frame = 0; frame < 6; frame++) {
    let white = 0;
    for (let y = 552; y < 672; y++) for (let x = 48; x < 672; x++) {
      if (pixel(frame, x, y).every(v => v > 220)) white++;
    }
    if (frame === 2 || frame === 3) assert.ok(white > 200, `subtitle present on frame ${frame}`);
    else assert.equal(white, 0, `subtitle absent on frame ${frame}`);
  }
}

test('cold current kernel reopen rerenders mixed JFIF/PNG/video/subtitle with exact decoded parity and retained LUT reads',
  {timeout: 120000}, async t => {
    const base = await mkdtemp(path.join(tmpdir(), 'mioon-image-restored-render-'));
    const dataDir=path.join(base,'application'),videoFile=path.join(base,'video.mp4');
    let source!:string,restored!:string;
    let store: ReturnType<typeof openServerProject> | undefined, services: ReturnType<typeof createServices> | undefined;
    const close = async () => {
      await services?.drain();
      services = undefined;
      if (store?.db.isOpen) store.close();
      store = undefined;
    };
    t.after(async () => { await close(); await rm(base, {recursive: true, force: true}); });
    t.mock.method(globalThis, 'fetch', () => { throw Error('Network is forbidden in this local kernel reopen test'); });

    await run('ffmpeg', ['-v', 'error', '-threads', '1', '-f', 'lavfi', '-i',
      'color=black:s=64x64:r=30', '-frames:v', '6', '-an', '-c:v', 'libx264',
      '-preset', 'ultrafast', '-threads', '1', '-pix_fmt', 'yuv420p',
      '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
      '-color_range', 'tv', '-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709',
      videoFile], {timeout: 15000});
    const videoBytes = await readFile(videoFile);
    const imageBytes = greyJfif();
    const overlayBytes = png({width:8,height:8,pixel:()=>[0,0,255,128]});

    const created=createServerProject(dataDir,{name:'Cold mixed SDR rerender'});
    store=created.store;source=store.root;restored=source;
    services=createServices(store,new Map());
    const project=store.get('projects',created.projectId)! as {id:string;revision:number};
    const projectId=created.projectId;
    let timeline = await services.call('timeline.format.set', {projectId,
      expectedProjectRevision: project.revision, expectedRevision: 0,
      requestId: randomUUID(), presetId: 'square_720'}) as TimelineRowView;
    const video = await services.call('asset.import', {projectId, name: 'Video.mp4',
      mimeType: 'video/mp4', dataBase64: videoBytes.toString('base64')}) as AssetRowView;
    const image = await services.call('asset.import', {projectId, name: 'Still.jpg',
      mimeType: 'image/jpeg', dataBase64: imageBytes.toString('base64')}) as AssetRowView;
    const motion = await services.call('timeline.colour.source.inspect', {projectId, assetId: video.id}) as {status: string; streamIndex: number; evidence: {range?: string}};
    const picture = await services.call('timeline.colour.jpeg.inspect', {projectId, assetId: image.id}) as {status: string; evidence: Record<string, unknown>};
    assert.equal(motion.status, 'compatible');
    assert.equal(motion.evidence.range, 'limited');
    assert.equal(picture.status, 'needs_interpretation');
    const overlay=await services.call('asset.import',{projectId,name:'Overlay.png',mimeType:'image/png',dataBase64:overlayBytes.toString('base64')}) as AssetRowView;
    const overlayInspection=await services.call('timeline.colour.image.inspect',{projectId,assetId:overlay.id}) as {evidence: Record<string, unknown>};
    const cube=Buffer.from('LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n');
    const lut=await services.call('lut.import',{projectId,requestId:randomUUID(),name:'Retained.cube',dataBase64:cube.toString('base64')}) as {resource: {id: string}};
    const params = (extra: Record<string, unknown>): Record<string, unknown> => ({projectId, expectedRevision: timeline.revision, requestId: randomUUID(), ...extra});
    const videoColour = {profileId: 'mioon-rec709-sdr-clip-v1', source: {
      assetSha256: video.sha256, streamIndex: motion.streamIndex, profileId: 'rec709-yuv-sdr-v1',
      range: 'limited', declaredBy: 'user', declaredAt: stamp}, look: null};
    timeline = await services.call('timeline.clip.add', params({assetId: video.id,
      trackId: timeline.tracks[0]?.id, startFrame: 0, durationFrames: 6, colour: videoColour})) as TimelineRowView;
    timeline = await services.call('timeline.clip.add', params({assetId: image.id,
      trackId: timeline.tracks[1]?.id, startFrame: 0, durationFrames: 6,
      rect: {x: 180, y: 180, width: 360, height: 360}, colour: jpegColour(picture.evidence as never)})) as TimelineRowView;
    timeline = await services.call('timeline.track.add',params({kind:'video',name:'PNG overlay'})) as TimelineRowView;
    timeline = await services.call('timeline.clip.add',params({assetId:overlay.id,trackId:timeline.tracks.at(-1)?.id,startFrame:0,durationFrames:6,rect:{x:360,y:360,width:180,height:180},colour:imageColour(overlayInspection.evidence as never)})) as TimelineRowView;
    timeline = await services.call('timeline.subtitle.add', params({text: 'Mixed SDR subtitle',
      startFrame: 2, durationFrames: 2})) as TimelineRowView;

    const ordinary = await services.call('timeline.render', params({purpose: 'export'})) as RenderResultView;
    assert.equal(ordinary.snapshot.colourPlan.profileId, 'mioon-mixed-sdr-render-v3');
    const baseline = await executeQueued(store, services, ordinary);
    const ordinaryRgb = await decoded(baseline.file);
    assertMixedPixels(ordinaryRgb);
    // A completed ordinary receipt and its immutable snapshot survive a cold
    // kernel reopen. Restore-only queued holds are no longer a runtime concept.
    const held=baseline.completed;
    assert.deepEqual(held.snapshot,ordinary.snapshot);
    const heldRecord=store.get('exports',held.id)!;
    const captured = rawRows(store.db);
    const sourceFiles = new Map([[String((store.get('assets', video.id) as AssetRowView).relativePath), videoBytes],
      [String((store.get('assets', image.id) as AssetRowView).relativePath), imageBytes],
      [String((store.get('assets', overlay.id) as AssetRowView).relativePath), overlayBytes],
      [baseline.asset.relativePath, await readFile(baseline.file)]]);
    await close();
    store=openServerProject(dataDir,projectId);
    services = createServices(store, new Map());
    assert.doesNotThrow(()=>validateProjectRetainedRows(store!));
    assertRetainedRows(store.db, captured);
    await assertSourceBytes(restored, sourceFiles);
    assert.deepEqual(await services.call('timeline.get', {projectId}), timeline);
    const listed=await services.call('lut.list',{projectId}) as {items: unknown[]};assert.equal(listed.items.length,1);
    const retainedLut=await services.call('lut.inspect',{projectId,lutId:lut.resource.id}) as {resource: unknown; integrity: string};assert.deepEqual(retainedLut.resource,lut.resource);assert.equal(retainedLut.integrity,'verified');
    const request = params({purpose: 'export'});
    assert.equal(store.db.prepare('SELECT 1 FROM timeline_requests WHERE requestId=?').get(request.requestId as string), undefined);
    const accepted = await services.call('timeline.render', request as never) as RenderResultView;
    assert.notEqual(accepted.id, held.id);
    assert.notEqual(accepted.requestId, held.requestId);
    assert.deepEqual(accepted.snapshot, held.snapshot);
    assert.deepEqual((store.get('exports', accepted.id) as ExportRowView).snapshot, heldRecord.snapshot);
    assert.doesNotThrow(()=>validateProjectRetainedRows(store!),'valid before actual rerender');

    const rerendered = await executeQueued(store, services, accepted);
    const restoredRgb = await decoded(rerendered.file);
    assert.deepEqual(restoredRgb, ordinaryRgb, 'decoded RGB is byte-identical after genuine cold kernel reopen');
    assertMixedPixels(restoredRgb);
    const probeResult = await probe(rerendered.file) as unknown as {probe: {streams: {codec_type?: string; width?: number; height?: number; nb_frames?: string | number; color_primaries?: string; color_transfer?: string; color_space?: string; color_range?: string}[]}};
    const stream = probeResult.probe.streams.find((s: {codec_type?: string}) => s.codec_type === 'video');assert.ok(stream);
    assert.equal(stream.width, 720);
    assert.equal(stream.height, 720);
    assert.equal(Number(stream.nb_frames), 6);
    for (const key of ['color_primaries', 'color_transfer', 'color_space'] as const) assert.equal(stream[key], 'bt709');
    assert.equal(stream.color_range, 'tv');
    assert.deepEqual(store.get('exports', held.id), heldRecord, 'prior completed export never changes');
    assertRetainedRows(store.db, captured);
    await assertSourceBytes(restored, sourceFiles);
    assert.doesNotThrow(()=>validateProjectRetainedRows(store!),'valid after actual rerender');
    assert.equal((await readdir(path.join(restored, 'media'))).some(name =>
      name.startsWith('.timeline-render-') || name.endsWith('.part.mp4')), false);

    await close();
    store = openServerProject(dataDir,projectId);
    assert.doesNotThrow(()=>validateProjectRetainedRows(store!),'valid after cold kernel reopen');
    assertRetainedRows(store.db, captured);
    assert.deepEqual(store.get('exports', rerendered.completed.id), rerendered.persisted);
    await assertSourceBytes(restored, sourceFiles);
    await assertSourceBytes(source, sourceFiles);
    t.diagnostic(`decoded RGB SHA-256: ${sha(restoredRgb)}; bytes: ${restoredRgb.length}; frames: 6; output: 720x720`);
    t.diagnostic(`ordinary MP4 SHA-256: ${baseline.asset.sha256}; restored MP4 SHA-256: ${rerendered.asset.sha256}`);
  });
