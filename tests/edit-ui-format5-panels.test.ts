import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {
  format5AnchorConflictPresentation, format5ClipInspectorEdit, format5ClipPropertyEdit, format5ConflictIds,
  format5MoveBeforeClipId, format5PanelErrorKey, format5PropertiesIntent, format5SubtitleEdit, splitFormat5ClipPatch,
} from '../apps/web/src/edit-ui/format5-panel-edits.ts';
import {Format5EditSession} from '../apps/web/src/edit-ui/session.ts';
import {LOCALES, translate} from '../packages/i18n/src/index.ts';
import type {SubtitleIntent} from '../apps/web/src/subtitle-state.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const clip = (id: string, patch: Record<string, unknown> = {}) => ({id, trackId: 'main', startFrame: 0, durationFrames: 30,
  sourceInFrame: 0, name: id, gain: 1, fadeInFrames: 0, fadeOutFrames: 0, ...patch});
const main = 'main';
const clips = [clip('a'), clip('b', {startFrame: 30}), clip('c', {startFrame: 60}), clip('x', {trackId: 'other'})];

test('one inspector patch splits into changed FR-A properties and TS structural edits', () => {
  const current = clip('a', {volumeEnvelope: null});
  const split = splitFormat5ClipPatch(current, {...current, name: 'renamed', gain: 0.5, fadeInFrames: 3,
    durationFrames: 30, startFrame: 0, trackId: 'main', sourceInFrame: 0});
  assert.deepEqual(split.properties, {name: 'renamed', gain: 0.5, fadeInFrames: 3});
  assert.deepEqual(split.geometry, {}, 'unchanged fields are not structural edits');
  assert.deepEqual(split.unsupported, []);
  // Rect is not part of the frozen FR-A patch contract.
  const rect = splitFormat5ClipPatch(current, {...current, rect: {x: 0, y: 0, width: 10, height: 10}});
  assert.deepEqual(rect.unsupported, ['rect']);
  // Property and structural changes cannot share one intent family.
  const mixed = format5ClipInspectorEdit(current, {name: 'renamed', durationFrames: 20}, clips, main);
  assert.deepEqual(mixed, {kind: 'unsupported', reason: 'mixed', fields: ['name', 'durationFrames']});
});

test('a property-only save is one FR-A timeline action', () => {
  const edit = format5ClipInspectorEdit(clip('a'), {name: 'renamed', gain: 0.5, fadeInFrames: 3, fadeOutFrames: 4},
    clips, main);
  assert.equal(edit.kind, 'properties');
  if (edit.kind !== 'properties') return;
  assert.deepEqual(edit.intent, format5PropertiesIntent('a', {name: 'renamed', gain: 0.5, fadeInFrames: 3, fadeOutFrames: 4}));
  assert.equal(edit.intent.side, 'timeline');
  assert.equal(edit.intent.operation.kind, 'clip-properties');
});

test('structural saves map to the TS trim, move and move-off-track commands', () => {
  assert.deepEqual(format5ClipInspectorEdit(clip('a'), {durationFrames: 20, sourceInFrame: 2}, clips, main),
    {kind: 'trim', patch: {durationFrames: 20, sourceInFrame: 2}});
  assert.deepEqual(format5ClipInspectorEdit(clip('b', {startFrame: 30}), {startFrame: 0}, clips, main),
    {kind: 'move', beforeClipId: 'a'});
  assert.equal(format5MoveBeforeClipId(clips, 'a', main, 100), null, 'moving past the tail appends');
  assert.deepEqual(format5ClipInspectorEdit(clip('a'), {trackId: 'other', startFrame: 45}, clips, main),
    {kind: 'move-off-track', trackId: 'other', startFrame: 45});
  // Start frame plus length is two structural commands; ask for two saves.
  assert.deepEqual(format5ClipInspectorEdit(clip('a'), {startFrame: 15, durationFrames: 10}, clips, main),
    {kind: 'unsupported', reason: 'mixed', fields: ['startFrame', 'durationFrames']});
  // Moving an other-track clip back onto the main track has no TS command.
  const other = format5ClipInspectorEdit(clip('x', {trackId: 'other'}), {trackId: 'main'}, clips, main);
  assert.equal(other.kind, 'unsupported');
});

