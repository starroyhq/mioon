import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {
  format5ClipInspectorEdit, format5ClipPropertyEdit, format5ConflictIds, format5MoveBeforeClipId,
  format5PanelErrorKey, format5PropertiesIntent, format5SubtitleEdit, splitFormat5ClipPatch,
} from '../apps/web/src/edit-ui/format5-panel-edits.ts';
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

test('the production shell routes format-5 panel edits through the shared entry', () => {
  const app = readFileSync(path.join(root, 'apps/web/src/App.tsx'), 'utf8');
  for (const fragment of [
    "from './edit-ui/format5-panel-edits.ts'",
    'format5ClipInspectorEdit(', 'format5PropertiesAction(', 'format5RunPayload(',
    "runPayload(payload)", 'format5RunPayload({subtitlesIntent: built.intent}', 'saveFormat5Subtitle(intent, live)',
    'format5ClipPropertyEdit(clipId, \'transform\'', 'format5ClipPropertyEdit(clipId, \'transition\'',
    'timelineCrossfadeEnvelopes(outgoing as never, incoming as never)',
    'loudnessContext={clipLoudnessContext as never}',
    "function clipLoudnessContext(): TimelineClipLoudnessContext | undefined",
    'if (format5) return undefined;',
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
