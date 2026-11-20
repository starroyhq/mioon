import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {build} from 'esbuild';
import {LOCALES} from '../packages/i18n/src/index.ts';
import type {Locale} from '../packages/i18n/src/index.ts';

interface Modules {
  renderTimeline(locale: Locale, scenario: 'main' | 'removed', withProjection: boolean): string;
  renderBar(locale: Locale, mode: 'follow' | 'locked'): string;
  renderDialog(locale: Locale): string;
  renderNotice(locale: Locale): string;
  renderUnconfirmed(locale: Locale): string;
  renderDetached(locale: Locale): string;
  renderSuffix(locale: Locale, kind: 'follow' | 'locked' | 'placeholder'): string;
  versionChoice(mode: 'follow' | 'locked'): {mode: string; versionId: string | null};
  versionLabel(locale: Locale, mode: 'follow' | 'locked'): string;
  pickerLabel(locale: Locale, trackId: string): string;
  renderInspector(locale: Locale, withSequence: boolean): string;
  keyAction(key: string, focused: 'confirm' | 'cancel' | null): string | null;
  noticeReducer(state: {notice: {id: string; message: string} | null}, action: {type: string; notice?: {id: string; message: string}; id?: string}): {notice: {id: string; message: string} | null};
  trackBadge(trackId: string): string | null;
}
const root = fileURLToPath(new URL('../', import.meta.url));
let loaded: Promise<Modules> | undefined;