test('clip mute is part of the one FR-A properties patch and never a structural edit', () => {
  const current = clip('a');
  const unmuted = splitFormat5ClipPatch(current, {...current, muted: true});
  assert.deepEqual(unmuted.properties, {muted: true});
  assert.deepEqual(unmuted.geometry, {});
  const muted = clip('a', {muted: true});
  assert.deepEqual(splitFormat5ClipPatch(muted, {...muted, muted: false}).properties, {muted: false});
  assert.deepEqual(format5ClipInspectorEdit(current, {muted: true}, clips, main),
    {kind: 'properties', intent: format5PropertiesIntent('a', {muted: true})});
  assert.equal(format5PanelErrorKey('SEQUENCE_EDIT_SOUND_INVALID'), 'editUi.error.SEQUENCE_EDIT_SOUND_INVALID');
});

test('transform and transition edits are FR-A property actions and reject invalid values', () => {
  const transform = {profileId: 'mioon-clip-transform-v1', keyframes: [{frame: 0, x: 0, y: 0, scale: 1}], rotation: 0, crop: {left: 0, top: 0, right: 0, bottom: 0}};
  const mapped = format5ClipPropertyEdit('a', 'transform', transform, 30);
  assert.equal('unsupported' in mapped, false);
  if (!('unsupported' in mapped)) assert.deepEqual(mapped.operation.edits[0]!.patch, {transform});
  assert.equal('unsupported' in format5ClipPropertyEdit('a', 'transform', {bad: true}, 30), true);
  const transition = {profileId: 'mioon-clip-transition-v1', kind: 'dissolve', durationFrames: 8};
  const patch = format5ClipPropertyEdit('a', 'transition', transition, 30);
  assert.equal('unsupported' in patch, false);
  if (!('unsupported' in patch)) assert.deepEqual(patch.operation.edits[0]!.patch, {transition});
  assert.equal('unsupported' in format5ClipPropertyEdit('a', 'transition', {...transition, durationFrames: 1}, 30), true);
  // null clears the value and stays a supported property edit.
  assert.equal('unsupported' in format5ClipPropertyEdit('a', 'transition', null, 30), false);
});

const subtitle = (operation: string, input: Record<string, unknown>): SubtitleIntent => ({scope: 's', projectId: 'p',
  timelineId: 't', selection: 1, serial: 1, operation, input: {projectId: 'p', expectedRevision: 3, requestId: 'r', ...input},
  previousIds: []});

test('subtitle add/update/remove map to one FR-B subtitles intent', () => {
  const add = format5SubtitleEdit(subtitle('timeline.subtitle.add', {text: '一', startFrame: 10, durationFrames: 20}), 'cue-new');
  assert.deepEqual(add.intent, {side: 'timeline', operation: {kind: 'subtitles', edits: [
    {kind: 'add', cue: {id: 'cue-new', text: '一', startFrame: 10, durationFrames: 20}}]}});
  const update = format5SubtitleEdit(subtitle('timeline.subtitle.update', {cueId: 'cue-1',
    patch: {text: '改', startFrame: 12}}), 'ignored');
  assert.deepEqual(update.intent, {side: 'timeline', operation: {kind: 'subtitles', edits: [
    {kind: 'update', cueId: 'cue-1', patch: {text: '改', startFrame: 12}}]}});
  const remove = format5SubtitleEdit(subtitle('timeline.subtitle.remove', {cueId: 'cue-1'}), 'ignored');
  assert.deepEqual(remove.intent, {side: 'timeline', operation: {kind: 'subtitles', edits: [
    {kind: 'remove', cueId: 'cue-1'}]}});
  // Legacy/unknown operations stay rejected instead of being forwarded.
  assert.equal(format5SubtitleEdit(subtitle('timeline.track.add', {}), 'x').intent, null);
});

