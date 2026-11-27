import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync, rmSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {build} from 'esbuild';
import {LOCALES, renderMessage, translate} from '../packages/i18n/src/index.ts';
import type {Locale} from '../packages/i18n/src/index.ts';
import {Format5EditSession, format5CommandErrorMessageKey, format5CopyAsNewShotCommand} from '../apps/web/src/edit-ui/session.ts';
import {format5DialogueConflictPresentation, format5PanelErrorKey} from '../apps/web/src/edit-ui/format5-panel-edits.ts';
import {timelineHistoryOperationMessage} from '../apps/web/src/timeline-history.ts';
import {BOARD_IDS, createBoardUiWireFixture} from './helpers/board-ui-wire-fixture.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
interface MenuRenderer {
  renderClipMenu(locale: Locale, options: {
    sound: boolean;
    muted?: boolean;
    copyAsNewShot?: boolean;
    generate?: boolean;
  }): string;
}

let cachedRenderer: Promise<MenuRenderer> | undefined;
function menuRenderer(): Promise<MenuRenderer> {
  return cachedRenderer ??= (async () => {
    const entry = `import React from 'react';
      import {renderToStaticMarkup} from 'react-dom/server';
      import {I18nProvider, createLanguageStore} from './src/i18n/I18nProvider.tsx';
      import TimelineClipContextMenu from './src/TimelineClipContextMenu.tsx';
      const noop = () => undefined;
      export function renderClipMenu(locale, options) {
        const plan = {sound: options.sound, saveAudio: options.sound, muteLabelKey: options.muted ? 'clipSound.unmute' : 'clipSound.mute'};
        return renderToStaticMarkup(
          <I18nProvider store={createLanguageStore({systemLanguages: [locale]})}>
            <TimelineClipContextMenu
              anchor={{clipId: 'clip-1', x: 24, y: 24}}
              plan={plan}
              canSplit
              busy={false}
              onSplit={noop}
              {...(options.copyAsNewShot ? {onCopyAsNewShot: noop} : {})}
              onToggleMute={noop}
              onSeparate={noop}
              onSaveAudio={noop}
              {...(options.generate ? {onGenerateBefore: noop, onGenerateAfter: noop} : {})}
              onClose={noop}
            />
          </I18nProvider>,
        );
      }`;
    const result = await build({
      stdin: {contents: entry, loader: 'tsx', resolveDir: path.join(root, 'apps/web')},
      bundle: true, format: 'cjs', platform: 'node', write: false, jsx: 'automatic',
      loader: {'.css': 'empty'}, define: {'process.env.NODE_ENV': '"production"'}, logLevel: 'silent',
    });
    const mod = {exports: {}};
    Function('require', 'module', 'exports', result.outputFiles[0]!.text)(createRequire(import.meta.url), mod, mod.exports);
    return mod.exports as MenuRenderer;
  })();
}

test('clip context menu places copy-as-new-shot after split and before sound group in all four locales', async () => {
  const {renderClipMenu} = await menuRenderer();
  const labels: Record<Locale, string> = {
    'zh-Hans': '复制成新镜头',
    'zh-Hant': '複製成新鏡頭',
    en: 'Copy as new shot',
    ja: '新しいショットとして複製',
  };
  for (const locale of LOCALES) {
    const mainMenu = renderClipMenu(locale, {sound: true, copyAsNewShot: true, generate: true});
    assert.ok(mainMenu.includes('data-testid="clip-menu-copy-new-shot"'), locale);
    assert.ok(mainMenu.includes(`>${labels[locale]}</span>`), `${locale}: ${labels[locale]}`);
    const copyStart = mainMenu.indexOf('data-testid="clip-menu-copy-new-shot"');
    const copyButton = mainMenu.slice(copyStart, mainMenu.indexOf('</button>', copyStart));
    assert.ok(copyButton.includes('lucide-copy'), `${locale}: leading copy icon`);
    assert.ok(copyButton.indexOf('timeline-clip-menu-icon') < copyButton.indexOf('timeline-clip-menu-label'));

    const splitPos = mainMenu.indexOf('data-testid="clip-menu-split"');
    const sepPos = mainMenu.indexOf('timeline-clip-menu-separator');
    const soundPos = mainMenu.indexOf('data-slot="sound-group"');
    const generatePos = mainMenu.indexOf('data-slot="generate-group"');
    assert.ok(splitPos > 0 && splitPos < copyStart && copyStart < sepPos && sepPos < soundPos && soundPos < generatePos,
      `${locale}: expected split < copy < separator < sound < generate`);

    // Non-main-track clip hides copy-as-new-shot completely.
    const secondaryMenu = renderClipMenu(locale, {sound: false, copyAsNewShot: false, generate: false});
    assert.equal(secondaryMenu.includes('clip-menu-copy-new-shot'), false, `${locale}: hidden on non-main track`);
    assert.equal(secondaryMenu.includes(labels[locale]), false, `${locale}: label absent on non-main track`);
  }

  // Main-track image or placeholder clip without sound or generate keeps no trailing separator.
  const mainNoSound = renderClipMenu('zh-Hans', {sound: false, copyAsNewShot: true, generate: false});
  assert.ok(mainNoSound.includes('data-testid="clip-menu-split"'));
  assert.ok(mainNoSound.includes('data-testid="clip-menu-copy-new-shot"'));
  assert.equal(mainNoSound.includes('timeline-clip-menu-separator'), false);
});

