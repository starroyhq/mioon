/** UI-E1 static fixture: assembles the real editing timeline, the real optional
 * projection components and a synthetic application shell around them. No
 * application host, project store, RPC or file write participates. */
import React, {useEffect, useLayoutEffect, useMemo, useState} from 'react';
import {createRoot} from 'react-dom/client';
import '../../../packages/ui/src/styles/globals.css';
import '../../../apps/web/src/styles.css';
import './fixture.css';
import Timeline from '../../../apps/web/src/Timeline.tsx';
import {I18nProvider, createLanguageStore, useI18n} from '../../../apps/web/src/i18n/I18nProvider.tsx';
import {timelineHistoryState} from '../../../apps/web/src/timeline-history.ts';
import {timelineSplitState} from '../../../apps/web/src/timeline-split.ts';
import {projectEditUi} from '../../../apps/web/src/edit-ui/projection.ts';
import ShotVersionBar from '../../../apps/web/src/edit-ui/ShotVersionBar.tsx';
import CopyMoveConfirmDialog from '../../../apps/web/src/edit-ui/CopyMoveConfirmDialog.tsx';
import type {EditUiCopyMoveRequest} from '../../../apps/web/src/edit-ui/CopyMoveConfirmDialog.tsx';
import EditUiNoticeBar from '../../../apps/web/src/edit-ui/EditUiNotice.tsx';
import type {EditUiNotice} from '../../../apps/web/src/edit-ui/EditUiNotice.tsx';
import type {EditUiInspectorSequence} from '../../../apps/web/src/edit-ui/status.tsx';
import {
  COPY_MOVE_REQUEST, FIXTURE_PLAYHEAD, FIXTURE_PROJECT_ID, FIXTURE_SELECTED_CLIP_ID, FIXTURE_TIMELINE_ID,
  REMOVED_SHOT_NAME, fixtureAssets, fixturePreview, fixtureThumbnails, fixtureTimeline,
} from './scenes.ts';
import type {FixtureScenario} from './scenes.ts';

type Locale = 'zh-Hans' | 'zh-Hant' | 'en' | 'ja';

interface FixtureCallbacks {
  reveals: number;
  versionChoices: {mode: string; versionId: string | null}[];
  confirmed: EditUiCopyMoveRequest[];
  cancelled: number;
  undone: string[];
  dismissed: string[];
  seeks: number[];
}
const callbacks: FixtureCallbacks = {reveals: 0, versionChoices: [], confirmed: [], cancelled: 0, undone: [], dismissed: [], seeks: []};
const language = createLanguageStore({systemLanguages: ['zh-Hans']});

const HISTORY = {
  projectId: FIXTURE_PROJECT_ID, timelineId: FIXTURE_TIMELINE_ID, revision: 7, cursor: 1, length: 3,
  canUndo: true, canRedo: true, undoEntry: {id: 'entry-1', operation: 'timeline.clip.update'},
  redoEntry: {id: 'entry-2', operation: 'timeline.clip.update'},
};

const timecode = (frame: number, fps: number): string => `${String(Math.floor(frame / fps / 3600)).padStart(2, '0')}:${String(Math.floor(frame / fps / 60) % 60).padStart(2, '0')}:${String(Math.floor(frame / fps) % 60).padStart(2, '0')}:${String(frame % fps).padStart(2, '0')}`;