function modules(): Promise<Modules> {
  return loaded ??= (async () => {
    const entry = `import React from 'react';
      import {renderToStaticMarkup} from 'react-dom/server';
      import Timeline from './src/Timeline.tsx';
      import {I18nProvider,createLanguageStore} from './src/i18n/I18nProvider.tsx';
      import {timelineHistoryState} from './src/timeline-history.ts';
      import {timelineSplitState} from './src/timeline-split.ts';
      import {projectEditUi, editUiTrackBadge} from './src/edit-ui/projection.ts';
      import ShotVersionBar from './src/edit-ui/ShotVersionBar.tsx';
      import CopyMoveConfirmDialog, {editUiCopyMoveKeyAction} from './src/edit-ui/CopyMoveConfirmDialog.tsx';
      import EditUiNoticeBar, {editUiNoticeReducer, EditUiUnknownBar} from './src/edit-ui/EditUiNotice.tsx';
      import {EditUiDetachedAnchor} from './src/edit-ui/anchors.tsx';
      import {EditUiClipTitle, editUiVersionChoice, editUiVersionLabel, editUiTrackPickerLabel} from './src/edit-ui/status.tsx';
      import TimelineInspector from './src/TimelineInspector.tsx';
      import {translate} from '../../packages/i18n/src/index.ts';
      import {ConfirmationProvider} from '@mioon/ui/components/workbench-confirm';
      import {fixtureTimeline, fixtureAssets, COPY_MOVE_REQUEST, FIXTURE_PROJECT_ID, FIXTURE_TIMELINE_ID, FIXTURE_SELECTED_CLIP_ID, FIXTURE_PLAYHEAD, REMOVED_SHOT_NAME} from '../../tests/fixtures/edit-ui-static/scenes.ts';
      const history = {projectId: FIXTURE_PROJECT_ID, timelineId: FIXTURE_TIMELINE_ID, revision: 7, cursor: 1, length: 3,
        canUndo: true, canRedo: true, undoEntry: {id: 'e1', operation: 'timeline.clip.update'}, redoEntry: {id: 'e2', operation: 'timeline.clip.update'}};
      const timelineFor = scenario => fixtureTimeline(scenario);
      const projectionFor = timeline => projectEditUi({fps: timeline.fps, timelineRevision: timeline.revision, syncRevision: 9,
        mainTrack: {trackId: 'track-main', sequenceNodeId: 'shot-02'}, tracks: timeline.tracks, clips: timeline.clips, cues: timeline.subtitles.cues});
      const wrap = (locale, content) => renderToStaticMarkup(<I18nProvider store={createLanguageStore({systemLanguages: [locale]})}>{content}</I18nProvider>);
      const noop = () => undefined;
      export function renderTimeline(locale, scenario, withProjection) {
        const timeline = timelineFor(scenario), historyState = timelineHistoryState({projectId: FIXTURE_PROJECT_ID, timeline, history});
        const splitState = timelineSplitState({projectId: FIXTURE_PROJECT_ID, timeline, history, selectedClipId: FIXTURE_SELECTED_CLIP_ID, playhead: FIXTURE_PLAYHEAD, mode: 'editing'});
        return wrap(locale, <Timeline timeline={timeline} assets={fixtureAssets(false)} historyState={historyState} splitState={splitState}
          editUiProjection={withProjection ? projectionFor(timeline) : null} onHistory={noop} onSplit={noop} onSelectSubtitle={noop}
          onAddSubtitle={noop} onSelectClip={noop} onAddAsset={noop} onMoveClip={noop} onTrackAdd={noop} onTrackUpdate={noop}
          onSeed={noop} onRender={noop} onSeek={noop} onCollapse={noop} playhead={FIXTURE_PLAYHEAD}
          selectedClipId={FIXTURE_SELECTED_CLIP_ID} selectedCueId={null} collapsed={false}
          viewState={{pixelsPerSecond: 46, scrollLeft: 0, scrollTop: 0, snappingEnabled: true}} />);
      }
      export function renderBar(locale, mode) {
        return wrap(locale, <ShotVersionBar sequence={{mainTrackId: 'track-main', shotNumber: '02', shotName: '窗口剪影', versionMode: mode,
          boardVersion: {id: 'version-2', number: 2}, appliedVersion: {id: 'version-1', number: 1}, onRevealShot: noop, onVersionChoice: noop}} />);
      }
      export function renderDialog(locale) {
        return wrap(locale, <CopyMoveConfirmDialog request={COPY_MOVE_REQUEST} onConfirm={noop} onCancel={noop} />);
      }
      export function renderUnconfirmed(locale) {
        return wrap(locale, <EditUiUnknownBar view={{projectId: 'p', requestId: 'preview-1'}} onRetry={noop} onAbandon={noop} />);
      }
      export function renderNotice(locale) {
        const message = '已从主轨移除 ' + REMOVED_SHOT_NAME;
        return wrap(locale, <EditUiNoticeBar notice={{id: 'notice-1', message}} onUndo={noop} onDismiss={noop} />);
      }
      export function renderDetached(locale) {
        return wrap(locale, <EditUiDetachedAnchor left={120} testId="edit-ui-detached-cue-cue-2" />);
      }
      export function renderSuffix(locale, kind) {
        const status = kind === 'placeholder' ? {kind, durationSeconds: 4} : {kind, version: kind === 'locked' ? {id: 'version-1', number: 1} : {id: 'version-2', number: 2}};
        return wrap(locale, <EditUiClipTitle title="02 窗口剪影" status={status} />);
      }
      export const versionChoice = mode => editUiVersionChoice({boardVersion: {id: 'version-2', number: 2}, appliedVersion: {id: 'version-1', number: 1}}, mode);
      export const pickerLabel = (locale, trackId) => editUiTrackPickerLabel((key, params) => translate(locale, key, params), timelineFor('main').tracks.find(track => track.id === trackId), timelineFor('main').tracks, 'track-main');
      export function renderInspector(locale, withSequence) {
        const timeline = timelineFor('main'), clip = timeline.clips.find(item => item.id === FIXTURE_SELECTED_CLIP_ID);
        const sequence = withSequence ? {mainTrackId: 'track-main', shotNumber: '02', shotName: '窗口剪影', versionMode: 'follow',
          boardVersion: {id: 'version-2', number: 2}, appliedVersion: {id: 'version-1', number: 1}, onRevealShot: noop, onVersionChoice: noop} : null;
        return renderToStaticMarkup(<I18nProvider store={createLanguageStore({systemLanguages: [locale]})}><ConfirmationProvider labels={{title: '确认', cancel: '取消', continue: '继续'}} renderMessage={value => String(value ?? '')}><TimelineInspector clip={clip} timeline={timeline} asset={fixtureAssets(false)[0]} onSave={async () => undefined}
          sequence={sequence} draftConnected={false} /></ConfirmationProvider></I18nProvider>);
      }
      export const versionLabel = (locale, mode) => editUiVersionLabel((key, params) => translate(locale, key, params), mode, {boardVersion: {id: 'version-2', number: 2}, appliedVersion: {id: 'version-1', number: 1}});
      export const keyAction = editUiCopyMoveKeyAction;
      export const noticeReducer = editUiNoticeReducer;
      export const trackBadge = trackId => editUiTrackBadge(timelineFor('main').tracks, trackId);
      `;
    const result = await build({stdin: {contents: entry, loader: 'tsx', resolveDir: path.join(root, 'apps/web')}, bundle: true,
      format: 'cjs', platform: 'node', write: false, jsx: 'automatic', loader: {'.css': 'empty'},
      define: {'process.env.NODE_ENV': '"production"'}, logLevel: 'silent'});
    const module = {exports: {}};
    Function('require', 'module', 'exports', result.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
    return module.exports as Modules;
  })();
}

const SUFFIX = {
  'zh-Hans': {'follow': '· V2', 'locked': '· 锁定 V1', 'placeholder': '· 待生成（占位 4 秒）'},
  'zh-Hant': {'follow': '· V2', 'locked': '· 鎖定 V1', 'placeholder': '· 待生成（佔位 4 秒）'},
  en: {'follow': '· V2', 'locked': '· Locked V1', 'placeholder': '· Not generated (4 s placeholder)'},
  ja: {'follow': '· V2', 'locked': '· ロック V1', 'placeholder': '· 未生成（4 秒のプレースホルダー）'},
} as const;

test('the timeline renders the main-track marker and three clip status suffixes only when a projection is passed', async () => {
  const ui = await modules();
  const withProjection = ui.renderTimeline('zh-Hans', 'main', true);
  for (const text of ['主轨', 'data-main-track="true"', '· V2', '· 锁定 V1', '· 待生成（占位 4 秒）', 'edit-ui-placeholder']) {
    assert.ok(withProjection.includes(text), text);
  }
  assert.match(withProjection, /data-testid="edit-ui-anchor-layer" data-anchor-count="3"/u);
  const ids = /data-anchor-ids="([^"]+)"/u.exec(withProjection)?.[1]?.split(',') ?? [];
  assert.deepEqual(ids.sort(), ['clip:clip-overlay:clip-03:510', 'cue:cue-1:clip-01:30', 'cue:cue-2:clip-02:300']);
  assert.ok(!withProjection.includes('edit-ui-detached'), 'attached anchors must not show the detached label');
  const withoutProjection = ui.renderTimeline('zh-Hans', 'main', false);
  assert.ok(!withoutProjection.includes('edit-ui-'), 'the default timeline must not carry any UI-E1 marker');
  assert.ok(!withoutProjection.includes('data-main-track'), 'the default timeline must not claim a main track');
  assert.ok(!withoutProjection.includes('· V2'), 'the default timeline must not invent version suffixes');
});

