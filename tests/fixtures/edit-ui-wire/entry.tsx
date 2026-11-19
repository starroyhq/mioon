/** Real-RPC headless harness for UI-E2. It renders the production Timeline,
 * version bar, confirmation dialog and notice against a real format-5 kernel
 * over the real `sequence.*` project service. Only the surrounding shell is a
 * fixture; there is no mocked command or receipt. */
import React, {useEffect, useMemo, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import '../../../packages/ui/src/styles/globals.css';
import '../../../apps/web/src/styles.css';
import '../../../apps/web/src/edit-ui/edit-ui.css';
import './fixture.css';
import Timeline from '../../../apps/web/src/Timeline.tsx';
import {I18nProvider, createLanguageStore, useI18n} from '../../../apps/web/src/i18n/I18nProvider.tsx';
import {timelineHistoryState} from '../../../apps/web/src/timeline-history.ts';
import {timelineSplitState} from '../../../apps/web/src/timeline-split.ts';
import CopyMoveConfirmDialog from '../../../apps/web/src/edit-ui/CopyMoveConfirmDialog.tsx';
import type {EditUiCopyMoveRequest} from '../../../apps/web/src/edit-ui/CopyMoveConfirmDialog.tsx';
import EditUiNoticeBar from '../../../apps/web/src/edit-ui/EditUiNotice.tsx';
import type {EditUiNotice} from '../../../apps/web/src/edit-ui/EditUiNotice.tsx';
import ShotVersionBar from '../../../apps/web/src/edit-ui/ShotVersionBar.tsx';
import type {EditUiInspectorSequence} from '../../../apps/web/src/edit-ui/status.tsx';
import {
  Format5EditSession, format5CommandErrorMessageKey, format5InspectorSequence, format5MoveCommand,
  format5MoveOffTrackCommand, format5Projection, format5RemoveCommand, format5SplitCommand, format5TrimCommand,
  format5VersionCommand,
} from '../../../apps/web/src/edit-ui/session.ts';
import type {SequenceHistoryView} from '../../../apps/web/src/edit-ui/session.ts';
import type {SequenceSyncCommand} from '../../../packages/contracts/src/sequence-sync.ts';

type Row = Record<string, any>;
interface WireData {project: Row; timeline: Row; shots: readonly Row[]; versions: readonly Row[]; assets: readonly Row[]; projectFormatVersion: 5}
const rpc = async (operation: string, input: unknown): Promise<any> => {
  const response = await fetch('/rpc', {method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({operation, input})});
  const body = await response.json() as {ok: boolean; data?: any; error?: {code?: string; message?: string}};
  if (!body.ok) throw Object.assign(new Error(body.error?.message ?? 'RPC failed'), {code: body.error?.code ?? 'RPC_FAILED'});
  return body.data;
};
const projectId = '90000000-0000-4000-8000-000000000001';
const mainTrackId = '90000000-0000-4000-8000-000000000060';
const track2Id = '90000000-0000-4000-8000-000000000061';
const imageClipId = '90000000-0000-4000-8000-000000000033';

function historySource(data: WireData | null, history: SequenceHistoryView | null) {
  if (!data || !history) return null;
  return {projectId: data.project.id, timelineId: data.timeline.id, revision: data.timeline.revision,
    cursor: history.position, length: history.position + (history.redo ? 1 : 0),
    canUndo: Boolean(history.undo), canRedo: Boolean(history.redo),
    undoEntry: history.undo ? {id: history.undo.actionId, operation: history.undo.operation} : null,
    redoEntry: history.redo ? {id: history.redo.actionId, operation: history.redo.operation} : null};
}

function Harness(): React.ReactElement {
  const {t} = useI18n();
  const [data, setData] = useState<WireData | null>(null);
  const [history, setHistory] = useState<SequenceHistoryView | null>(null);
  const [selectedClipId, setSelectedClipId] = useState('90000000-0000-4000-8000-000000000031');
  const [playhead, setPlayhead] = useState(30);
  const [notice, setNotice] = useState<EditUiNotice | null>(null);
  const [noticeActionId, setNoticeActionId] = useState<string | null>(null);
  const [copyRequest, setCopyRequest] = useState<EditUiCopyMoveRequest | null>(null);
  const [exportIssues, setExportIssues] = useState<readonly {code: string; clipId: string}[]>([]);
  const [lastOperation, setLastOperation] = useState('');
  const [lastError, setLastError] = useState('');
  const session = useRef(new Format5EditSession(rpc, () => projectId));
  const busy = useRef(false);
  const stateRef = useRef<Row>({});
  stateRef.current = {data, history, selectedClipId, notice, noticeActionId, copyRequest, exportIssues, lastOperation, lastError};

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
      const run = async (): Promise<void> => {
        const view = await rpc('sequence.history.get', {projectId}) as SequenceHistoryView;
        const result = event.shiftKey ? await session.current.redo(view) : await session.current.undo(view);
        setLastOperation(event.shiftKey ? 'redo' : 'undo');
        if (!result.ok) setLastError(result.code);
        await refresh();
      };
      void run();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {(window as any).__wireState = {...stateRef.current, ready: Boolean(data)};}, [data, history, selectedClipId, notice, noticeActionId, copyRequest, exportIssues, lastOperation, lastError]);
  const timeline = data?.timeline ?? null;
  const projection = useMemo(() => data ? format5Projection(timeline as never, data.shots as never, data.versions as never) : null,
    [data, timeline]);
  const splitState = useMemo(() => data ? timelineSplitState({projectId, timeline: timeline as never,
    history: historySource(data, history), busy: busy.current, pending: false, dirty: false, online: true,
    selectedClipId, playhead, mode: 'editing'}) : null, [data, timeline, history, selectedClipId, playhead]);
  const historyState = useMemo(() => data ? timelineHistoryState({projectId, timeline: timeline as never,
    history: historySource(data, history), busy: busy.current, pending: false, dirty: false, online: true}) : null,
  [data, timeline, history]);

  const applyOutcome = async (command: {kind: string; clipId?: string}, result: {ok: boolean; code?: string; actionId?: string | null}): Promise<boolean> => {
    if (!result.ok) {setLastError(result.code ?? 'UNKNOWN'); setLastOperation(command.kind); return false;}
    setLastError(''); setLastOperation(command.kind);
    if (command.kind !== 'clip-version') {
      const clip = data?.timeline.clips.find((item: Row) => item.id === (command as {clipId?: string}).clipId);
      const message = command.kind === 'clip-remove' ? t('editUi.notice.removedFromMainTrack', {name: clip?.name ?? ''})
        : command.kind === 'clip-split' ? t('editUi.notice.split', {name: clip?.name ?? ''})
        : t('editUi.notice.moved', {name: clip?.name ?? ''});
      setNotice({id: `wire-${Date.now()}`, message}); setNoticeActionId(result.actionId ?? null);
    }
    await refresh();
    return true;
  };
  const run = async (command: SequenceSyncCommand): Promise<boolean> => {
    if (busy.current) return false;
    busy.current = true;
    try {return await applyOutcome(command, await session.current.run(command));}
    finally {busy.current = false;}
  };
  const removeSelected = async (): Promise<void> => {if (selectedClipId) await run(format5RemoveCommand(selectedClipId));};
  const splitSelected = async (): Promise<void> => {
    const clip = data?.timeline.clips.find((item: Row) => item.id === selectedClipId);
    if (!clip) return;
    const result = await session.current.run(format5SplitCommand(clip.id, Math.max(1, Math.floor(clip.durationFrames / 2))));
    await applyOutcome({kind: 'clip-split', clipId: clip.id}, result as never);
  };
  const trimSelected = async (): Promise<void> => {
    const clip = data?.timeline.clips.find((item: Row) => item.id === selectedClipId);
    if (!clip) return;
    const result = await session.current.run(format5TrimCommand(clip.id, Math.max(1, clip.durationFrames - 5)));
    await applyOutcome({kind: 'clip-trim', clipId: clip.id}, result as never);
  };
  const lockSelected = async (): Promise<void> => {
    const clip = data?.timeline.clips.find((item: Row) => item.id === selectedClipId);
    const sequence = sequenceFor(clip?.id);
    if (!sequence) return;
    const result = await session.current.run(format5VersionCommand(selectedClipId,
      {mode: sequence.versionMode === 'locked' ? 'follow' : 'locked', versionId: sequence.appliedVersion?.id ?? null}));
    await applyOutcome({kind: 'clip-version', clipId: selectedClipId}, result as never);
  };
  const moveSelected = async (): Promise<void> => {
    const clip = data?.timeline.clips.find((item: Row) => item.id === selectedClipId);
    if (!clip) return;
    const source = (clip as Row).sequenceSource;
    // Moving one part of a split group away from its sibling requires the copy
    // identity; the plain move preview returns COPY_NODE_REQUIRED first.
    const target = data!.timeline.clips.find((item: Row) => item.id === imageClipId) ?? null;
    const command = format5MoveCommand(clip.id, target?.id ?? null);
    const request = {clipId: clip.id, nodeId: source?.nodeId ?? '', segmentGroupId: source?.segmentGroupId ?? '',
      targetTrackId: mainTrackId, targetStartFrame: 60, timelineRevision: timeline!.revision};
    busy.current = true;
    try {
      const result = await session.current.requestMove(command as never, request as never);
      if ('needsCopy' in result) {setLastError('needs-copy'); setLastOperation('copy-confirm'); setCopyRequest(session.current.copyRequest); return;}
      await applyOutcome(command, result as never);
    } finally {busy.current = false;}
  };
  const confirmCopy = async (): Promise<void> => {
    busy.current = true;
    try {
      const result = await session.current.confirmCopy();
      setCopyRequest(null);
      await applyOutcome({kind: 'clip-move', clipId: selectedClipId}, result as never);
    } finally {busy.current = false;}
  };
  const cancelCopy = (): void => {session.current.cancelCopy(); setCopyRequest(null); setLastOperation('copy-cancelled');};
  const sequenceFor = (clipId: string | undefined): EditUiInspectorSequence | null => {
    if (!data || !clipId) return null;
    return format5InspectorSequence(timeline as never, data.shots as never, data.versions as never, clipId, {});
  };
  const selectedSequence = sequenceFor(selectedClipId);
  const undoNotice = async (): Promise<void> => {
    const view = await rpc('sequence.history.get', {projectId}) as SequenceHistoryView;
    if (!view.undo || view.undo.actionId !== noticeActionId) {setNotice(null); return;}
    const result = await session.current.undo(view);
    setLastOperation('notice-undo');
    setLastError(result.ok ? '' : result.code);
    if (result.ok) {setNotice(null); await refresh();}
  };
  const exportCheck = async (): Promise<void> => {
    if (!timeline) return;
    const report = await rpc('timeline.export.preflight', {projectId, expectedRevision: timeline.revision}) as Row;
    setLastOperation('preflight:' + String(report.status));
    setExportIssues((report.issues ?? []).filter((issue: Row) => issue.severity === 'error').map((issue: Row) => ({code: String(issue.code), clipId: String(issue.clipId ?? '')})));
    setData({...data!, timeline});
  };

  if (!data) return <div className="wire-shell" data-testid="wire-loading">loading</div>;
  return <div className="wire-shell">
    <header className="wire-toolbar">
      <strong>剪辑 · 格式 5（真实 RPC）</strong>
      <button type="button" data-testid="wire-lock" onClick={() => {void lockSelected();}}>锁定/跟随</button>
      <button type="button" data-testid="wire-split" onClick={() => {void splitSelected();}}>切开</button>
      <button type="button" data-testid="wire-trim" onClick={() => {void trimSelected();}}>修剪</button>
      <button type="button" data-testid="wire-move-copy" onClick={() => {void moveSelected();}}>移到 V2</button>
      <button type="button" data-testid="wire-delete" onClick={() => {void removeSelected();}}>删除</button>
      <button type="button" data-testid="wire-undo" onClick={() => {void undoNotice();}}>撤销条</button>
      <button type="button" data-testid="wire-export" onClick={() => {void exportCheck();}}>导出检查</button>
      <button type="button" data-testid="wire-undo-key" onClick={() => {void (async () => {
        const view = await rpc('sequence.history.get', {projectId}) as SequenceHistoryView;
        await session.current.undo(view); setLastOperation('undo'); await refresh();
      })();}}>Cmd+Z</button>
      <button type="button" data-testid="wire-redo-key" onClick={() => {void (async () => {
        const view = await rpc('sequence.history.get', {projectId}) as SequenceHistoryView;
        await session.current.redo(view); setLastOperation('redo'); await refresh();
      })();}}>Shift+Cmd+Z</button>
      <span className="wire-state" data-testid="wire-state" data-operation={lastOperation} data-error={lastError}
        data-clips={data.timeline.clips.length} data-position={history?.position ?? -1}>{lastOperation || 'ready'}{lastError ? ` · ${lastError}` : ''}</span>
    </header>
    <div className="wire-main">
      <section className="wire-canvas">
        <Timeline timeline={timeline as never} assets={data.assets as never} editUiProjection={projection}
          historyState={historyState!} splitState={splitState!} onHistory={() => undefined} onSplit={() => {void splitSelected();}}
          onSelectClip={id => {setSelectedClipId(id); setPlayhead(timeline!.clips.find((item: Row) => item.id === id)?.startFrame ?? 0);}}
          selectedClipId={selectedClipId} selectedCueId={null} onSelectSubtitle={() => undefined}
          onAddSubtitle={() => undefined} onAddAsset={() => undefined} onMoveClip={(clipId: string, trackId: string, startFrame: number) => {void (async () => {
            setSelectedClipId(clipId);
            const clip = data.timeline.clips.find((item: Row) => item.id === clipId);
            if (!clip) return;
            const source = (clip as Row).sequenceSource;
            const command = trackId === mainTrackId
              ? format5MoveCommand(clipId, data.timeline.clips.find((item: Row) => item.trackId === mainTrackId && item.id !== clipId && item.startFrame > startFrame)?.id ?? null)
              : format5MoveOffTrackCommand(clipId, trackId, startFrame);
            const request = {clipId, nodeId: source?.nodeId ?? '', segmentGroupId: source?.segmentGroupId ?? '', targetTrackId: trackId, targetStartFrame: startFrame, timelineRevision: timeline!.revision};
            busy.current = true;
            try {const result = await session.current.requestMove(command as never, request as never);
              if ('needsCopy' in result) {setCopyRequest(session.current.copyRequest); setLastOperation('copy-confirm'); return;}
              await applyOutcome(command, result as never);
            } finally {busy.current = false;}
          })();}}
          onRemove={(clipId: string) => {setSelectedClipId(clipId); void run(format5RemoveCommand(clipId));}}
          onRippleRemove={(clipId: string) => {setSelectedClipId(clipId); void run(format5RemoveCommand(clipId));}}
          onTrackAdd={() => undefined} onTrackUpdate={() => undefined} onSeed={() => undefined} onRender={() => undefined}
          onSeek={setPlayhead} playhead={playhead} collapsed={false} onCollapse={() => undefined} busy={false}
          viewState={{pixelsPerSecond: 60, scrollLeft: 0, scrollTop: 0, snappingEnabled: true}} />
      </section>
      <aside className="wire-inspector">
        {selectedSequence ? <ShotVersionBar sequence={{...selectedSequence,
          onRevealShot: () => setLastOperation('reveal'),
          onVersionChoice: choice => {void (async () => {
            const result = await session.current.run(format5VersionCommand(selectedClipId, choice));
            await applyOutcome({kind: 'clip-version', clipId: selectedClipId}, result as never);
          })();}}} /> : <p data-testid="wire-no-shot">非镜头片段</p>}
        <pre className="wire-inspector-state" data-testid="wire-inspector-state">{JSON.stringify({
          clip: selectedClipId, mode: selectedSequence?.versionMode ?? null,
          applied: selectedSequence?.appliedVersion?.number ?? null,
          board: selectedSequence?.boardVersion?.number ?? null,
        })}</pre>
        {exportIssues.length > 0 && <div className="wire-export-issues" data-testid="wire-export-issues">
          {exportIssues.map(issue => <div key={issue.code} data-testid="wire-export-issue" data-code={issue.code}>
            <span>{issue.code === 'PLACEHOLDER_CLIP' ? t('export.preflight.issue.PLACEHOLDER_CLIP') : t('export.preflight.issue.VERSION_TOO_SHORT')}</span>
            <button type="button" data-testid="wire-export-locate" onClick={() => setSelectedClipId(issue.clipId)}>定位</button>
          </div>)}
        </div>}
      </aside>
    </div>
    {notice && <EditUiNoticeBar notice={notice} onUndo={() => {void undoNotice();}} onDismiss={() => setNotice(null)} />}
    <CopyMoveConfirmDialog request={copyRequest} onConfirm={() => {void confirmCopy();}} onCancel={cancelCopy} />
  </div>;
}

const language = createLanguageStore({systemLanguages: ['zh-Hans']});
createRoot(document.getElementById('root')!).render(<React.StrictMode><I18nProvider store={language}><Harness /></I18nProvider></React.StrictMode>);