test('copy-as-new-shot command, error codes, notice and history copy cover all four locales', () => {
  const auto = format5CopyAsNewShotCommand('clip-1');
  assert.equal(auto.kind, 'clip-copy-as-new-shot');
  if (auto.kind !== 'clip-copy-as-new-shot') return;
  assert.equal(auto.clipId, 'clip-1');
  assert.notEqual(auto.newClipId, auto.copyNodeId);
  assert.match(auto.newClipId, /^[0-9a-f-]{36}$/iu);
  assert.match(auto.copyNodeId, /^[0-9a-f-]{36}$/iu);

  const errorCodes = [
    'INVALID_TRACK_TARGET',
    'CLIP_NOT_FOUND',
    'DUPLICATE_CLIP',
    'COPY_NODE_EXISTS',
    'NODE_ALREADY_LINKED',
    'SEQUENCE_EDIT_REQUEST_REUSED',
    'SEQUENCE_EDIT_ANCHOR_CONFLICT',
    'SEQUENCE_EDIT_DIALOGUE_CONFLICT',
    'SEQUENCE_EDIT_REVISION_CONFLICT',
    'SEQUENCE_EDIT_CONTRACT_INVALID',
    'SEQUENCE_EDIT_PATCH_INVALID',
  ] as const;
  for (const code of errorCodes) {
    const key = format5CommandErrorMessageKey(code);
    assert.notEqual(key, 'editUi.error.GENERIC', `${code} should map to a specific message key`);
    for (const locale of LOCALES) {
      assert.ok(translate(locale, key as never).length > 0, `${code}/${locale}`);
    }
  }

  const historyMsg = timelineHistoryOperationMessage('timeline.clip.copy-as-new-shot');
  for (const locale of LOCALES) {
    assert.ok(renderMessage(locale, historyMsg).length > 0, `history/${locale}`);
    assert.ok(translate(locale, 'editUi.notice.copiedAsNewShot', {name: '镜头 01'}).includes('镜头 01'), `notice/${locale}`);
  }
});

