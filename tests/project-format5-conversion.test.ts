import test from 'node:test';
import assert from 'node:assert/strict';
import {planFormat5Conversion} from '../packages/business/src/project-file/format5-conversion.ts';
import type {Format5ConversionAllocation, Format5ConversionInput, Format5LegacyClip, Format5LegacyTimeline} from '../packages/business/src/project-file/format5-conversion.ts';
import {isFormat5Timeline} from '../packages/contracts/src/project-format5.ts';

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const stamp = '2026-01-01T00:00:00.000Z', convertedAt = '2026-01-02T00:00:00.000Z';
const projectId = id(1), videoTrack = id(2), audioTrack = id(3);
function allocation(): Format5ConversionAllocation {
  return {sequenceRootId: id(1000), createdAt: convertedAt,
    nodeIds: Array.from({length: 600}, (_, at) => id(2000 + at)), clipIds: Array.from({length: 600}, (_, at) => id(3000 + at)),
    segmentGroupIds: Array.from({length: 600}, (_, at) => id(4000 + at)), edgeIds: Array.from({length: 1200}, (_, at) => id(5000 + at)),
    anchorConflictPolicy: 'reject'};
}
function clip(value: number, assetId: string, startFrame: number, durationFrames: number, sourceInFrame = 0): Format5LegacyClip {
  return {id: id(value), trackId: videoTrack, assetId, name: `Clip ${value}`, startFrame, durationFrames, sourceInFrame,
    rect: {x: 0, y: 0, width: 720, height: 1280}, gain: .75};
}
function fixture(): Format5ConversionInput {
  const assets = [
    {id: id(20), projectId, mimeType: 'video/mp4', sha256: 'a'.repeat(64), duration: 10},
    {id: id(21), projectId, mimeType: 'video/mp4', sha256: 'b'.repeat(64), duration: 10},
    {id: id(22), projectId, mimeType: 'video/mp4', sha256: 'c'.repeat(64), duration: 10},
    {id: id(23), projectId, mimeType: 'image/png', sha256: null, duration: null},
    {id: id(24), projectId, mimeType: 'audio/wav', sha256: null, duration: 10},
  ];
  const versions = [
    {id: id(30), projectId, shotId: id(10), assetId: id(20), sha256: assets[0]!.sha256!, jobId: id(80)},
    {id: id(31), projectId, shotId: id(10), assetId: id(21), sha256: assets[1]!.sha256!, jobId: id(81)},
    {id: id(32), projectId, shotId: id(11), assetId: id(22), sha256: assets[2]!.sha256!, jobId: id(82)},
  ];
  const timeline: Format5LegacyTimeline = {id: id(4), projectId, revision: 7, fps: 30, width: 720, height: 1280,
    tracks: [{id: videoTrack, kind: 'video', name: 'V1', orderIndex: 0, hidden: false, muted: false},
      {id: audioTrack, kind: 'audio', name: 'A1', orderIndex: 1, hidden: false, muted: false}],
    clips: [clip(40, id(20), 0, 30), {...clip(41, id(20), 30, 30, 30), fadeInFrames: 2,
      volumeEnvelope: {profileId: 'mioon-clip-linear-attenuation-v1', points: [{frame: 0, multiplier: .5}, {frame: 30, multiplier: 1}]},
      transitionIn: {profileId: 'mioon-clip-transition-v1', kind: 'dissolve', durationFrames: 4}},
      clip(42, id(23), 70, 20), clip(43, id(20), 100, 20), clip(44, id(22), 120, 30, 10),
      {...clip(45, id(24), 75, 10), trackId: audioTrack}, {...clip(46, id(24), 63, 8), trackId: audioTrack}],
    durationFrames: 150, createdAt: stamp, updatedAt: stamp,
    subtitles: {profileId: 'bottom_cjk_v1', cues: [{id: id(50), text: 'A', startFrame: 35, durationFrames: 5},
      {id: id(51), text: 'B', startFrame: 105, durationFrames: 5}]}};
  return {sourceFormat: 4, projectId, hasProject: true,
    shots: [{id: id(10), projectId, orderIndex: 0, duration: 2, selectedVersionId: id(31), title: 'Live shot', referenceAssetIds: [id(23)], position: {x: 10, y: 20}},
      {id: id(11), projectId, orderIndex: 1, duration: 2, selectedVersionId: id(32), title: 'Archived shot', referenceAssetIds: []},
      {id: id(12), projectId, orderIndex: 2, duration: 2, selectedVersionId: null, title: 'Placeholder', referenceAssetIds: []}],
    nodes: [{id: id(60), projectId, type: 'image', assetId: id(23), label: 'Reference', text: '', position: {x: 15, y: 25}, revision: 1, createdAt: stamp}],
    edges: [{id: id(70), projectId, kind: 'reference', source: id(60), target: id(10), role: 'first_frame', sourceAssetId: id(23), createdAt: stamp},
      {id: id(71), projectId, kind: 'decorative', source: id(10), target: id(11), createdAt: stamp}],
    versions, assets, subjectBindings: [{id: id(90), projectId, shotId: id(10), subjectId: id(91), subjectVersionId: id(92), reviewedHeadVersionId: id(92)},
      {id: id(93), projectId, shotId: id(10), subjectId: id(94), subjectVersionId: null, reviewedHeadVersionId: id(95)}],
    timeline, archivedShotIds: [id(11)], provenVersions: versions.map(version => ({versionId: version.id, projectId, shotId: version.shotId,
      assetId: version.assetId, sha256: version.sha256, jobId: version.jobId}))};
}