test('the detached label appears in place for a broken anchor and the anchor layer keeps only attached links', async () => {
  const ui = await modules();
  const html = ui.renderTimeline('zh-Hans', 'removed', true);
  assert.match(html, /data-testid="edit-ui-detached-cue-cue-2"/u);
  assert.match(html, /未挂靠/u);
  assert.match(html, /data-testid="edit-ui-anchor-layer" data-anchor-count="2"/u);
});

test('all four languages localise the clip suffix, main track and detached label', async () => {
  const ui = await modules();
  for (const locale of LOCALES) {
    for (const kind of ['follow', 'locked', 'placeholder'] as const) {
      const html = ui.renderSuffix(locale, kind);
      assert.ok(html.includes(SUFFIX[locale][kind]), `${locale}/${kind}: ${html}`);
    }
    const timeline = ui.renderTimeline(locale, 'main', true);
    assert.ok(timeline.includes(locale === 'en' ? '>Main track<' : locale === 'ja' ? '>メイントラック<' : locale === 'zh-Hant' ? '主軌' : '主轨'));
    const removed = ui.renderTimeline(locale, 'removed', true);
    assert.ok(removed.includes(locale === 'en' ? 'Not anchored' : locale === 'ja' ? '未接続' : locale === 'zh-Hant' ? '未掛靠' : '未挂靠'));
    const detached = ui.renderDetached(locale);
    assert.ok(detached.includes(locale === 'en' ? 'Not anchored' : locale === 'ja' ? '未接続' : locale === 'zh-Hant' ? '未掛靠' : '未挂靠'));
  }
});