test('real format-5 copy-as-new-shot runs preview/commit on main-track video and placeholder clips, rejects non-main track, and undoes in one step', async () => {
  const fixture = await createBoardUiWireFixture();
  try {
    const rpc = (operation: string, input: unknown) => fixture.services.call(operation, input ?? {});
    const session = new Format5EditSession(rpc, () => fixture.projectId);

    // 1) Ready video shot on main track.
    const newClipId = '70000000-0000-4000-8000-000000009001';
    const copyNodeId = '70000000-0000-4000-8000-000000009002';
    const applied = await session.run(format5CopyAsNewShotCommand(BOARD_IDS.clipA, newClipId, copyNodeId));
    assert.equal(applied.ok, true);
    if (!applied.ok) return;
    assert.equal(applied.operation, 'timeline.clip.copy-as-new-shot');
    assert.ok(applied.actionId);

    const afterCopy = await rpc('project.get', {projectId: fixture.projectId}) as {
      shots: {id: string; title: string}[];
      timeline: {clips: {id: string; trackId: string; startFrame: number; durationFrames: number}[]};
    };
    assert.equal(afterCopy.timeline.clips.length, 3);
    const copiedClip = afterCopy.timeline.clips.find(clip => clip.id === newClipId);
    assert.ok(copiedClip, 'copied clip must exist on the timeline');
    assert.equal(copiedClip.trackId, BOARD_IDS.video);
    assert.equal(copiedClip.startFrame, 60, 'copied clip inserts immediately after clipA (0..60)');
    assert.equal(copiedClip.durationFrames, 60);
    const shiftedB = afterCopy.timeline.clips.find(clip => clip.id === BOARD_IDS.clipB);
    assert.equal(shiftedB?.startFrame, 120, 'downstream clipB shifts right');
    assert.ok(afterCopy.shots.some(shot => shot.id === copyNodeId && shot.title.includes('副本')));

    // 2) One-step undo restores exact initial timeline and board.
    const history = await session.history();
    assert.ok(history?.undo && history.undo.actionId === applied.actionId);
    const undone = await session.undo(history);
    assert.equal(undone.ok, true);
    const afterUndo = await rpc('project.get', {projectId: fixture.projectId}) as {
      shots: {id: string}[];
      timeline: {clips: {id: string; startFrame: number}[]};
    };
    assert.equal(afterUndo.timeline.clips.length, 2);
    assert.equal(afterUndo.timeline.clips.some(clip => clip.id === newClipId), false);
    assert.equal(afterUndo.timeline.clips.find(clip => clip.id === BOARD_IDS.clipB)?.startFrame, 60);
    assert.equal(afterUndo.shots.some(shot => shot.id === copyNodeId), false);

    // 3) Main-track ungenerated placeholder clip can also be copied and undone in one step.
    const placeholderClipId = '70000000-0000-4000-8000-000000009003';
    const placeholderNodeId = '70000000-0000-4000-8000-000000009004';
    const placeholderCopy = await session.run(format5CopyAsNewShotCommand(BOARD_IDS.clipB, placeholderClipId, placeholderNodeId));
    assert.equal(placeholderCopy.ok, true);
    const historyAfterPlaceholder = await session.history();
    assert.ok(historyAfterPlaceholder?.undo);
    assert.equal((await session.undo(historyAfterPlaceholder)).ok, true);

    // 4) Non-main-track clip (overlay on audio track) is rejected with INVALID_TRACK_TARGET.
    const audioClipId = '70000000-0000-4000-8000-000000009005';
    const insertAudio = await session.run({kind: 'insert-asset', assetId: BOARD_IDS.audioAsset, trackId: BOARD_IDS.audio, startFrame: 0});
    assert.equal(insertAudio.ok, true);
    const withAudio = await rpc('project.get', {projectId: fixture.projectId}) as {
      timeline: {clips: {id: string; trackId: string}[]};
    };
    const audioClip = withAudio.timeline.clips.find(clip => clip.trackId === BOARD_IDS.audio);
    assert.ok(audioClip);
    const rejected = await session.run(format5CopyAsNewShotCommand(audioClip.id, audioClipId, '70000000-0000-4000-8000-000000009006'));
    assert.equal(rejected.ok, false);
    if (!rejected.ok && !('unconfirmed' in rejected)) {
      assert.equal(rejected.code, 'INVALID_TRACK_TARGET');
    }
  } finally {
    await fixture.services.drain();
    await fixture.settings.close();
    fixture.store.close();
    fixture.library.close();
    rmSync(fixture.root, {recursive: true, force: true});
  }
});