test('conversion preserves cuts and media while creating one packed chain, locks, placeholders and explicit anchors', () => {
  const source = fixture(), before = structuredClone(source), plan = planFormat5Conversion(source, allocation()), timeline = plan.timeline!;
  assert.deepEqual(source, before, 'planning cannot mutate persisted rows');
  assert.ok(isFormat5Timeline(timeline));
  assert.equal(timeline.revision, source.timeline!.revision + 1);
  assert.equal(timeline.updatedAt, convertedAt);
  const main = timeline.clips.filter(item => item.trackId === videoTrack);
  assert.deepEqual(main.map(item => item.startFrame), [0, 30, 60, 120, 140, 160]);
  assert.deepEqual(main.filter(item => item.sequenceSource?.nodeId === id(10)).map(item => [item.id, item.versionId, item.sequenceSource]), [
    [id(40), id(30), {kind: 'shot', nodeId: id(10), segmentGroupId: id(4000), versionMode: 'locked'}],
    [id(41), id(30), {kind: 'shot', nodeId: id(10), segmentGroupId: id(4000), versionMode: 'locked'}],
  ]);
  const placeholder = main.find(item => item.sequenceSource?.nodeId === id(12))!;
  assert.equal(placeholder.sourceState, 'placeholder');
  assert.deepEqual([placeholder.assetId, placeholder.versionId, placeholder.jobId], [null, null, null]);
  assert.equal(placeholder.durationFrames, 60);
  const repeat = main.find(item => item.id === id(43))!, archived = main.find(item => item.id === id(44))!;
  assert.equal(repeat.sequenceSource?.kind, 'media');
  assert.equal(archived.sequenceSource?.kind, 'media');
  assert.equal(archived.assetId, id(22));
  assert.equal(plan.nodes.filter(node => node.type === 'video').length, 2);
  assert.deepEqual(timeline.clips.find(item => item.id === id(45))!.anchor, {clipId: id(42), offsetFrames: 5});
  assert.equal(timeline.clips.find(item => item.id === id(45))!.startFrame, 125);
  assert.equal(timeline.clips.find(item => item.id === id(46))!.anchor, null);
  assert.equal(timeline.clips.find(item => item.id === id(46))!.startFrame, 63);
  assert.deepEqual(timeline.subtitles!.cues.map(cue => [cue.id, cue.startFrame, cue.anchor]), [
    [id(50), 35, {clipId: id(41), offsetFrames: 5}], [id(51), 145, {clipId: id(43), offsetFrames: 5}],
  ]);
  assert.equal(Object.hasOwn(timeline.subtitles!.cues[0]!, 'dialogueRef'), false);
  assert.equal(Object.hasOwn(source.shots[0]!, 'dialogue'), false);
  assert.deepEqual(plan.subjectBindings.map(binding => binding.bindingMode), ['locked', 'detached']);
  assert.deepEqual(plan.removedEdgeIds, [id(71)]);
  assert.deepEqual(plan.edges.find(edge => edge.id === id(70)), source.edges[0]);
  assert.deepEqual(main.find(item => item.id === id(41))!.volumeEnvelope, source.timeline!.clips.find(item => item.id === id(41))!.volumeEnvelope);
  assert.deepEqual(main.find(item => item.id === id(41))!.transitionIn, source.timeline!.clips.find(item => item.id === id(41))!.transitionIn);
  assert.equal(plan.summary.compactedGapFrames, 20);
  assert.equal(plan.summary.lockedClips, 2);
  assert.equal(plan.summary.placeholderClips, 1);
  assert.equal(plan.summary.mediaCards, 3);
});