test('rejected shared actions map to one reason and expose affected ids', () => {
  assert.equal(format5PanelErrorKey('SEQUENCE_EDIT_ANCHOR_CONFLICT'), 'editUi.error.SEQUENCE_EDIT_ANCHOR_CONFLICT');
  assert.equal(format5PanelErrorKey('SEQUENCE_EDIT_CLIP_PROPERTIES_INVALID'), 'editUi.error.CLIP_PROPERTIES_INVALID');
  assert.equal(format5PanelErrorKey('SEQUENCE_EDIT_SUBTITLE_INVALID'), 'editUi.error.SUBTITLE_INVALID');
  assert.equal(format5PanelErrorKey('SOMETHING_ELSE'), 'editUi.error.GENERIC');
  assert.deepEqual(format5ConflictIds({details: {ids: ['clip-a', 3, 'cue-b']}}), ['clip-a', 'cue-b']);
  assert.deepEqual(format5ConflictIds(new Error('x')), []);
  // Every reason key has all four locales.
  for (const key of ['editUi.error.CLIP_PROPERTIES_INVALID', 'editUi.error.SUBTITLE_INVALID',
    'editUi.error.FORMAT5_EDIT_MIXED', 'editUi.error.FORMAT5_EDIT_UNSUPPORTED',
    'editUi.notice.propertiesSaved', 'editUi.notice.subtitleSaved', 'editUi.error.SEQUENCE_EDIT_ANCHOR_CONFLICT']) {
    for (const locale of LOCALES) assert.ok(translate(locale, key as never, {name: 'x'} as never).length > 0, `${key}/${locale}`);
  }
  assert.equal(translate('en', 'editUi.error.FORMAT5_EDIT_MIXED'), 'Save property and structural changes separately.');
});

test('format-5 clip selection passes a loudness provider backed by a real context', () => {
  const app = readFileSync(path.join(root, 'apps/web/src/App.tsx'), 'utf8');
  assert.ok(app.includes('loudnessContext={clipLoudnessContext as never}'));
  assert.doesNotMatch(app, /if \((?:dataRef\.current\?\.projectFormatVersion === 5|isSequenceTimelineFormat\(dataRef\.current\?\.projectFormatVersion\))\) return undefined;/u);
  // The provider still has to build the saved identity rather than returning a
  // bare execution scope, so the observation card never dereferences undefined.
  assert.match(app, /savedClipLoudnessFields\(saved, dataRef\.current!\.assets, editing\.selectedClipId\)/u);
});

test('format-5 explicit forms and clip drags receive editing admission without a dead first gesture', () => {
  const app = readFileSync(path.join(root, 'apps/web/src/App.tsx'), 'utf8');
  // Adding a subtitle is an explicit edit; the form must not open locked behind a second Edit click.
  assert.match(app, /<AgentEditingBoundary autoAcquire workspaceScope=\{editorSession\.current\|\|'unverified'\} disabled=\{false\} projectId=\{subtitles\.state\?\.projectId\}/u);
  // The first clip drag used to be cancelled by a synchronous admission check that returned false.
  assert.match(app, /onAdmitClipDrag=\{clipId => currentProject\.current \? holdAgentEditingTarget\(currentProject\.current, \{kind:'timeline_clip',id:clipId,revision:0\}\) : true\}/u);
  const timeline = readFileSync(path.join(root, 'apps/web/src/Timeline.tsx'), 'utf8');
  assert.match(timeline, /finally \{ drag\.release\?\.\(settled\); \}/u);
  assert.doesNotMatch(app, /onAdmitClipDrag=\{clipId => \{.*?return false; \}\}/su);
});

