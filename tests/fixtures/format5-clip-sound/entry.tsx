/** Production-component harness for the «clip sound» acceptance.
 *
 * Real format-5 kernel over the real `/rpc` project service; the production
 * Timeline, TimelineInspector (audio group), clip context menu, notice bar and
 * save-audio card are mounted with only the shell wiring written here. No
 * preview, commit, task or publication response is mocked.
 */
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import '../../../packages/ui/src/styles/globals.css';
import '../../../apps/web/src/styles.css';
import '../../../apps/web/src/edit-ui/edit-ui.css';
import './fixture.css';
import Timeline from '../../../apps/web/src/Timeline.tsx';
import TimelineInspector from '../../../apps/web/src/TimelineInspector.tsx';
import TimelineClipContextMenu from '../../../apps/web/src/TimelineClipContextMenu.tsx';
import ClipAudioTaskToast from '../../../apps/web/src/ClipAudioTaskToast.tsx';
import type {ClipAudioToastTarget} from '../../../apps/web/src/ClipAudioTaskToast.tsx';
import EditUiNoticeBar from '../../../apps/web/src/edit-ui/EditUiNotice.tsx';
import type {EditUiNotice} from '../../../apps/web/src/edit-ui/EditUiNotice.tsx';
import {I18nProvider, createLanguageStore, useI18n} from '../../../apps/web/src/i18n/I18nProvider.tsx';
import {ConfirmationProvider} from '../../../packages/ui/src/components/workbench-confirm.tsx';
import {timelineHistoryState} from '../../../apps/web/src/timeline-history.ts';
import {timelineSplitState} from '../../../apps/web/src/timeline-split.ts';
import {Format5EditSession, format5Projection} from '../../../apps/web/src/edit-ui/session.ts';
import type {SequenceHistoryView} from '../../../apps/web/src/edit-ui/session.ts';
import {clipContextMenuPlan} from '../../../apps/web/src/clip-sound-state.ts';
import {format5ClipInspectorEdit} from '../../../apps/web/src/edit-ui/format5-panel-edits.ts';

type Row = Record<string, any>;
interface WireData {project: Row; timeline: Row; shots: readonly Row[]; versions: readonly Row[]; assets: readonly Row[]; projectFormatVersion: 5}
const projectId = '91000000-0000-4000-8000-000000000001';
const startedAt = Date.now();
const rpcLog: {t: number; operation: string; input?: unknown; result?: unknown}[] = [];
const rpc = async (operation: string, input: unknown): Promise<any> => {
  const response = await fetch('/rpc', {method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({operation, input})});
  const body = await response.json() as {ok: boolean; data?: any; error?: {code?: string; message?: string}};
  rpcLog.push({t: Date.now() - startedAt, operation, input, result: body.ok ? {ok: true} : body.error});
  if (!body.ok) throw Object.assign(new Error(body.error?.message ?? 'RPC failed'), {code: body.error?.code ?? 'RPC_FAILED'});
  return body.data;
};

function historySource(data: WireData | null, history: SequenceHistoryView | null) {
  if (!data || !history) return null;
  return {projectId: data.project.id, timelineId: data.timeline.id, revision: data.timeline.revision,
    cursor: history.position, length: history.position + (history.redo ? 1 : 0),
    canUndo: Boolean(history.undo), canRedo: Boolean(history.redo),
    undoEntry: history.undo ? {id: history.undo.actionId, operation: history.undo.operation} : null,
    redoEntry: history.redo ? {id: history.redo.actionId, operation: history.redo.operation} : null};
}