test('the properties version bar shows follow/locked text and the lock state without hidden copy', async () => {
  const ui = await modules();
  for (const locale of LOCALES) {
    const follow = ui.renderBar(locale, 'follow');
    assert.equal(ui.versionLabel(locale, 'follow'), locale === 'en' ? 'Follow board · V2' : locale === 'ja' ? 'ボードに追従 · V2' : locale === 'zh-Hant' ? '跟隨畫板 · V2' : '跟随画板 · V2');
    assert.equal(ui.versionLabel(locale, 'locked'), locale === 'en' ? 'Locked · V1' : locale === 'ja' ? 'ロック · V1' : locale === 'zh-Hant' ? '鎖定 · V1' : '锁定 · V1');
    assert.match(follow, /data-testid="edit-ui-version-select"/u);
    assert.match(follow, /data-testid="edit-ui-version-lock"/u);
    assert.match(follow, /aria-pressed="false"/u);
    assert.ok(follow.includes(locale === 'en' ? 'View on board ↗' : locale === 'ja' ? 'ボードで表示 ↗' : locale === 'zh-Hant' ? '在畫板中查看 ↗' : '在画板中查看 ↗'));
    const locked = ui.renderBar(locale, 'locked');
    assert.match(locked, /aria-pressed="true"/u);
    assert.ok(!/会新建|will create|作成します/u.test(locked), 'no explanatory sentence');
  }
  assert.deepEqual(ui.versionChoice('follow'), {mode: 'follow', versionId: 'version-2'});
  assert.deepEqual(ui.versionChoice('locked'), {mode: 'locked', versionId: 'version-1'});
  for (const locale of LOCALES) {
    assert.equal(ui.pickerLabel(locale, 'track-main'), locale === 'en' ? 'V1 · Main track' : locale === 'ja' ? 'V1 · メイントラック' : locale === 'zh-Hant' ? 'V1 · 主軌' : 'V1 · 主轨');
    const overlay = {'zh-Hans': '叠加', 'zh-Hant': '疊加', en: 'Overlay', ja: 'オーバーレイ'} as const;
    assert.equal(ui.pickerLabel(locale, 'track-overlay'), overlay[locale]);
    const music = {'zh-Hans': '音乐', 'zh-Hant': '音樂', en: 'Music', ja: '音楽'} as const;
    assert.equal(ui.pickerLabel(locale, 'track-audio'), music[locale]);
  }
  assert.equal(ui.trackBadge('track-main'), 'V1');
  assert.equal(ui.trackBadge('track-overlay'), 'V2');
  assert.equal(ui.trackBadge('track-audio'), null);
});

test('the properties panel renders the shot block only when the sequence presentation is passed', async () => {
  const ui = await modules();
  const withSequence = ui.renderInspector('zh-Hans', true);
  assert.match(withSequence, /data-testid="edit-ui-shot-bar"/u);
  assert.match(withSequence, /data-testid="edit-ui-shot-name"/u);
  assert.ok(withSequence.includes('镜头 02 · 窗口剪影'));
  assert.match(withSequence, /data-testid="edit-ui-version-lock"/u);
  assert.match(withSequence, /data-testid="edit-ui-version-select"/u);
  const withoutSequence = ui.renderInspector('zh-Hans', false);
  assert.ok(!withoutSequence.includes('edit-ui-shot-bar'), 'default inspector must not gain the UI-E1 block');
});