test('input row enumeration cannot change the conversion plan or its preallocated IDs', () => {
  const source = fixture();
  const shuffled = {...source, shots: [...source.shots].reverse(), nodes: [...source.nodes].reverse(), edges: [...source.edges].reverse(),
    assets: [...source.assets].reverse(), versions: [...source.versions].reverse(), provenVersions: [...source.provenVersions].reverse(), subjectBindings: [...source.subjectBindings].reverse()};
  assert.deepEqual(planFormat5Conversion(shuffled, allocation()), planFormat5Conversion(source, allocation()));
});

test('both legacy source formats share the plan and an omitted subtitle profile becomes its explicit legacy default', () => {
  const source = fixture();
  const noProfile = {...source, timeline: {...source.timeline!, subtitles: {cues: source.timeline!.subtitles!.cues}}};
  const explicit = planFormat5Conversion(source, allocation());
  assert.deepEqual(planFormat5Conversion(noProfile, allocation()), explicit);
  const imported = {...noProfile, shots: [], nodes: [], edges: [], versions: [], subjectBindings: [], provenVersions: [], archivedShotIds: [],
    timeline: {...source.timeline!, clips: [clip(42, id(23), 6, 30)], durationFrames: 36,
      subtitles: {cues: [{id: id(50), text: 'A', startFrame: 10, durationFrames: 5}]}}};
  assert.deepEqual(planFormat5Conversion({...imported, sourceFormat: 3}, allocation()), planFormat5Conversion(imported, allocation()));
});

test('legacy reference order and tails become explicit roles, and hidden first-frame edges retain their identities', () => {
  const source = fixture();
  const input = {...source,
    shots: source.shots.map(shot => shot.id === id(10) ? {...shot, referenceAssetIds: [id(23), id(25)], lastFrameAssetId: id(26)}
      : shot.id === id(11) ? {...shot, referenceAssetIds: [id(23)]} : shot),
    assets: [...source.assets, {id: id(25), projectId, mimeType: 'image/png', duration: null, sha256: null},
      {id: id(26), projectId, mimeType: 'image/png', duration: null, sha256: null}],
    edges: [...source.edges, {...source.edges[0]!, id: id(72), target: id(11)}]};
  const plan = planFormat5Conversion(input, allocation());
  assert.deepEqual(plan.edges.filter(edge => edge.kind === 'reference' && edge.target === id(10)).map(edge => [edge.role, edge.sourceAssetId, edge.orderIndex]),
    [['first_frame', id(23), undefined], ['reference_image', id(25), 1], ['last_frame', id(26), 0]]);
  assert.deepEqual(plan.edges.find(edge => edge.id === id(72)), input.edges.at(-1));
  assert.deepEqual(plan.removedEdgeIds, [id(71)]);
});