test('App shell wires copy-as-new-shot only for main-track format-5 clips with undo notice and board refresh', () => {
  const app = readFileSync(path.join(root, 'apps/web/src/App.tsx'), 'utf8');
  const fnStart = app.indexOf('async function format5CopyClipAsNewShot(');
  const fnEnd = app.indexOf('async function format5ToggleClipMute(', fnStart);
  assert.ok(fnStart > 0 && fnEnd > fnStart);
  const fnBody = app.slice(fnStart, fnEnd);
  assert.ok(fnBody.includes('format5CopyAsNewShotCommand(clipId)'));
  assert.ok(fnBody.includes('format5Session().run('));
  assert.ok(fnBody.includes('setFormat5Notice('));
  assert.ok(fnBody.includes('setFormat5NoticeActionId(result.actionId)'));
  assert.ok(fnBody.includes('await format5LoadBoard()'));
  assert.equal(fnBody.includes('format5PasteClipCommand'), false);

  const menuCallStart = app.indexOf('<TimelineClipContextMenu anchor={clipContextMenu}');
  assert.ok(menuCallStart > 0);
  const menuCallSlice = app.slice(menuCallStart - 320, menuCallStart + 420);
  assert.ok(menuCallSlice.includes('isMainTrackClip'));
  assert.ok(menuCallSlice.includes('isMainTrackClip ? {onCopyAsNewShot:'));
  assert.ok(fnBody.includes('{copying: true}'));
  assert.ok(app.includes('format5DialogueConflictPresentation('));
  assert.ok(app.includes('data-testid="global-toast-action"'));
  assert.ok(app.includes('format5LocateSubtitleCue('));
});