test('the copy-and-move confirmation renders only its title and two buttons', async () => {
  const ui = await modules();
  const html = ui.renderDialog('zh-Hans');
  assert.ok(html.includes('复制成新镜头再挪？'));
  assert.ok(html.includes('取消') && html.includes('复制并挪动'));
  assert.ok(!html.includes('会新建'), 'the explanatory sentence from the design is omitted');
  assert.equal((html.match(/<button/gu) ?? []).length, 2);
  assert.equal(ui.keyAction('Enter', 'confirm'), 'confirm');
  assert.equal(ui.keyAction('Enter', 'cancel'), 'cancel');
  assert.equal(ui.keyAction('Escape', 'confirm'), 'cancel');
  assert.equal(ui.keyAction('Tab', null), 'focus-next');
  assert.equal(ui.keyAction('Tab', 'confirm'), 'focus-previous');
  assert.equal(ui.keyAction('a', 'confirm'), null);
});

test('the undo notice shows one result with undo and dismiss controls', async () => {
  const ui = await modules();
  const html = ui.renderNotice('zh-Hans');
  assert.ok(html.includes('已从主轨移除 02 窗口剪影'));
  assert.ok(html.includes('撤销'), 'undo action');
  assert.match(html, /aria-label="关闭"/u);
});

test('a newer undo notice replaces the previous one and stale dismissals do not close it', async () => {
  const ui = await modules();
  const first = {id: 'notice-1', message: 'first'}, second = {id: 'notice-2', message: 'second'};
  let state = {notice: null as {id: string; message: string} | null};
  state = ui.noticeReducer(state, {type: 'show', notice: first});
  state = ui.noticeReducer(state, {type: 'show', notice: second});
  assert.deepEqual(state.notice, second);
  state = ui.noticeReducer(state, {type: 'dismiss', id: 'notice-1'});
  assert.deepEqual(state.notice, second, 'a late dismissal for the older notice must not close the current one');
  state = ui.noticeReducer(state, {type: 'undo', id: 'notice-1'});
  assert.deepEqual(state.notice, second, 'a late undo for the older notice must not close the current one');
  state = ui.noticeReducer(state, {type: 'dismiss', id: 'notice-2'});
  assert.equal(state.notice, null);
  state = ui.noticeReducer(state, {type: 'show', notice: first});
  state = ui.noticeReducer(state, {type: 'undo', id: 'notice-1'});
  assert.equal(state.notice, null);
});

test('the unconfirmed bar shows the status, one reason and the two actions in all four locales', async () => {
  const ui = await modules();
  const copy = {
    'zh-Hans': ['结果未确认', '提交中断，没有收到结果。', '重试', '放弃'],
    'zh-Hant': ['結果未確認', '提交中斷，沒有收到結果。', '重試', '放棄'],
    en: ['Result unconfirmed', 'The submit was interrupted before a result came back.', 'Retry', 'Abandon'],
    ja: ['結果未確定', '送信が中断され、結果を受け取れませんでした。', '再試行', '破棄'],
  } as const;
  for (const locale of LOCALES) {
    const html = ui.renderUnconfirmed(locale);
    for (const text of copy[locale]) assert.ok(html.includes(text), `${locale}: ${text}`);
    assert.match(html, /data-testid="edit-ui-unconfirmed-bar"/u);
    assert.match(html, /data-testid="edit-ui-unconfirmed-retry"/u);
    assert.match(html, /data-testid="edit-ui-unconfirmed-abandon"/u);
    assert.equal((html.match(/<button/gu) ?? []).length, 2, 'exactly the two recovery actions');
  }
});

test('the unconfirmed bar has no dismiss control and no explanatory copy', async () => {
  const ui = await modules();
  const html = ui.renderUnconfirmed('zh-Hans');
  assert.ok(!html.includes('edit-ui-notice-dismiss'), 'an unconfirmed result cannot be dismissed silently');
  assert.ok(!/不会|不受影响|will not|not affected/u.test(html), 'no reassuring explanatory sentence');
  assert.equal((html.match(/<button/gu) ?? []).length, 2);
});