test('version provenance is checked before a source becomes a live shot segment', () => {
  const source = fixture();
  for (const altered of [
    {...source, provenVersions: source.provenVersions.filter(proof => proof.versionId !== id(30))},
    {...source, provenVersions: source.provenVersions.map(proof => proof.versionId === id(30) ? {...proof, sha256: 'd'.repeat(64)} : proof)},
    {...source, timeline: {...source.timeline!, clips: source.timeline!.clips.map(item => item.id === id(40) ? {...item, versionId: id(32)} : item)}},
  ]) assert.throws(() => planFormat5Conversion(altered, allocation()), {code: 'FORMAT5_CONVERSION_SOURCE_UNAVAILABLE'});
  const plan = planFormat5Conversion(source, allocation());
  assert.ok(plan.nodes.some(node => node.type === 'image' && node.assetId === id(23)), 'a valid imported image may retain a null full hash');
});

test('ambiguous implicit versions become fixed media, while a repeated still cannot masquerade as a split', () => {
  const source = fixture(), duplicate = {...source.versions[0]!, id: id(33), shotId: id(12), jobId: id(83)};
  const ambiguous = {...source, versions: [...source.versions, duplicate], provenVersions: source.provenVersions.filter(item => item.versionId !== id(30))};
  const plan = planFormat5Conversion(ambiguous, allocation());
  assert.deepEqual(plan.summary.ambiguousSourceClips, [id(40), id(41), id(43)]);
  assert.equal(plan.timeline!.clips.find(item => item.id === id(40))!.sequenceSource!.kind, 'media');
  const stillVersion = {...source.versions[0]!, assetId: id(23), sha256: 'e'.repeat(64)};
  const still = {...source, shots: [{...source.shots[0]!, selectedVersionId: stillVersion.id}], archivedShotIds: [],
    versions: [stillVersion], assets: source.assets.map(asset => asset.id === id(23) ? {...asset, sha256: 'e'.repeat(64)} : asset),
    provenVersions: [{versionId: stillVersion.id, projectId, shotId: id(10), assetId: id(23), sha256: 'e'.repeat(64), jobId: stillVersion.jobId}],
    timeline: {...source.timeline!, clips: [clip(40, id(23), 0, 10), clip(41, id(23), 10, 10)], durationFrames: 20, subtitles: {profileId: 'bottom_cjk_v1', cues: []}}};
  const converted = planFormat5Conversion(still, allocation()).timeline!.clips;
  assert.equal(converted[0]!.sequenceSource!.kind, 'shot');
  assert.equal(converted[1]!.sequenceSource!.kind, 'media');
});

test('anchor conflicts reject the whole plan or detach only affected anchors at original positions', () => {
  const source = fixture();
  const original = {...source.timeline!, clips: [clip(40, id(20), 0, 20), clip(41, id(23), 30, 20),
    {...clip(45, id(24), 35, 10), trackId: audioTrack}, {...clip(46, id(24), 20, 10), trackId: audioTrack}],
    durationFrames: 50, subtitles: {profileId: 'bottom_cjk_v1', cues: []}};
  const input = {...source, shots: source.shots.slice(0, 2), timeline: original};
  assert.throws(() => planFormat5Conversion(input, allocation()), {code: 'FORMAT5_CONVERSION_ANCHOR_CONFLICT', ids: [id(45), id(46)]});
  const plan = planFormat5Conversion(input, {...allocation(), anchorConflictPolicy: 'detach'});
  const audio = plan.timeline!.clips.filter(item => item.trackId === audioTrack);
  assert.deepEqual(audio.map(item => [item.id, item.startFrame, item.anchor]), [[id(45), 35, null], [id(46), 20, null]]);
  assert.equal(plan.summary.detachedAnchors, 1);
  assert.equal(plan.timeline!.clips.find(item => item.id === id(41))!.startFrame, 20);
  assert.deepEqual(input.timeline, original, 'a failed or detached preview leaves the original untouched');
});

test('detaching cannot make an out-of-bounds gap subtitle appear valid or silently trim it', () => {
  const source = fixture();
  const input = {...source, shots: [], nodes: [], edges: [], versions: [], subjectBindings: [], provenVersions: [], archivedShotIds: [],
    timeline: {...source.timeline!, clips: [clip(42, id(23), 100, 20)], durationFrames: 120,
      subtitles: {profileId: 'bottom_cjk_v1', cues: [{id: id(50), text: 'A', startFrame: 95, durationFrames: 10}]}}};
  const before = structuredClone(input);
  for (const policy of ['reject', 'detach'] as const)
    assert.throws(() => planFormat5Conversion(input, {...allocation(), anchorConflictPolicy: policy}), {code: 'FORMAT5_CONVERSION_ANCHOR_CONFLICT', ids: [id(50)]});
  assert.deepEqual(input, before);
});