test('the production shell routes format-5 panel edits through the shared entry', () => {
  const app = readFileSync(path.join(root, 'apps/web/src/App.tsx'), 'utf8');
  for (const fragment of [
    "from './edit-ui/format5-panel-edits.ts'",
    'format5ClipInspectorEdit(', 'format5PropertiesAction(', 'format5RunPayload(',
    "runPayload(payload)", 'format5RunPayload({subtitlesIntent: built.intent}', 'async function saveFormat5Subtitle(intent: SubtitleIntent)',
    'format5ClipPropertyEdit(clipId, \'transform\'', 'format5ClipPropertyEdit(clipId, \'transition\'',
    'timelineCrossfadeEnvelopes(outgoing as never, incoming as never)',
    'loudnessContext={clipLoudnessContext as never}',
    "function clipLoudnessContext(): TimelineClipLoudnessContext | undefined",

    'submit: format5 ? saveFormat5Subtitle : saveSubtitle',
  ]) assert.ok(app.includes(fragment), fragment);
  // The legacy RPC must not be reachable from the format-5 inspector save path.
  const saveStart = app.indexOf('async function format5SaveInspectorClip');
  const saveEnd = app.indexOf('\n  async function', saveStart + 20);
  const saveBody = app.slice(saveStart, saveEnd > saveStart ? saveEnd : saveStart + 4000);
  assert.ok(saveStart >= 0 && saveBody.includes('format5ClipInspectorEdit('));
  assert.doesNotMatch(saveBody, /mutateTimeline\(/u, 'format-5 inspector save must not call the legacy mutation');
  const session = readFileSync(path.join(root, 'apps/web/src/edit-ui/session.ts'), 'utf8');
  assert.match(session, /async runPayload\(payload: Readonly<Record<string, unknown>>\): Promise<SequenceOutcome>/u);
});

test('the production shell routes clip sound through the shared format-5 entry', () => {
  const app = readFileSync(path.join(root, 'apps/web/src/App.tsx'), 'utf8');
  for (const fragment of [
    "import TimelineClipContextMenu from './TimelineClipContextMenu.tsx'",
    "import ClipAudioTaskToast from './ClipAudioTaskToast.tsx'",
    'function openClipContextMenu(',
    'async function format5SeparateClipSound(',
    'async function format5ToggleClipMute(',
    'async function saveClipAudioAsset(',
    'async function retryClipAudioAsset(',
    'soundIntent: {side: \'timeline\', operation: {kind: \'separate-sound\'',
    'format5={format5 && !clipInspectorRetained}',
    'onSeparateSound={clipInspectorRetained ? undefined :',
    'onClipContextMenu={openClipContextMenu}',
    "rpc('clip.audio.export.get'",
    "rpc('export.cancel'",
    "data.exports.filter(item => item.mode === 'clip-audio')",
  ]) assert.ok(app.includes(fragment), fragment);
  const timeline = readFileSync(path.join(root, 'apps/web/src/Timeline.tsx'), 'utf8');
  for (const fragment of ['onClipContextMenu?.(clip.id', 'data-testid="clip-mute-mark"', "clip.soundOnly === true ? 'audio'"])
    assert.ok(timeline.includes(fragment), fragment);
  const inspector = readFileSync(path.join(root, 'apps/web/src/TimelineInspector.tsx'), 'utf8');
  for (const fragment of ['clipSoundEntriesVisible', 'data-testid="clip-mute-toggle"', 'data-testid="clip-audio-actions"',
    'onSeparateSound(clip.id)', 'onSaveClipAudio(clip.id)'])
    assert.ok(inspector.includes(fragment), fragment);
});

test('F6 anchor conflict names colliding clip or cue, highlights affected IDs, and falls back when unmatched', async () => {
  const tl = {
    clips: [
      {id: 'clip-1', name: '开场镜头', assetId: 'asset-1'},
      {id: 'clip-2', name: '', assetId: 'asset-2'},
    ],
    subtitles: {cues: [{id: 'cue-1', text: '雨夜脚步声'}]},
  };
  const assets = [{id: 'asset-1', name: 'opening.mp4'}, {id: 'asset-2', name: '背景音乐.mp3'}];
  const tZh = (key: string, params?: Record<string, unknown>) => translate('zh-Hans', key as never, params as never);

  const singleClip = format5AnchorConflictPresentation(['clip-1'], tl, assets, tZh);
  assert.equal(singleClip.message, '会和「开场镜头」重叠，先挪开再试。');
  assert.deepEqual(singleClip.highlightIds, ['clip-1']);

  const multiple = format5AnchorConflictPresentation(['clip-1', 'clip-2', 'clip-1'], tl, assets, tZh);
  assert.equal(multiple.message, '会和「开场镜头」等 2 段重叠，先挪开再试。');
  assert.deepEqual(multiple.highlightIds, ['clip-1', 'clip-2']);

  const singleCue = format5AnchorConflictPresentation(['cue-1'], tl, assets, tZh);
  assert.equal(singleCue.message, '会和「雨夜脚步声」重叠，先挪开再试。');
  assert.deepEqual(singleCue.highlightIds, ['cue-1']);

  const unmatched = format5AnchorConflictPresentation(['track-v2'], tl, assets, tZh);
  assert.equal(unmatched.message, translate('zh-Hans', 'editUi.error.SEQUENCE_EDIT_ANCHOR_CONFLICT'));
  assert.deepEqual(unmatched.highlightIds, []);

  for (const locale of LOCALES) {
    assert.ok(translate(locale, 'editUi.error.SEQUENCE_EDIT_ANCHOR_CONFLICT_ONE', {name: 'Clip A'}).includes('Clip A'), locale);
    assert.ok(translate(locale, 'editUi.error.SEQUENCE_EDIT_ANCHOR_CONFLICT_MANY', {name: 'Clip A', count: 2}).includes('2'), locale);
  }

  // Preview preserves conflict ids on both structured refusal and thrown ApiError.
  const session = new Format5EditSession(async () => {
    throw Object.assign(new Error('conflict'), {code: 'SEQUENCE_EDIT_ANCHOR_CONFLICT', details: {ids: ['clip-1', 'cue-1']}});
  }, () => 'project-1');
  const outcome = await session.preview({kind: 'clip-move', clipId: 'clip-0', beforeClipId: null});
  assert.equal('ok' in outcome && outcome.ok === false, true);
  if ('ok' in outcome && !outcome.ok) {
    assert.equal(outcome.code, 'SEQUENCE_EDIT_ANCHOR_CONFLICT');
    assert.deepEqual(outcome.ids, ['clip-1', 'cue-1']);
  }
});

test('F3, F4, F7, and F8 shell behaviors and four-locale copy meet specification', () => {
  const app = readFileSync(path.join(root, 'apps/web/src/App.tsx'), 'utf8');
  // F3: a generation submission stays in the panel, including an unconfirmed submission.
  const submitStart = app.indexOf('const submitGeneration = async');
  const submitEnd = app.indexOf('\n  function generate(', submitStart);
  const submitBody = app.slice(submitStart, submitEnd);
  assert.match(submitBody, /status === 'submission_unknown'/u);
  assert.match(submitBody, /shell\.generationUnconfirmed/u);
  assert.doesNotMatch(submitBody, /openTasks\(/u);

  // F4: cost confirmation uses size="confirm" dialog with cancel + confirm buttons and no internal IDs or disclaimer paragraphs.
  const confirmStart = app.indexOf('data-testid="generation-confirm-dialog"');
  assert.ok(confirmStart > 0);
  const confirmSlice = app.slice(confirmStart - 160, confirmStart + 4500);
  assert.match(confirmSlice, /size="confirm"/u);
  assert.match(confirmSlice, /data-testid="cancel-live-generation"/u);
  assert.match(confirmSlice, /data-testid="confirm-live-generation"/u);
  assert.equal(confirmSlice.includes("t('video.providers.connection')"), false);
  assert.equal(confirmSlice.includes("t('video.providers.revision')"), false);
  assert.equal(confirmSlice.includes("t('shell.generationBudgetScope')"), false);
  assert.equal(confirmSlice.includes("t('shell.generationUnknownNoRetry')"), false);

  // F7: previs inspector empty states contain only the empty-state phrase, no instructional follow-up.
  assert.equal(translate('zh-Hans', 'previs.inspector.noKeyframes'), '还没有关键帧');
  assert.equal(translate('zh-Hans', 'previs.inspector.notConnected'), '还没有连接镜头');
  for (const locale of LOCALES) {
    assert.equal(translate(locale, 'previs.inspector.noKeyframes').includes('K'), false, locale);
    assert.equal(translate(locale, 'previs.inspector.notConnected').includes('。'), false, locale);
    assert.equal(translate(locale, 'previs.inspector.notConnected').includes('.'), false, locale);
  }

  // F8: home window-close confirmation button says "Close anyway" (仍然关闭), not "Quit anyway".
  assert.equal(translate('zh-Hans', 'native.unknownQuit'), '仍然关闭');
  assert.equal(translate('zh-Hant', 'native.unknownQuit'), '仍然關閉');
  assert.equal(translate('en', 'native.unknownQuit'), 'Close anyway');
  assert.equal(translate('ja', 'native.unknownQuit'), 'それでも閉じる');
});
