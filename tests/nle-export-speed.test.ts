import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import test from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {openAppLibrary} from '../packages/business/src/app-db/index.ts';
import {createFcpExportServices} from '../packages/business/src/fcp-export.ts';
import {run} from '../packages/business/src/media-runtime.ts';
import {createPremiereExportServices} from '../packages/business/src/premiere-export.ts';
import {createProjectAssetReferenceServices} from '../packages/business/src/project-asset-references.ts';
import {readFormat5TimelineRecord} from '../packages/business/src/project-file/format5-timeline.ts';
import {FORMAT5_PROJECT_SCHEMA_VERSION, FORMAT6_PROJECT_SCHEMA_VERSION} from '../packages/business/src/project-file/schema/databases.ts';
import {createProjectStore} from '../packages/business/src/project-file/store.ts';
import {createProjectServiceApplication} from '../packages/business/src/project-service-application.ts';
import type {Format5Clip} from '../packages/contracts/src/project-format5.ts';
import {CLIP_TRANSITION_PROFILE} from '../packages/contracts/src/timeline-clip-transition.ts';
import type {SpeedSetting} from '../packages/contracts/src/timeline-speed.ts';
import {compileTimeMap, initialTimeMap, projectTimeMapToCurrentClipFields, timeMapBasisFromCurrentClip} from '../packages/contracts/src/timeline-time-map.ts';