test('reordering keeps a transition only on its original adjacent pair', () => {
  const source = fixture();
  const input = {...source, shots: [{...source.shots[0]!, orderIndex: 1, selectedVersionId: id(30), referenceAssetIds: []}, {...source.shots[1]!, orderIndex: 0}],
    nodes: [], edges: [], archivedShotIds: [], subjectBindings: [],
    timeline: {...source.timeline!, clips: [clip(40, id(20), 0, 30), {...clip(44, id(22), 30, 30, 10),
      transitionIn: {profileId: 'mioon-clip-transition-v1', kind: 'dissolve', durationFrames: 4}}], durationFrames: 60,
      subtitles: {profileId: 'bottom_cjk_v1', cues: []}}};
  const plan = planFormat5Conversion(input, allocation());
  assert.deepEqual(plan.timeline!.clips.map(item => item.id), [id(44), id(40)]);
  assert.equal(Object.hasOwn(plan.timeline!.clips[0]!, 'transitionIn'), false);
  assert.equal(plan.summary.removedTransitions, 1);
  assert.equal(plan.summary.reorderedClips, 2);
});

test('a missing timeline requires the saved-geometry template, while an empty database has no content conversion', () => {
  const source = fixture();
  assert.throws(() => planFormat5Conversion({...source, timeline: null}, allocation()), {code: 'FORMAT5_CONVERSION_TIMELINE_REQUIRED'});
  const template = {...source.timeline!, revision: 1, clips: [], durationFrames: 0, subtitles: {profileId: 'bottom_cjk_v1', cues: []}};
  const plan = planFormat5Conversion({...source, timeline: null, emptyTimeline: template}, allocation());
  assert.equal(plan.timeline!.revision, 1);
  assert.equal(plan.timeline!.width, template.width);
  assert.equal(plan.timeline!.height, template.height);
  const empty = {...source, hasProject: false, shots: [], nodes: [], edges: [], versions: [], assets: [], subjectBindings: [], timeline: null, provenVersions: []};
  assert.deepEqual(planFormat5Conversion(empty, allocation()), {nodes: [], edges: [], removedEdgeIds: [], timeline: null, subjectBindings: [], syncState: null,
    summary: {reorderedClips: 0, lockedClips: 0, placeholderClips: 0, mediaCards: 0, removedDecorativeEdges: 0,
      removedTransitions: 0, compactedGapFrames: 0, detachedAnchors: 0, durationDeltaFrames: 0, ambiguousSourceClips: []}});
});

test('identity exhaustion, source loss, revision overflow and editing capacity fail without partial output', () => {
  const source = fixture();
  assert.throws(() => planFormat5Conversion(source, {...allocation(), segmentGroupIds: []}), {code: 'FORMAT5_CONVERSION_ID_REQUIRED'});
  assert.throws(() => planFormat5Conversion({...source, assets: source.assets.filter(asset => asset.id !== id(23))}, allocation()), {code: 'FORMAT5_CONVERSION_INVALID'});
  assert.throws(() => planFormat5Conversion({...source, timeline: {...source.timeline!, revision: Number.MAX_SAFE_INTEGER}}, allocation()), {code: 'FORMAT5_CONVERSION_INVALID'});
  const shots = Array.from({length: 501}, (_, at) => ({id: id(10000 + at), projectId, orderIndex: at, duration: 1, selectedVersionId: null, title: 'Placeholder', referenceAssetIds: []}));
  const large = {...source, shots, nodes: [], edges: [], versions: [], assets: [], subjectBindings: [], provenVersions: [], archivedShotIds: [],
    timeline: {...source.timeline!, clips: [], durationFrames: 0, subtitles: {profileId: 'bottom_cjk_v1', cues: []}}};
  assert.throws(() => planFormat5Conversion(large, allocation()), {code: 'FORMAT5_CAPACITY'});
});
