/** Real-RPC headless harness for the format-5 scene-split success path. It
 * mounts the production scene-detection controller/dialog, the production asset
 * context menu, the production Timeline and notice bar, and the production
 * `Format5EditSession` against a real format-5 kernel served through the real
 * project service. Only the surrounding shell (the asset cards and the debug
 * readouts) is a fixture; no command, receipt, detection result or envelope is
 * mocked. Cuts come from the project's saved detection results. */
import React, {useEffect, useMemo, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import '../../../packages/ui/src/styles/globals.css';
import '../../../apps/web/src/styles.css';
import '../../../apps/web/src/edit-ui/edit-ui.css';
import '../../../apps/web/src/viewport-scale.css';
import '../edit-ui-wire/fixture.css';
import Timeline from '../../../apps/web/src/Timeline.tsx';
import {I18nProvider, createLanguageStore, useI18n} from '../../../apps/web/src/i18n/I18nProvider.tsx';
import {timelineHistoryState} from '../../../apps/web/src/timeline-history.ts';
import {timelineSplitState} from '../../../apps/web/src/timeline-split.ts';
import EditUiNoticeBar from '../../../apps/web/src/edit-ui/EditUiNotice.tsx';
import type {EditUiNotice} from '../../../apps/web/src/edit-ui/EditUiNotice.tsx';
import SceneDetectionDialog from '../../../apps/web/src/SceneDetectionDialog.tsx';
import AssetContextMenu from '../../../apps/web/src/AssetContextMenu.tsx';
import {useSceneDetection} from '../../../apps/web/src/use-scene-detection.ts';
import {ConfirmationProvider} from '../../../packages/ui/src/components/workbench-confirm.tsx';
import {TooltipProvider} from '../../../packages/ui/src/components/tooltip.tsx';
import {message as msg} from '../../../packages/i18n/src/index.ts';
import type {DisplayMessage} from '../../../packages/i18n/src/index.ts';
import {
  Format5EditSession, format5CommandErrorMessageKey, format5Projection, format5SceneSplitNotice,
} from '../../../apps/web/src/edit-ui/session.ts';
import type {SequenceHistoryView} from '../../../apps/web/src/edit-ui/session.ts';

type Row = Record<string, any>;
interface WireData {project: Row; timeline: Row; shots: readonly Row[]; versions: readonly Row[]; assets: readonly Row[]; projectFormatVersion: 5}
const projectId = '93000000-0000-4000-8000-000000000001';
const assetName = (asset: Row | undefined): string => String(asset?.name ?? '');
const startedAt = Date.now();
const logLimit = 120;
const rpcLog: Row[] = [];
const rpc = async (operation: string, input: unknown): Promise<any> => {
  const entry: Row = {t: Date.now() - startedAt, operation, input};
  try {
    const response = await fetch('/rpc', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({operation, input})});
    const body = await response.json() as {ok: boolean; data?: any; error?: {code?: string; message?: string}};
    if (!body.ok) throw Object.assign(new Error(body.error?.message ?? 'RPC failed'), {code: body.error?.code ?? 'RPC_FAILED'});
    entry.response = body.data;
    return body.data;
  } catch (error) {
    entry.error = {code: (error as {code?: string}).code ?? 'RPC_FAILED', message: String((error as Error).message)};
    throw error;
  } finally {
    rpcLog.push(entry);
    if (rpcLog.length > logLimit) rpcLog.splice(0, rpcLog.length - logLimit);
    (window as any).__wireRpcLog = rpcLog;
  }
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
  const {t, renderMessage} = useI18n();
  const [data, setData] = useState<WireData | null>(null);
  const [history, setHistory] = useState<SequenceHistoryView | null>(null);
  const [selectedClipId, setSelectedClipId] = useState('93000000-0000-4000-8000-000000000030');
  const [playhead, setPlayhead] = useState(0);
  const [notice, setNotice] = useState<EditUiNotice | null>(null);
  const [noticeActionId, setNoticeActionId] = useState<string | null>(null);
  const [sceneTarget, setSceneTarget] = useState<{assetId: string; autoStart: boolean} | null>(null);
  const [menu, setMenu] = useState<{assetId: string; x: number; y: number} | null>(null);
  const [sceneMessage, setSceneMessage] = useState('');
  const [sceneReceipt, setSceneReceipt] = useState<Row | null>(null);
  const [lastOperation, setLastOperation] = useState('');
  const [lastError, setLastError] = useState('');
  const session = useRef(new Format5EditSession(rpc, () => projectId));
  const scenes = useSceneDetection({projectId, visible: true, readOnly: false, rpc});
  const stateRef = useRef<Row>({});
  stateRef.current = {data, history, selectedClipId, notice, noticeActionId, lastOperation, lastError,
    sceneTarget, sceneMessage, sceneReceipt, scene: {phase: scenes.state.phase, tasks: scenes.state.tasks,
      results: scenes.state.results, tasksLoaded: scenes.state.tasksLoaded}};

  const refresh = async (): Promise<void> => {
    const project = await rpc('project.get', {projectId}) as WireData;
    project.projectFormatVersion = 5;
    const view = await rpc('sequence.history.get', {projectId}) as SequenceHistoryView;
    setData(project); setHistory(view);
  };
  useEffect(() => { void refresh().then(() => {stateRef.current.ready = true;}); }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, [contenteditable="true"]')) return;
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'z') return;
      event.preventDefault();
      void (async () => {
        const view = await rpc('sequence.history.get', {projectId}) as SequenceHistoryView;
        const result = event.shiftKey ? await session.current.redo(view) : await session.current.undo(view);
        setLastOperation(event.shiftKey ? 'redo' : 'undo');
        setLastError(result.ok ? '' : result.code);
        try {await refresh();} catch (error) {setLastError(`refresh:${(error as {code?: string}).code ?? 'error'}`);}
      })();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {(window as any).__wireState = {...stateRef.current, ready: Boolean(data)};},
    [data, history, selectedClipId, notice, noticeActionId, lastOperation, lastError, sceneTarget, sceneMessage, sceneReceipt,
      scenes.state.phase, scenes.state.tasks, scenes.state.results, scenes.state.tasksLoaded]);

  const timeline = data?.timeline ?? null;
  const assets = data?.assets ?? [];
  const targetAsset: Row | null = sceneTarget ? assets.find(asset => asset.id === sceneTarget.assetId) ?? null : null;
  const menuAsset: Row | null = menu ? assets.find(asset => asset.id === menu.assetId) ?? null : null;
  const projection = useMemo(() => data ? format5Projection(timeline as never, data.shots as never, data.versions as never) : null,
    [data, timeline]);
  const splitState = useMemo(() => data ? timelineSplitState({projectId, timeline: timeline as never,
    history: historySource(data, history), busy: false, pending: false, dirty: false, online: true,
    selectedClipId, playhead, mode: 'editing'}) : null, [data, timeline, history, selectedClipId, playhead]);
  const historyState = useMemo(() => data ? timelineHistoryState({projectId, timeline: timeline as never,
    history: historySource(data, history), busy: false, pending: false, dirty: false, online: true}) : null,
  [data, timeline, history]);

  /** The production entry the dialog's split button reaches: one preview/commit
   * of the split-at-scenes intent, then the same undo bar every format-5
   * structural edit shows. Refusals keep the mapping the app uses. */
  const splitAtScenes = async (assetId: string, resultId: string): Promise<void> => {
    setLastOperation('scene-split'); setSceneMessage('');
    const result = await session.current.splitAtScenes(assetId, resultId);
    if (!result.ok) {
      const message = t(format5CommandErrorMessageKey(result.code) as never);
      setLastError(result.code ?? 'UNKNOWN'); setSceneMessage(message); setSceneReceipt(null);
      (window as any).__sceneSplit = {ok: false, code: result.code ?? 'UNKNOWN', message};
      return;
    }
    setLastError('');
    // Mirrors the app: a successful format-5 split closes the detection dialog
    // and leaves only the undo bar; the toast the app used to add is gone.
    setSceneTarget(null);
    if (result.resolvedFromReceipt) {
      const message = t('editUi.notice.resultApplied');
      setNotice({id: `wire-scene-split-${Date.now()}`, message}); setNoticeActionId(null);
      setSceneMessage(message);
      setSceneReceipt({resolvedFromReceipt: true, actionId: result.actionId});
      await refresh();
      return;
    }
    const sceneSplitNotice = format5SceneSplitNotice(result.receipt?.sceneSplit);
    const message = renderMessage(msg(sceneSplitNotice.key, sceneSplitNotice.params));
    setNotice({id: result.actionId ?? `wire-scene-split-${Date.now()}`, message});
    setNoticeActionId(result.actionId);
    setSceneMessage(message);
    const captured = {actionId: result.actionId, operation: result.operation, sceneSplit: result.receipt?.sceneSplit ?? null,
      receipt: result.receipt ?? null};
    setSceneReceipt(captured);
    (window as any).__sceneSplit = captured;
    await refresh();
  };
  const openSceneDetection = (assetId: string, autoStart: boolean): void => {setMenu(null); setSceneTarget({assetId, autoStart});};
  const undoNotice = async (): Promise<void> => {
    const view = await rpc('sequence.history.get', {projectId}) as SequenceHistoryView;
    if (!view.undo || view.undo.actionId !== noticeActionId) {setNotice(null); return;}
    const result = await session.current.undo(view);
    setLastOperation('notice-undo');
    setLastError(result.ok ? '' : result.code);
    if (result.ok) {setNotice(null); setNoticeActionId(null); await refresh();}
  };

  if (!data) return <div className="wire-shell" data-testid="wire-loading">loading</div>;
  const sceneAsset: Row | null = targetAsset ? {...targetAsset, name: String(targetAsset.name)} as Row : null;
  return <div className="wire-shell">
    <header className="wire-toolbar">
      <strong>剪辑 · 格式 5 · 按场景切开（真实 RPC）</strong>
      <button type="button" data-testid="wire-undo-key" onClick={() => {void (async () => {
        const view = await rpc('sequence.history.get', {projectId}) as SequenceHistoryView;
        const result = await session.current.undo(view); setLastOperation('undo'); setLastError(result.ok ? '' : result.code);
        await refresh();
      })();}}>Cmd+Z</button>
      <button type="button" data-testid="wire-redo-key" onClick={() => {void (async () => {
        const view = await rpc('sequence.history.get', {projectId}) as SequenceHistoryView;
        const result = await session.current.redo(view); setLastOperation('redo'); setLastError(result.ok ? '' : result.code);
        await refresh();
      })();}}>Shift+Cmd+Z</button>
      <span className="wire-state" data-testid="wire-state" data-operation={lastOperation} data-error={lastError}
        data-clips={data.timeline.clips.length} data-position={history?.position ?? -1}>{lastOperation || 'ready'}{lastError ? ` · ${lastError}` : ''}</span>
    </header>
    <div className="wire-main" style={{gridTemplateColumns: '200px minmax(0,1fr) 320px'}}>
      <aside className="wire-inspector" data-testid="wire-library">
        <strong>素材库</strong>
        <div style={{display: 'grid', gap: 8, marginTop: 8}}>
          {assets.filter(asset => String(asset.mimeType).startsWith('video/')).map(asset => <button type="button" key={asset.id}
            data-testid={`wire-asset-${asset.id}`} data-name={asset.name}
            style={{textAlign: 'left', padding: '8px 10px', borderRadius: 8, border: `1px solid ${sceneTarget?.assetId === asset.id ? '#5B8DEF' : '#2E3138'}`,
              background: '#1B1D21', color: '#ECEDEF', fontSize: 11}}
            onContextMenu={event => {event.preventDefault(); setMenu({assetId: asset.id, x: event.clientX, y: event.clientY});}}
            onClick={() => setSelectedClipId(data.timeline.clips.find((clip: Row) => clip.assetId === asset.id)?.id ?? selectedClipId)}>
            <div>{assetName(asset)}</div>
            <div style={{color: '#A3A7AF'}}>{String(asset.sha256 ?? '').slice(0, 12)}</div>
          </button>)}
        </div>
      </aside>
      <section className="wire-canvas">
        <Timeline timeline={timeline as never} assets={data.assets as never} editUiProjection={projection}
          historyState={historyState!} splitState={splitState!} onHistory={() => undefined} onSplit={() => undefined}
          onSelectClip={(id: string) => {setSelectedClipId(id); setPlayhead(timeline!.clips.find((item: Row) => item.id === id)?.startFrame ?? 0);}}
          selectedClipId={selectedClipId} selectedCueId={null} onSelectSubtitle={() => undefined}
          onAddSubtitle={() => undefined} onAddAsset={() => undefined} onAddTransition={() => undefined} onMoveClip={() => undefined}
          onRemove={() => undefined} onRippleRemove={() => undefined}
          onTrackAdd={() => undefined} onTrackUpdate={() => undefined} onSeed={() => undefined} onRender={() => undefined}
          onSeek={setPlayhead} playhead={playhead} collapsed={false} onCollapse={() => undefined} busy={false}
          dialogueCues={null}
          viewState={{pixelsPerSecond: 60, scrollLeft: 0, scrollTop: 0, snappingEnabled: true}} />
      </section>
      <aside className="wire-inspector">
        <pre className="wire-inspector-state" data-testid="wire-inspector-state">{JSON.stringify({
          position: history?.position ?? null, revision: timeline?.revision ?? null, clips: timeline?.clips.length ?? 0})}</pre>
        <div data-testid="wire-scene-message">{sceneMessage}</div>
        <pre data-testid="wire-scene-receipt" style={{whiteSpace: 'pre-wrap', color: '#A3A7AF', font: '11px monospace'}}>
          {sceneReceipt ? JSON.stringify(sceneReceipt.sceneSplit ?? sceneReceipt) : ''}
        </pre>
        <pre data-testid="wire-scene-state" style={{whiteSpace: 'pre-wrap', color: '#A3A7AF', font: '11px monospace'}}>{JSON.stringify({
          view: scenes.state.phase, tasksLoaded: scenes.state.tasksLoaded,
          tasks: scenes.state.tasks.map((task: Row) => ({id: task.id, kind: task.kind, state: task.state, assetId: task.sourceAssetId,
            result: task.result ?? null})).slice(0, 6),
          results: Object.fromEntries(Object.entries(scenes.state.results).map(([assetId, view]: [string, Row]) => [assetId,
            {phase: view.phase, resultId: view.response?.result?.id ?? null, current: view.response?.current ?? null,
              cuts: (view.response?.result?.cuts ?? []).map((cut: Row) => cut.frame)}])),
        })}</pre>
      </aside>
    </div>
    {menuAsset && <AssetContextMenu asset={menuAsset as never} kind="video" timelineDisabled anchor={{x: menu!.x, y: menu!.y}}
      onClose={() => setMenu(null)} onPreview={() => setMenu(null)} onDetectScenes={() => openSceneDetection(menuAsset.id, true)} />}
    {sceneAsset && sceneTarget && <SceneDetectionDialog key={`${sceneTarget.assetId}`} asset={sceneAsset as never}
      state={scenes.state} controller={scenes.controller} autoStart={sceneTarget.autoStart}
      timelineClips={data.timeline.clips.filter((clip: Row) => clip.assetId === sceneAsset.id).length}
      splitBlocked={null} onSplit={splitAtScenes} initialChoice={null} onClose={() => setSceneTarget(null)} />}
    {notice && <EditUiNoticeBar notice={notice} onUndo={() => {void undoNotice();}} onDismiss={() => {setNotice(null); setNoticeActionId(null);}} />}
  </div>;
}

const language = createLanguageStore({systemLanguages: ['zh-Hans']});
createRoot(document.getElementById('root')!).render(<React.StrictMode><I18nProvider store={language}>
  <TooltipProvider delay={0}><ConfirmationProvider><Harness /></ConfirmationProvider></TooltipProvider>
</I18nProvider></React.StrictMode>);