test('real format-5 copy-as-new-shot preserves dialogue and projects subtitles, and returns structured blocker details on conflict', async () => {
  const fixture = await createBoardUiWireFixture();
  try {
    const rpc = (operation: string, input: unknown) => fixture.services.call(operation, input ?? {});
    const session = new Format5EditSession(rpc, () => fixture.projectId);

    // Attach two dialogue lines to shotA via real dialogueIntent.
    const line1 = '70000000-0000-4000-8000-000000008101';
    const line2 = '70000000-0000-4000-8000-000000008102';
    const addDialogue = await session.runPayload({
      dialogueIntent: {
        side: 'board',
        operation: {
          kind: 'dialogue',
          edits: [
            {kind: 'add', shotId: BOARD_IDS.shotA, line: {id: line1, text: '第一句台词'}},
            {kind: 'add', shotId: BOARD_IDS.shotA, line: {id: line2, text: '第二句台词'}},
          ],
        },
      },
    });
    assert.equal(addDialogue.ok, true);

    // Add an anchored audio clip on A1 under clipA so we verify original overlay & cues stay untouched.
    const addAudio = await session.run({kind: 'insert-asset', assetId: BOARD_IDS.audioAsset, trackId: BOARD_IDS.audio, startFrame: 0});
    assert.equal(addAudio.ok, true);

    const beforeCopy = await rpc('project.get', {projectId: fixture.projectId}) as {
      shots: {id: string; title: string; dialogue?: {id: string; text: string}[]}[];
      timeline: {clips: {id: string; trackId: string; startFrame: number}[]; subtitles?: {cues: {id: string; text: string; startFrame: number; durationFrames: number; dialogueRef?: {shotId: string; lineId: string}}[]}};
    };
    const origCues = beforeCopy.timeline.subtitles?.cues ?? [];
    assert.equal(origCues.length, 2, 'original shot dialogue projected to two cues');
    const origAudioClips = beforeCopy.timeline.clips.filter(clip => clip.trackId === BOARD_IDS.audio);
    assert.equal(origAudioClips.length, 1);

    // 1) Copy shotA: copy preserves both dialogue lines and auto-projects them into [60, 120).
    const newClipId = '70000000-0000-4000-8000-000000008201';
    const copyNodeId = '70000000-0000-4000-8000-000000008202';
    const copied = await session.run(format5CopyAsNewShotCommand(BOARD_IDS.clipA, newClipId, copyNodeId));
    assert.equal(copied.ok, true);

    const afterCopy = await rpc('project.get', {projectId: fixture.projectId}) as typeof beforeCopy;
    const copyShot = afterCopy.shots.find(shot => shot.id === copyNodeId);
    assert.ok(copyShot, 'copied shot exists on board');
    assert.deepEqual(copyShot.dialogue?.map(line => line.text), ['第一句台词', '第二句台词']);
    assert.notEqual(copyShot.dialogue?.[0]?.id, line1, 'copied dialogue lines use fresh ids');

    const cuesAfterCopy = afterCopy.timeline.subtitles?.cues ?? [];
    assert.equal(cuesAfterCopy.length, 4, 'original 2 cues + copied 2 projected cues');
    const copyCues = cuesAfterCopy.filter(cue => cue.dialogueRef?.shotId === copyNodeId);
    assert.equal(copyCues.length, 2);
    assert.ok(copyCues.every(cue => cue.startFrame >= 60 && cue.startFrame + cue.durationFrames <= 120));
    const keptOrigCues = cuesAfterCopy.filter(cue => cue.dialogueRef?.shotId === BOARD_IDS.shotA);
    assert.deepEqual(keptOrigCues.map(cue => ({id: cue.id, startFrame: cue.startFrame, text: cue.text})),
      origCues.map(cue => ({id: cue.id, startFrame: cue.startFrame, text: cue.text})));
    assert.equal(afterCopy.timeline.clips.filter(clip => clip.trackId === BOARD_IDS.audio).length, 1, 'original audio overlay untouched');

    // Undo restores timeline, board and projected cues in one step.
    const historyAfterCopy = await session.history();
    assert.ok(historyAfterCopy?.undo);
    assert.equal((await session.undo(historyAfterCopy)).ok, true);
    const afterUndo = await rpc('project.get', {projectId: fixture.projectId}) as typeof beforeCopy;
    assert.equal((afterUndo.timeline.subtitles?.cues ?? []).length, 2);
    assert.equal(afterUndo.shots.some(shot => shot.id === copyNodeId), false);

    // 2) Block the copy window [60, 119) with an unanchored subtitle cue -> SEQUENCE_EDIT_DIALOGUE_CONFLICT with blocker details.
    const blockingCueId = '70000000-0000-4000-8000-000000008301';
    const addBlocker = await session.runPayload({
      subtitlesIntent: {
        side: 'timeline',
        operation: {
          kind: 'subtitles',
          edits: [{kind: 'add', cue: {id: blockingCueId, text: '挡住副本的测试字幕一行很长很长', startFrame: 60, durationFrames: 59}}],
        },
      },
    });
    assert.equal(addBlocker.ok, true);
    // Clear its anchor so it stays fixed at [60, 119) when clipA is copied right after [0, 60).
    fixture.store.tx(() => {
      const currentTl = fixture.store.get('timelines', BOARD_IDS.timeline) as Record<string, any>;
      currentTl.subtitles.cues = currentTl.subtitles.cues.map((cue: Record<string, unknown>) =>
        cue.id === blockingCueId ? {...cue, anchor: null} : cue);
      fixture.store.put('timelines', currentTl);
    });

    const conflictOutcome = await session.run(format5CopyAsNewShotCommand(
      BOARD_IDS.clipA,
      '70000000-0000-4000-8000-000000008203',
      '70000000-0000-4000-8000-000000008204',
    ));
    assert.equal(conflictOutcome.ok, false);
    if (conflictOutcome.ok || 'unconfirmed' in conflictOutcome) return;
    assert.equal(conflictOutcome.code, 'SEQUENCE_EDIT_DIALOGUE_CONFLICT');
    assert.ok(conflictOutcome.dialogueConflict, 'session must preserve dialogueConflict payload');
    assert.equal(conflictOutcome.dialogueConflict.blockerCount, 1);
    assert.equal(conflictOutcome.dialogueConflict.blockers[0]?.cueId, blockingCueId);
    assert.equal(conflictOutcome.dialogueConflict.blockers[0]?.startFrame, 60);
    assert.equal(conflictOutcome.dialogueConflict.blockers[0]?.endFrame, 119);

    const tlNow = (await rpc('project.get', {projectId: fixture.projectId}) as typeof beforeCopy).timeline;
    const tZh = (key: string, params?: Record<string, unknown>) => translate('zh-Hans', key as never, params as never);
    const presentation = format5DialogueConflictPresentation(conflictOutcome.dialogueConflict, tlNow, tZh, {copying: true});
    assert.equal(
      presentation.message,
      '副本的台词放不进去：这段时间已有字幕「挡住副本的测试字幕一行很…」，先挪开或删掉再复制。',
    );
    assert.deepEqual(presentation.highlightIds, [blockingCueId]);
    assert.deepEqual(presentation.locateCue, {cueId: blockingCueId, startFrame: 60});
  } finally {
    await fixture.services.drain();
    await fixture.settings.close();
    fixture.store.close();
    fixture.library.close();
    rmSync(fixture.root, {recursive: true, force: true});
  }
});