function Fixture(): React.ReactElement {
  const {t} = useI18n();
  const [scenario, setScenario] = useState<FixtureScenario>('main');
  const [dialogClosed, setDialogClosed] = useState(false);
  const [motion, setMotion] = useState<'normal' | 'app' | 'prop'>('normal');
  const [pixelsPerSecond, setPixelsPerSecond] = useState(46);
  const [playhead, setPlayhead] = useState(FIXTURE_PLAYHEAD);
  const [scroll, setScroll] = useState({scrollLeft: 0, scrollTop: 0});
  const timeline = useMemo(() => fixtureTimeline(scenario), [scenario]);
  const assets = useMemo(() => fixtureAssets(false), []);
  const projection = useMemo(() => projectEditUi({fps: timeline.fps, timelineRevision: timeline.revision, syncRevision: 9,
    mainTrack: {trackId: 'track-main', sequenceNodeId: 'shot-02'},
    tracks: timeline.tracks, clips: timeline.clips, cues: timeline.subtitles.cues}), [timeline]);
  const historyState = useMemo(() => timelineHistoryState({projectId: FIXTURE_PROJECT_ID, timeline, history: HISTORY}), [timeline]);
  const selectedClipId = scenario === 'removed' ? 'clip-03' : FIXTURE_SELECTED_CLIP_ID;
  const splitState = useMemo(() => timelineSplitState({projectId: FIXTURE_PROJECT_ID, timeline, history: HISTORY,
    selectedClipId, playhead, mode: 'editing'}), [timeline, selectedClipId, playhead]);
  const selectedClip = timeline.clips.find(clip => clip.id === selectedClipId);
  const selectedShot = selectedClip?.sequenceSource?.kind === 'shot' ? selectedClip.sequenceSource : null;
  const sequence: EditUiInspectorSequence | null = selectedShot ? {
    mainTrackId: projection.mainTrackId, shotNumber: selectedShot.number, shotName: selectedShot.name,
    versionMode: selectedShot.versionMode, boardVersion: selectedShot.boardVersion, appliedVersion: selectedShot.appliedVersion,
    onRevealShot: () => {callbacks.reveals++;},
    onVersionChoice: choice => {callbacks.versionChoices.push({mode: choice.mode, versionId: choice.versionId});},
  } : null;
  const notice: EditUiNotice | null = scenario === 'removed'
    ? {id: 'notice-removed-02', message: t('editUi.notice.removedFromMainTrack', {name: REMOVED_SHOT_NAME})} : null;
  const thumbnails = useMemo(() => fixtureThumbnails(), []);
  const previewArt = useMemo(() => fixturePreview(), []);
  useEffect(() => {setDialogClosed(false);}, [scenario]);
  useLayoutEffect(() => {
    document.documentElement.dataset.reduceMotion = motion === 'app' ? 'true' : 'false';
  }, [motion]);
  useLayoutEffect(() => {
    const api = {
      setScenario(value: FixtureScenario): void {setScenario(value);},
      setLocale(value: Locale): Promise<void> {return language.setPreference(value);},
      setZoom(value: number): void {setPixelsPerSecond(value);},
      setMotion,
      readCallbacks: (): FixtureCallbacks => structuredClone(callbacks),
      clearCallbacks(): void {callbacks.reveals = 0; callbacks.versionChoices.length = 0; callbacks.confirmed.length = 0;
        callbacks.cancelled = 0; callbacks.undone.length = 0; callbacks.dismissed.length = 0; callbacks.seeks.length = 0;},
    };
    (window as Window & {__editUiFixture?: typeof api}).__editUiFixture = api;
  }, [motion]);
  const selectedTrackBadge = 'V1';
  return <div className="fixture-shell dock-workbench workbench-v2" data-fixture-scenario={scenario} data-fixture-motion={motion}>
    <header className="fixture-topbar">
      <span className="fixture-lights"><i /><i /><i /></span>
      <strong className="fixture-brand">Mioon</strong>
      <span className="fixture-project">UI 走查项目</span>
      <div className="fixture-mode"><b>画板</b><b className="active">剪辑</b></div>
      <div className="fixture-topright"><span>● 本地 · 已保存</span><span>任务 ②</span><span>?</span><span>⚙</span><button type="button">导出</button></div>
    </header>
    <div className="fixture-workspace">
      <aside className="fixture-assets">
        <div className="fixture-assets-tabs"><b>素材</b><span>主体</span></div>
        <div className="fixture-import">↑ 导入素材</div>
        <div className="fixture-search">⌕ 搜索素材　⚙</div>
        <div className="fixture-filters"><span>视频 ×</span><span>标签：夜景 ×</span></div>
        <div className="fixture-assets-count">8 项</div>
        <div className="fixture-grid">{thumbnails.map((source, index) => <figure key={index}><img src={source} alt="" /><figcaption>scene-{String.fromCharCode(97 + index)}.mp4</figcaption></figure>)}</div>
      </aside>
      <main className="fixture-preview">
        <div className="fixture-preview-bar"><span className="fixture-segmented"><b>源素材</b><b className="active">成片</b></span>
          <span className="fixture-preview-spec">1080×1920 · 30fps</span><span className="fixture-aspect">9:16 ⌄</span></div>
        <div className="fixture-monitor"><div className="fixture-frame"><img src={previewArt} alt="" /><span>镜头缓慢推进</span></div></div>
        <div className="fixture-playbar"><span className="fixture-time">{timecode(playhead, timeline.fps)}</span><span className="fixture-total">/ {timecode(timeline.durationFrames, timeline.fps)}</span>
          <span className="fixture-transport"><i>⏮</i><i className="play">▶</i><i>⏭</i></span><span className="fixture-play-actions">入点 出点 声音 全屏</span></div>
      </main>
      <aside className="fixture-inspector">
        <div className="fixture-inspector-tabs"><b>属性</b><span>Mio</span><em>V1 {selectedShot?.number ?? '—'} {selectedShot?.name ?? ''} ⋯</em></div>
        <div className="fixture-inspector-scroll">
          {sequence && <ShotVersionBar sequence={sequence} />}
          <section className="fixture-group"><h3>基础</h3>
            <label>名称</label><div className="fixture-value">{selectedClip?.name ?? ''}</div>
            <label>轨道</label><div className="fixture-value">{t('editUi.track.mainMarker', {badge: selectedTrackBadge})}</div>
            <div className="fixture-row"><div><label>开始帧</label><div className="fixture-value">{String(selectedClip?.startFrame ?? 0)}　帧</div></div>
              <div><label>时长</label><div className="fixture-value">{String(selectedClip?.durationFrames ?? 0)}　帧</div></div></div>
            <label>素材入点</label><div className="fixture-value mono">{timecode(Number(selectedClip?.sourceInFrame ?? 0), timeline.fps)}</div>
          </section>
          <section className="fixture-group"><h3>画面</h3>
            <div className="fixture-row"><div><label>位置 X</label><div className="fixture-value">0</div></div><div><label>位置 Y</label><div className="fixture-value">0</div></div></div>
            <label>缩放</label><div className="fixture-value">100%</div>
            <label>不透明度</label><div className="fixture-value">100%</div>
            <label>LUT</label><div className="fixture-value">无</div>
          </section>
        </div>
        <footer className="fixture-inspector-footer"><span>● 已保存</span><span className="fixture-footer-actions">放弃　保存</span></footer>
      </aside>
    </div>
    <div className="fixture-timeline">
      <Timeline timeline={timeline as never} assets={assets as never} historyState={historyState as never} splitState={splitState as never}
        editUiProjection={projection} onHistory={() => undefined} onSplit={() => undefined}
        onSelectSubtitle={() => undefined} onAddSubtitle={() => undefined} onSelectClip={() => undefined}
        onAddAsset={() => undefined} onMoveClip={() => undefined} onTrackAdd={() => undefined} onTrackUpdate={() => undefined}
        onSeed={() => undefined} onRender={() => undefined} onSeek={frame => {callbacks.seeks.push(frame); setPlayhead(frame);}}
        onCollapse={() => undefined} playhead={playhead} selectedClipId={selectedClipId} selectedCueId={null} collapsed={false}
        viewState={{pixelsPerSecond, scrollLeft: scroll.scrollLeft, scrollTop: scroll.scrollTop, snappingEnabled: true}}
        onViewStateChange={patch => setScroll(current => ({scrollLeft: Number(patch.scrollLeft ?? current.scrollLeft), scrollTop: Number(patch.scrollTop ?? current.scrollTop)}))} />
    </div>
    <CopyMoveConfirmDialog request={scenario === 'copy-move' && !dialogClosed ? COPY_MOVE_REQUEST : null}
      onConfirm={request => {callbacks.confirmed.push(request); setDialogClosed(true);}}
      onCancel={() => {callbacks.cancelled++; setDialogClosed(true);}} />
    <EditUiNoticeBar notice={notice} onUndo={item => {callbacks.undone.push(item.id);}} onDismiss={item => {callbacks.dismissed.push(item.id);}} />
  </div>;
}

createRoot(document.getElementById('root')!).render(
  <I18nProvider store={language}><Fixture /></I18nProvider>,
);