function Harness(): React.ReactElement {
  const {t, locale} = useI18n();
  const [data, setData] = useState<WireData | null>(null);
  const [history, setHistory] = useState<SequenceHistoryView | null>(null);
  const [selectedClipId, setSelectedClipId] = useState<string | null>('91000000-0000-4000-8000-000000000030');
  const [playhead, setPlayhead] = useState(10);
  const [notice, setNotice] = useState<EditUiNotice | null>(null);
  const [noticeActionId, setNoticeActionId] = useState<string | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<{clipId: string; x: number; y: number} | null>(null);
  const [toast, setToast] = useState<ClipAudioToastTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastOperation, setLastOperation] = useState('');
  const [lastError, setLastError] = useState('');
  const session = useRef(new Format5EditSession(rpc, () => projectId));
  const stateRef = useRef<Row>({});
  stateRef.current = {data, history, selectedClipId, notice, noticeActionId, menuAnchor, toast, busy, lastOperation, lastError};

  const refresh = useCallback(async (): Promise<void> => {
    const project = await rpc('project.get', {projectId}) as WireData;
    project.projectFormatVersion = 5;
    const view = await rpc('sequence.history.get', {projectId}) as SequenceHistoryView;
    setData(project); setHistory(view);
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    // Headless Chromium never delivers a synthetic contextmenu to React's
    // delegated listener; this hook opens the very same production menu state
    // the Timeline contextmenu handler sets, so the menu itself stays under test.
    (window as any).__openClipMenu = (clipId: string): void => setMenuAnchor({clipId, x: 320, y: 260});
    const publish = (): void => {(window as any).__wireState = {...stateRef.current, ready: Boolean(data)};
      (window as any).__wireRpcLog = rpcLog.slice(-200);};
    publish();
    const timer = setInterval(publish, 250);
    return () => clearInterval(timer);
  }, [data]);

  const runProperties = async (clipId: string, patch: Row, noticeText?: string): Promise<boolean> => {
    setBusy(true);
    try {
      const result = await session.current.runPayload({propertiesIntent: {side: 'timeline',
        operation: {kind: 'clip-properties', edits: [{clipId, patch}]}}});
      setLastOperation('properties');
      if (!result.ok) {setLastError(result.code); return false;}
      setLastError('');
      if (noticeText) {setNotice({id: `notice-${Date.now()}`, message: noticeText}); setNoticeActionId(result.actionId);}
      await refresh();
      return true;
    } finally {setBusy(false);}
  };
  const separateSound = async (clipId: string): Promise<void> => {
    const clip = data?.timeline.clips.find((item: Row) => item.id === clipId);
    if (!clip) return;
    setBusy(true);
    try {
      const suffix = ` · ${t('clipSound.nameSuffix')}`;
      const result = await session.current.runPayload({soundIntent: {side: 'timeline',
        operation: {kind: 'separate-sound', clipId, name: `${String(clip.name ?? '')}${suffix}`,
          trackName: t('clipSound.trackName')}}});
      setLastOperation('separate-sound');
      if (!result.ok) {setLastError(result.code); return;}
      setLastError('');
      setNotice({id: `notice-${Date.now()}`, message: t('editUi.notice.soundSeparated')});
      setNoticeActionId(result.actionId);
      await refresh();
    } finally {setBusy(false);}
  };
  const saveAudio = async (clipId: string): Promise<void> => {
    const clip = data?.timeline.clips.find((item: Row) => item.id === clipId);
    if (!clip) return;
    try {
      const record = await rpc('clip.audio.export', {projectId, requestId: `wire-${crypto.randomUUID()}`,
        clipId, outputLocale: locale}) as Row;
      setLastOperation('clip-audio-export');
      setToast({projectId, exportId: record.id, clipId, clipName: String(record.source?.clipName ?? clip.name ?? ''),
        requestId: record.requestId, token: Date.now()});
    } catch (error) {setLastError((error as {code?: string}).code ?? 'SAVE_FAILED');}
  };
  const retryAudio = async (target: ClipAudioToastTarget): Promise<void> => {
    const clip = data?.timeline.clips.find((item: Row) => item.id === target.clipId);
    if (!clip) return;
    try {
      const record = await rpc('clip.audio.export', {projectId, requestId: `wire-${crypto.randomUUID()}`,
        clipId: target.clipId, outputLocale: locale}) as Row;
      setToast({projectId, exportId: record.id, clipId: target.clipId,
        clipName: String(record.source?.clipName ?? clip.name ?? ''), requestId: record.requestId, token: Date.now()});
    } catch (error) {setLastError((error as {code?: string}).code ?? 'RETRY_FAILED');}
  };
  const changeHistory = async (direction: 'undo' | 'redo'): Promise<void> => {
    const view = await session.current.history();
    if (!view) return;
    const result = direction === 'undo' ? await session.current.undo(view) : await session.current.redo(view);
    if (!result.ok) {setLastError(result.code); return;}
    setLastError('');
    await refresh();
  };
  const undoNotice = async (): Promise<void> => {
    const view = await session.current.history();
    if (!view?.undo || view.undo.actionId !== noticeActionId) {setNotice(null); return;}
    const result = await session.current.undo(view);
    if (!result.ok) {setLastError(result.code); return;}
    setNotice(null); setNoticeActionId(null);
    await refresh();
  };
  const saveInspector = async (clipId: string, patch: Row, _revision: number): Promise<unknown> => {
    const timeline = data?.timeline;
    const clip = timeline?.clips.find((item: Row) => item.id === clipId);
    if (!timeline || !clip) return null;
    const mainTrackId = (timeline as Row).mainTrack?.trackId ?? null;
    const edit = format5ClipInspectorEdit(clip, patch, timeline.clips, mainTrackId);
    if (edit.kind === 'properties') {
      setBusy(true);
      try {
        const result = await session.current.runPayload({propertiesIntent: edit.intent});
        if (!result.ok) {setLastError(result.code); return null;}
        await refresh();
        return result;
      } finally {setBusy(false);}
    }
    return null;
  };

  const timeline = data?.timeline ?? null;
  const projection = useMemo(() => data ? format5Projection(timeline as never, data.shots as never, data.versions as never) : null,
    [data, timeline]);
  const selectedClip = timeline?.clips.find((item: Row) => item.id === selectedClipId) ?? null;
  const selectedAsset = data?.assets.find((item: Row) => item.id === selectedClip?.assetId) ?? null;
  const mainTrackId = timeline?.mainTrack?.trackId ?? null;
  const splitState = useMemo(() => data ? timelineSplitState({projectId, timeline: timeline as never,
    history: historySource(data, history), busy, pending: false, dirty: false, online: true,
    selectedClipId, playhead, mode: 'editing'}) : null, [data, timeline, history, selectedClipId, playhead, busy]);
  const historyState = useMemo(() => data ? timelineHistoryState({projectId, timeline: timeline as never,
    history: historySource(data, history), busy, pending: false, dirty: false, online: true}) : null,
  [data, timeline, history, busy]);
  const menuPlan = useMemo(() => {
    if (!menuAnchor || !data) return null;
    const clip = data.timeline.clips.find((item: Row) => item.id === menuAnchor.clipId);
    if (!clip) return null;
    return clipContextMenuPlan({format5: true, clip: clip as never,
      asset: data.assets.find((item: Row) => item.id === clip.assetId) as never,
      track: data.timeline.tracks.find((item: Row) => item.id === clip.trackId) as never});
  }, [menuAnchor, data]);

  if (!data || !timeline) return <div className="wire-shell" data-testid="wire-loading">loading</div>;
  return <div className="wire-shell" data-testid="clip-sound-harness">
    <header className="wire-toolbar">
      <strong>格式 5 · 片段的声音</strong>
      <span className="wire-state" data-testid="wire-state" data-operation={lastOperation} data-error={lastError}
        data-position={history?.position ?? -1} data-muted={selectedClip?.muted === true}
        data-selected={selectedClipId ?? ''} data-clips={data.timeline.clips.length}
        data-tracks={data.timeline.tracks.length} data-assets={data.assets.length}
        data-toast={toast?.exportId ?? ''} data-notice={notice?.message ?? ''}>
        {lastOperation || 'ready'}{lastError ? ` · ${lastError}` : ''}
      </span>
    </header>
    <div className="wire-main">
      <section className="wire-canvas">
        <Timeline timeline={timeline as never} assets={data.assets as never} editUiProjection={projection}
          historyState={historyState!} splitState={splitState!}
          onHistory={direction => {void changeHistory(direction as 'undo' | 'redo');}} onSplit={() => undefined}
          onSelectClip={id => {setSelectedClipId(id); setMenuAnchor(null);
            setPlayhead(timeline.clips.find((item: Row) => item.id === id)?.startFrame ?? 0);}}
          onClipContextMenu={(clipId, point) => {setSelectedClipId(clipId); setMenuAnchor({clipId, x: point.x, y: point.y});}}
          selectedClipId={selectedClipId} selectedCueId={null} onSelectSubtitle={() => undefined}
          onAddSubtitle={() => undefined} onAddAsset={() => undefined} onMoveClip={() => undefined}
          onRemove={() => undefined} onRippleRemove={() => undefined}
          onTrackAdd={() => undefined} onTrackUpdate={() => undefined} onSeed={() => undefined} onRender={() => undefined}
          onSeek={setPlayhead} playhead={playhead} collapsed={false} onCollapse={() => undefined} busy={busy}
          viewState={{pixelsPerSecond: 80, scrollLeft: 0, scrollTop: 0, snappingEnabled: true}} />
      </section>
      <aside className="wire-inspector" data-testid="wire-inspector">
        {selectedClip && <TimelineInspector key={selectedClip.id} clip={selectedClip as never} timeline={timeline as never}
          asset={selectedAsset as never} draftContext={{scope: `wire:${projectId}:${selectedClip.id}`, projectId}}
          draftConnected={true} format5={true}
          onToggleClipMute={clipId => {const clip = timeline.clips.find((item: Row) => item.id === clipId);
            void runProperties(clipId, {muted: clip?.muted !== true});}}
          onSeparateSound={clipId => {void separateSound(clipId);}}
          onSaveClipAudio={clipId => {void saveAudio(clipId);}}
          onSave={saveInspector as never} onDirtyChange={() => undefined} onSplit={() => undefined}
          onPreview={() => undefined} splitDisabled busy={busy} />}
      </aside>
    </div>
    <TimelineClipContextMenu anchor={menuAnchor}
      plan={menuPlan ?? {sound: false, saveAudio: false, muteLabelKey: 'clipSound.mute'}}
      canSplit={Boolean(splitState?.canSplit) && splitState?.clipId === menuAnchor?.clipId} busy={busy}
      onSplit={() => undefined} onToggleMute={clipId => {const clip = timeline.clips.find((item: Row) => item.id === clipId);
        setMenuAnchor(null); void runProperties(clipId, {muted: clip?.muted !== true});}}
      onSeparate={clipId => {setMenuAnchor(null); void separateSound(clipId);}}
      onSaveAudio={clipId => {setMenuAnchor(null); void saveAudio(clipId);}}
      onClose={() => setMenuAnchor(null)} />
    <ClipAudioTaskToast target={toast}
      read={(project, exportId) => rpc('clip.audio.export.get', {projectId: project, exportId})}
      cancel={(project, exportId) => rpc('export.cancel', {projectId: project, exportId})}
      retry={target => {void retryAudio(target);}}
      viewAsset={assetId => {(window as any).__wireState = {...(window as any).__wireState, viewedAssetId: assetId};}}
      onDone={target => {if (target.projectId === projectId) void refresh();}}
      onClose={() => setToast(null)} />
    {notice && <EditUiNoticeBar notice={notice} onUndo={() => {void undoNotice();}} onDismiss={() => setNotice(null)} />}
  </div>;
}

const language = createLanguageStore({systemLanguages: ['zh-Hans']});
createRoot(document.getElementById('root')!).render(<React.StrictMode><I18nProvider store={language}><ConfirmationProvider labels={{title: '确认', cancel: '取消', continue: '继续'}} renderMessage={value => String(value ?? '')}><Harness /></ConfirmationProvider></I18nProvider></React.StrictMode>);