test('dialogue conflict presentation covers all four locales, multi-blocker, insufficient space, and bare error fallback', async () => {
  assert.equal(format5CommandErrorMessageKey('SEQUENCE_EDIT_DIALOGUE_CONFLICT'), 'editUi.error.SEQUENCE_EDIT_DIALOGUE_CONFLICT');
  assert.equal(format5PanelErrorKey('SEQUENCE_EDIT_DIALOGUE_CONFLICT'), 'editUi.error.SEQUENCE_EDIT_DIALOGUE_CONFLICT');

  for (const locale of LOCALES) {
    const tLoc = (key: string, params?: Record<string, unknown>) => translate(locale, key as never, params as never);
    assert.ok(tLoc('editUi.error.locateSubtitle').length > 0, `locateSubtitle/${locale}`);

    const one = format5DialogueConflictPresentation({
      blockers: [{cueId: 'cue-1', startFrame: 60, endFrame: 119, textExcerpt: '挡住字幕'}],
      blockerCount: 1, requiredFrames: 2, availableFrames: 1,
    }, null, tLoc, {copying: true});
    assert.ok(one.message.includes('挡住字幕'), `one/${locale}`);
    assert.deepEqual(one.highlightIds, ['cue-1']);
    assert.deepEqual(one.locateCue, {cueId: 'cue-1', startFrame: 60});

    const many = format5DialogueConflictPresentation({
      blockers: [
        {cueId: 'cue-1', startFrame: 60, endFrame: 90, textExcerpt: '第一条'},
        {cueId: 'cue-2', startFrame: 90, endFrame: 120, textExcerpt: '第二条'},
      ],
      blockerCount: 2, requiredFrames: 2, availableFrames: 0,
    }, null, tLoc, {copying: true});
    assert.ok(many.message.includes('第一条') && many.message.includes('2'), `many/${locale}`);
    assert.deepEqual(many.highlightIds, ['cue-1', 'cue-2']);
    assert.deepEqual(many.locateCue, {cueId: 'cue-1', startFrame: 60});

    const space = format5DialogueConflictPresentation({
      blockers: [], blockerCount: 0, requiredFrames: 2, availableFrames: 1,
    }, null, tLoc, {copying: true});
    assert.ok(space.message.includes('2') && space.message.includes('1'), `space/${locale}`);
    assert.deepEqual(space.highlightIds, []);
    assert.equal(space.locateCue, null);

    const bare = format5DialogueConflictPresentation(undefined, null, tLoc, {copying: true});
    assert.notEqual(bare.message, tLoc('editUi.error.GENERIC'), `bare/${locale} must not fall back to generic error`);
    assert.equal(bare.locateCue, null);

    const nonCopy = format5DialogueConflictPresentation({
      blockers: [{cueId: 'cue-1', startFrame: 10, endFrame: 40, textExcerpt: '已有'}],
      blockerCount: 1, requiredFrames: 2, availableFrames: 0,
    }, null, tLoc, {copying: false});
    assert.ok(nonCopy.message.includes('已有'), `nonCopy/${locale}`);
  }

  // Thrown ApiError carrying details.dialogueConflict is also preserved by Format5EditSession.
  const thrownSession = new Format5EditSession(async () => {
    throw Object.assign(new Error('conflict'), {
      code: 'SEQUENCE_EDIT_DIALOGUE_CONFLICT',
      details: {
        ids: ['shot-copy'],
        dialogueConflict: {
          blockers: [{cueId: 'cue-9', startFrame: 30, endFrame: 90, textExcerpt: '拦截字幕'}],
          blockerCount: 1, requiredFrames: 2, availableFrames: 0,
        },
      },
    });
  }, () => 'project-1');
  const thrownOutcome = await thrownSession.runPayload({intents: []});
  assert.equal(thrownOutcome.ok, false);
  if (!thrownOutcome.ok && !('unconfirmed' in thrownOutcome)) {
    assert.equal(thrownOutcome.code, 'SEQUENCE_EDIT_DIALOGUE_CONFLICT');
    assert.equal(thrownOutcome.dialogueConflict?.blockers[0]?.cueId, 'cue-9');
  }
});