const timestamp = '2026-01-01T00:00:00.000Z';
const projectName = 'Synthetic interchange film';
const id = (value: number) => `95000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const projectId = id(1), rootId = id(2), trackId = id(3), assetId = id(4), timelineId = id(5);
const title = 'Interchange proof';
const fps = 30;

const targets = [
  {name: 'FCPXML', create: createFcpExportServices, xmlName: 'Info.fcpxml', dtdEnv: 'MIOON_FCPXML_DTD'},
  {name: 'Premiere', create: createPremiereExportServices, xmlName: title + '.xml', dtdEnv: 'MIOON_PREMIERE_XMEML_DTD'},
] as const;
type Target = typeof targets[number];

function scratch(t: test.TestContext) {
  const directory = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-nle-speed-'));
  const closers: Array<() => void> = [];
  t.after(() => {
    try {
      for (const close of closers.reverse()) close();
    } finally {
      rmSync(directory, {force: true, recursive: true});
    }
  });
  return {directory, onClose(close: () => void) {closers.push(close);}};
}

function clip(number: number, name: string, startFrame: number): Format5Clip {
  return {
    id: id(100 + number), trackId, name, startFrame, durationFrames: 24, sourceInFrame: 8,
    rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 1, assetId, sourceState: 'ready',
    sequenceSource: {kind: 'media', nodeId: id(200 + number), segmentGroupId: id(300 + number)},
  };
}

function straightClips(): Format5Clip[] {
  return [
    clip(1, 'Original picture', 0),
    {...clip(2, 'Second picture', 24), sourceInFrame: 20,
      transitionIn: {profileId: CLIP_TRANSITION_PROFILE, kind: 'dissolve', durationFrames: 6}},
  ];
}

function speedClip(base: Format5Clip, setting: SpeedSetting): Format5Clip {
  const next = timeMapBasisFromCurrentClip(base, {fps});
  assert.ok(next.ok, JSON.stringify(next));
  const basis = {...next.value, speed: setting.speed};
  const compiled = compileTimeMap(basis);
  assert.ok(compiled.ok, JSON.stringify(compiled));
  const plan = initialTimeMap(compiled.value, setting.direction);
  const fields = projectTimeMapToCurrentClipFields(base, plan);
  assert.ok(fields.ok, JSON.stringify(fields));
  return {...base, ...fields.value, timing: {profile: 'timeline-speed-v1', basis,
    view: {loTime: {anchor: 'start', offsetOutputFrames: 0}, hiTime: {anchor: 'end', offsetOutputFrames: 0}, direction: setting.direction},
    outputWindow: plan.outputWindow, pitchShift: setting.pitchShift, interpolation: setting.interpolation}};
}

function timedClips(sha256: string) {
  const constant = (numerator: number, denominator: number) => ({kind: 'constant' as const, rate: {numerator, denominator}});
  const defaultSetting = {direction: 'forward', pitchShift: false, interpolation: 'off'} as const;
  const make = (index: number, name: string, setting: SpeedSetting) => speedClip(clip(index, name, 0), setting);
  const timed: Format5Clip[] = [
    make(1, 'Forward', {...defaultSetting, speed: constant(2, 1)}),
    make(2, 'Reverse', {...defaultSetting, speed: constant(2, 1), direction: 'reverse', pitchShift: true}),
    {...clip(3, 'Freeze', 0), durationFrames: 10, sourceInFrame: 20, sourceSpanFrames: 1, muted: true,
      timing: {profile: 'timeline-freeze-v1', sourceFrame: 20, sourceVersionId: null, sourceSha256: sha256}},
    make(4, 'Curve', {...defaultSetting, speed: {kind: 'curve', interpolation: 'log-pchip-v1', presetId: 'test',
      points: [{sourceFrame: 8, rate: {numerator: 1, denominator: 2}},
        {sourceFrame: 19, rate: {numerator: 1, denominator: 1}},
        {sourceFrame: 32, rate: {numerator: 2, denominator: 1}}]}}),
    make(5, 'Blend', {...defaultSetting, speed: constant(1, 2), interpolation: 'blend'}),
    make(6, 'Optical', {...defaultSetting, speed: constant(1, 2), interpolation: 'optical'}),
  ];
  let startFrame = 0;
  return timed.map(item => {
    const placed = {...item, startFrame};
    startFrame += item.durationFrames;
    return placed;
  });
}

async function fixture({directory, onClose}: ReturnType<typeof scratch>, source: string,
  version: typeof FORMAT5_PROJECT_SCHEMA_VERSION | typeof FORMAT6_PROJECT_SCHEMA_VERSION,
  makeClips: (sha256: string) => Format5Clip[]) {
  const projectDirectory = path.join(directory, 'project-' + version);
  mkdirSync(projectDirectory);
  const store = createProjectStore({projectId, projectFile: path.join(projectDirectory, 'Synthetic.mioon'), targetFormat: version,
    ...(version === FORMAT6_PROJECT_SCHEMA_VERSION ? {allowFormat6: true} : {}),
    locate: () => ({localDir: path.join(projectDirectory, 'records'), cacheDir: path.join(projectDirectory, 'cache'),
      tempDir: path.join(projectDirectory, 'temp')})});
  onClose(() => store.close());
  const library = openAppLibrary({dataDir: path.join(projectDirectory, 'app')});
  onClose(() => library.close());
  const application = createProjectServiceApplication(library);
  library.outsidePaths.confirm({projectId, directory: path.dirname(source), confirmedAt: timestamp});
  const references = createProjectAssetReferenceServices(store, application);
  const {reference} = await references.referenceForImport(source);
  const sha256 = createHash('sha256').update(readFileSync(source)).digest('hex');
  const clips = makeClips(sha256);
  store.tx(() => {
    store.put('projects', {id: projectId, name: projectName, revision: 1, createdAt: timestamp, updatedAt: timestamp});
    store.put('assets', {id: assetId, projectId, name: 'Marker source.mp4', mimeType: 'video/mp4', duration: 2.4,
      hasAudio: true, width: 32, height: 32, audioRate: 48000, audioChannels: 1,
      reference: {...reference, fullSha256: sha256}, referenceRevision: 1, sha256, sizeBytes: reference.sizeBytes});
    store.put('nodes', {id: rootId, projectId, type: 'sequence_root', name: 'Proof', position: {x: 0, y: 0}, createdAt: timestamp});
    for (const [index, item] of clips.entries()) {
      const previous = clips[index - 1]?.sequenceSource?.nodeId ?? rootId;
      const nodeId = item.sequenceSource!.nodeId;
      store.put('nodes', {id: nodeId, projectId, type: 'video', assetId,
        position: {x: index, y: 0}, createdAt: timestamp});
      store.put('edges', {id: id(400 + index), projectId, kind: 'sequence', source: previous, target: nodeId, createdAt: timestamp});
    }
    store.put('timelines', {id: timelineId, projectId, revision: 1, width: 720, height: 1280, fps, clips,
      durationFrames: clips.at(-1)!.startFrame + clips.at(-1)!.durationFrames,
      mainTrack: {trackId, sequenceNodeId: rootId},
      tracks: [{id: trackId, name: 'V1', kind: 'video', orderIndex: 0, hidden: false, muted: false}],
      createdAt: timestamp, updatedAt: timestamp});
    const board = clips.map(item => ({kind: 'media', nodeId: item.sequenceSource!.nodeId, assetId}));
    const track = board.map((entry, index) => ({...entry, clipId: clips[index]!.id,
      segmentGroupId: clips[index]!.sequenceSource!.segmentGroupId}));
    store.db.prepare('INSERT INTO project.sequence_sync_state(timelineId,projectId,sequenceNodeId,revision,baseline) VALUES(?,?,?,?,?)')
      .run(timelineId, projectId, rootId, 1, JSON.stringify({version: 1, board, track}));
  });
  assert.equal(store.db.prepare('PRAGMA project.user_version').get()?.user_version, version);
  assert.deepEqual(readFormat5TimelineRecord(store.db, 'project')?.clips.map(({id: clipId, timing}) => [clipId, timing]),
    clips.map(({id: clipId, timing}) => [clipId, timing]));
  return {store, application, clips, outputDirectory: path.join(projectDirectory, '导出')};
}

async function exportFiles(project: Awaited<ReturnType<typeof fixture>>, target: Target) {
  const core = target.create(project.store, project.application);
  try {
    const preview = await core.preview({projectId, copyMedia: false});
    const queued = core.start({projectId, requestId: randomUUID(), name: title, copyMedia: false, destination: {kind: 'project'}});
    for (let attempt = 0; attempt < 800; attempt++) {
      const done = core.get({projectId, exportId: queued.exportId});
      if (done.status === 'running') {
        await delay(25);
        continue;
      }
      assert.equal(done.status, 'done', JSON.stringify(done));
      assert.ok(done.result);
      const bundle = path.join(project.outputDirectory, done.result.bundleName);
      return {preview, xml: readFileSync(path.join(bundle, target.xmlName)), manifest: readFileSync(path.join(bundle, 'manifest.json')),
        missing: readFileSync(path.join(bundle, 'missing.md'))};
    }
    assert.fail(target.name + ' export did not finish');
  } finally {
    await core.drain();
  }
}

test('format 5 and format 6 without timing produce identical NLE packages', async t => {
  const temporary = scratch(t);
  const source = path.join(temporary.directory, 'Marker source.mp4');
  const bytes = Buffer.alloc(24);
  bytes.writeUInt32BE(24);
  bytes.write('ftypisom', 4, 'ascii');
  // Untimed output must keep accepting the old path and metadata without probing a movie.
  writeFileSync(source, bytes);
  const old = await fixture(temporary, source, FORMAT5_PROJECT_SCHEMA_VERSION, straightClips);
  const current = await fixture(temporary, source, FORMAT6_PROJECT_SCHEMA_VERSION, straightClips);
  const identityDirectory = path.join(temporary.directory, 'identity');
  mkdirSync(identityDirectory);
  const identity = await fixture({...temporary, directory: identityDirectory}, source, FORMAT6_PROJECT_SCHEMA_VERSION,
    () => straightClips().map(item => speedClip(item, {speed: {kind: 'constant', rate: {numerator: 1, denominator: 1}},
      direction: 'forward', pitchShift: false, interpolation: 'off'})));
  for (const target of targets) {
    const before = await exportFiles(old, target);
    const after = await exportFiles(current, target);
    assert.deepEqual(before.preview.missing, []);
    assert.deepEqual(after.preview.missing, []);
    assert.ok(before.xml.toString().includes(pathToFileURL(source).href), target.name + ' source URI');
    assert.deepEqual(after.xml, before.xml, target.name + ' XML');
    assert.deepEqual(after.manifest, before.manifest, target.name + ' manifest.json');
    assert.deepEqual(after.missing, before.missing, target.name + ' missing.md');
    assert.doesNotMatch(after.manifest.toString(), /"SPEED"/u);
    const explicit = await exportFiles(identity, target);
    assert.deepEqual(explicit.xml, before.xml, target.name + ' explicit identity XML');
    assert.deepEqual(explicit.manifest, before.manifest, target.name + ' explicit identity manifest.json');
    assert.deepEqual(explicit.missing, before.missing, target.name + ' explicit identity missing.md');
  }
});

function checkTimedXml(target: Target, result: Awaited<ReturnType<typeof exportFiles>>, clips: Format5Clip[], t: test.TestContext) {
  const xml = result.xml.toString();
  const names = new Map(clips.map(item => [item.name, item.id]));
  if (target.name === 'FCPXML') {
    const expectSeconds = (frames: number) => frames % fps ? `${frames}/${fps}s` : `${frames / fps}s`;
    for (const clip of clips) {
      const saved = [...xml.matchAll(/<asset-clip\b[^>]*><timeMap\b[^>]*>/gu)].find(match => match[0].includes(`name="${clip.name}"`));
      assert.ok(saved, clip.name);
      assert.ok(saved[0].includes(`duration="${expectSeconds(clip.durationFrames)}"`), clip.name + ' duration');
      if (clip.name === 'Forward') assert.match(saved[0], /preservesPitch="1"/u);
      if (clip.name === 'Reverse') assert.match(saved[0], /preservesPitch="0"/u);
      if (clip.name === 'Freeze') assert.match(saved[0], /srcEnable="video"/u);
      if (clip.name === 'Blend') assert.match(saved[0], /frameSampling="frame-blending"/u);
      if (clip.name === 'Optical') assert.match(saved[0], /frameSampling="optical-flow"/u);
    }
  } else {
    const itemXml = (media: 'video' | 'audio', name: string) =>
      [...xml.matchAll(/<clipitem\b[^>]*>[\s\S]*?<\/clipitem>/gu)].find(match => match[0].includes(`id="${media}-${names.get(name)}"`))?.[0];
    for (const clip of clips) {
      const item = itemXml('video', clip.name);
      assert.ok(item, clip.name);
      assert.ok(item.includes(`<start>${clip.startFrame}</start><end>${clip.startFrame + clip.durationFrames}</end>`), clip.name + ' time span');
      assert.ok(item.includes(`<in>0</in><out>${clip.durationFrames}</out>`), clip.name + ' output range');
      if (clip.name === 'Freeze') {
        assert.match(item, /<stillframe>TRUE<\/stillframe><stillframeoffset>20<\/stillframeoffset>/u);
        assert.equal(itemXml('audio', clip.name), undefined);
        continue;
      }
      assert.match(item, /<effectid>timeremap<\/effectid>/u);
      if (clip.name === 'Blend') assert.match(item, /<parameterid>frameblending<\/parameterid><name>[^<]*<\/name><value>TRUE<\/value>/u);
      if (clip.name === 'Optical') assert.match(item, /<parameterid>frameblending<\/parameterid><name>[^<]*<\/name><value>FALSE<\/value>/u);
      if (clip.name === 'Curve') {
        const audio = itemXml('audio', clip.name);
        assert.ok(audio);
        assert.match(audio, /<enabled>FALSE<\/enabled>/u);
      }
    }
  }
  const dtd = process.env[target.dtdEnv];
  const checked = spawnSync('xmllint', ['--noout', '--nonet', ...(dtd ? ['--dtdvalid', pathToFileURL(dtd).href] : []), '-'],
    {input: result.xml, encoding: 'utf8'});
  if (checked.error && (checked.error as NodeJS.ErrnoException).code === 'ENOENT' && !dtd) {
    t.diagnostic('xmllint unavailable for ' + target.name);
  } else {
    assert.ifError(checked.error);
    assert.equal(checked.status, 0, checked.stderr);
  }
}

async function writeVideo(source: string, sourceFps: number, filters: readonly string[] = []) {
  await run('ffmpeg', ['-v', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i',
    `testsrc2=size=32x32:rate=${sourceFps}:duration=2.4`, '-f', 'lavfi', '-i', 'sine=frequency=490:sample_rate=48000:duration=2.4',
    '-map', '0:v:0', '-map', '1:a:0', '-video_track_timescale', '30000',
    ...filters,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-threads:v', '1', '-c:a', 'aac', source]);
}

test('both published NLE packages list the actual treatment of curve and unsupported speed detail', async t => {
  const temporary = scratch(t);
  const source = path.join(temporary.directory, 'Marker source.mp4');
  await writeVideo(source, fps);
  const project = await fixture(temporary, source, FORMAT6_PROJECT_SCHEMA_VERSION, timedClips);
  const byName = new Map(project.clips.map(item => [item.name, item]));
  for (const target of targets) {
    const result = await exportFiles(project, target);
    const manifest = JSON.parse(result.manifest.toString()) as Pick<typeof result.preview, 'approximations' | 'missing' | 'timeline'>;
    assert.deepEqual(manifest.approximations, result.preview.approximations);
    assert.deepEqual(manifest.missing, result.preview.missing);
    assert.equal(manifest.timeline.durationFrames, project.clips.reduce((frames, item) => frames + item.durationFrames, 0));
    const speedItem = (group: 'approximations' | 'missing', from: string, name: string) => {
      const item = manifest[group].find(candidate => candidate.code === 'SPEED' && candidate.values?.from === from);
      assert.ok(item?.values?.to, `${target.name} ${group}: ${from}`);
      assert.deepEqual(item.clips.find(entry => entry.name === name), {id: byName.get(name)?.id, name, trackLabel: 'V1'});
      return item.values;
    };
    const error = speedItem('approximations', '曲线变速', 'Curve').maxErrorFrames;
    assert.ok(typeof error === 'number' && Number.isFinite(error) && error > 0 && error <= 0.05);
    speedItem('approximations', '帧混合', 'Blend');
    speedItem(target.name === 'FCPXML' ? 'approximations' : 'missing', '光流', 'Optical');
    if (target.name === 'Premiere') {
      speedItem('missing', '分段变速的音频', 'Curve');
      speedItem('missing', '保音调', 'Forward');
    }
    assert.equal(manifest.missing.some(item => item.code === 'SPEED' && item.values?.from === '原片帧号对应'), false);
    const checklist = result.missing.toString();
    assert.ok(checklist.includes('最大误差 ' + error + ' 帧'));
    assert.match(checklist, /Curve/u);
    assert.match(checklist, /Optical/u);
    checkTimedXml(target, result, project.clips, t);
  }
});

test('the editor export reports which native picture clocks it could verify', async t => {
  for (const {name, filters} of [
    {name: '60 fps CFR', filters: []},
    {name: 'irregular timestamps', filters: ['-vf', "select='lt(mod(n,4),2)'", '-fps_mode', 'passthrough']},
  ]) await t.test(name, async scenario => {
    const temporary = scratch(scenario);
    const source = path.join(temporary.directory, 'Marker source.mp4');
    await writeVideo(source, 60, filters);
    const project = await fixture(temporary, source, FORMAT6_PROJECT_SCHEMA_VERSION, () => [
      speedClip(clip(1, 'Native frame probe', 0), {speed: {kind: 'constant', rate: {numerator: 2, denominator: 1}},
        direction: 'forward', pitchShift: false, interpolation: 'off'}),
    ]);
    for (const target of targets) {
      const {preview, xml} = await exportFiles(project, target);
      const issue = preview.missing.find(item => item.code === 'SPEED' && item.values?.from === '原片帧号对应');
      if (target.name === 'FCPXML' && filters.length === 0) {
        assert.equal(issue, undefined);
        assert.match(xml.toString(), /frameDuration="1\/60s"/u);
      } else {
        assert.deepEqual(issue?.clips, [{id: project.clips[0]!.id, name: project.clips[0]!.name, trackLabel: 'V1'}]);
        assert.doesNotMatch(xml.toString(), /frameDuration="1\/60s"/u);
      }
      assert.match(xml.toString(), target.name === 'FCPXML' ? /<timeMap\b/u : /<effectid>timeremap<\/effectid>/u);
    }
  });
});
