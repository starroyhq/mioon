/** Real-RPC headless harness for a lost format-5 commit response. Renders the
 * production Timeline, notice bar, the new unconfirmed bar and the production
 * `Format5EditSession` + `createRequestOutcomeClient` against a real format-5
 * kernel served through the real project service. Only the surrounding shell is
 * a fixture; no command, receipt or commit response is mocked. */
import React, {useEffect, useMemo, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import '../../../packages/ui/src/styles/globals.css';
import '../../../apps/web/src/styles.css';
import '../../../apps/web/src/edit-ui/edit-ui.css';
import '../edit-ui-wire/fixture.css';
import Timeline from '../../../apps/web/src/Timeline.tsx';
import {I18nProvider, createLanguageStore, useI18n} from '../../../apps/web/src/i18n/I18nProvider.tsx';
import {timelineHistoryState} from '../../../apps/web/src/timeline-history.ts';
import {timelineSplitState} from '../../../apps/web/src/timeline-split.ts';
import EditUiNoticeBar, {EditUiUnknownBar} from '../../../apps/web/src/edit-ui/EditUiNotice.tsx';
import type {EditUiNotice} from '../../../apps/web/src/edit-ui/EditUiNotice.tsx';
import {
  Format5EditSession, format5Projection, format5TrimCommand,
} from '../../../apps/web/src/edit-ui/session.ts';
import type {SequenceHistoryView} from '../../../apps/web/src/edit-ui/session.ts';
import {LostResponseState} from '../../../apps/web/src/edit-ui/lost-response.ts';
import type {LostResponseView} from '../../../apps/web/src/edit-ui/lost-response.ts';
import {createRequestOutcomeClient} from '../../../apps/web/src/request-outcome-client.ts';

type Row = Record<string, any>;
interface WireData {project: Row; timeline: Row; shots: readonly Row[]; versions: readonly Row[]; assets: readonly Row[];
  projectFormatVersion: 5}
const projectId = '90000000-0000-4000-8000-000000000001';
const mainTrackId = '90000000-0000-4000-8000-000000000060';
const clipA2 = '90000000-0000-4000-8000-000000000031';
const outcomeClient = createRequestOutcomeClient({});
const rpc = async (operation: string, input: unknown): Promise<any> => {
  const response = await fetch('/rpc', {method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({operation, input})});
  const body = await response.json() as {ok: boolean; data?: any; error?: {code?: string; message?: string}};
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

const startedAt = Date.now();
const wireLog = (event: Record<string, unknown>): void => {
  const log = ((window as any).__wireLog = (window as any).__wireLog ?? []);
  log.push({t: Date.now() - startedAt, ...event});
};

function Harness(): React.ReactElement {
  const {t} = useI18n();
  const [data, setData] = useState<WireData | null>(null);
  const [history, setHistory] = useState<SequenceHistoryView | null>(null);
  const [selectedClipId, setSelectedClipId] = useState(clipA2);
  const [playhead, setPlayhead] = useState(0);
  const [notice, setNotice] = useState<EditUiNotice | null>(null);
  const [unresolved, setUnresolved] = useState<LostResponseView | null>(null);
  const [lastOperation, setLastOperation] = useState('');
  const [lastError, setLastError] = useState('');
  const [retries, setRetries] = useState(0);
  const lost = useRef<LostResponseState | null>(null);
  if (!lost.current) lost.current = new LostResponseState({readOutcome: outcomeClient.read, onChange: view => setUnresolved(view)});
  const session = useRef<Format5EditSession | null>(null);
  if (!session.current) session.current = new Format5EditSession(rpc, () => projectId, {lost: lost.current});
  const stateRef = useRef<Row>({});
  stateRef.current = {data, history, selectedClipId, notice, unresolved, lastOperation, lastError};

  const refresh = async (): Promise<void> => {
    const project = await rpc('project.get', {projectId}) as WireData;
    project.projectFormatVersion = 5;
    const view = await rpc('sequence.history.get', {projectId}) as SequenceHistoryView;
    setData(project); setHistory(view);
  };
  useEffect(() => { void refresh().then(async () => {
    const state = await (await fetch('/debug/state')).json();
    stateRef.current.ready = true;
    stateRef.current.debug = state;
  }); }, []);
  useEffect(() => {(window as any).__wireState = {...stateRef.current, ready: Boolean(data)};}, [data, history, selectedClipId, notice, unresolved, lastOperation, lastError]);
  useEffect(() => {wireLog({event: 'state', unresolved: unresolved?.requestId ?? null, operation: lastOperation, error: lastError});},
    [unresolved, lastOperation, lastError]);

  const appliedNotice = (message: string): void => {
    setNotice({id: `wire-${Date.now()}`, message});
  };
  const applyOutcome = async (operation: string, result: {ok: boolean; code?: string; resolvedFromReceipt?: true},
    successMessage: string): Promise<boolean> => {
    setLastOperation(operation);
    if (!result.ok) {setLastError(result.code ?? 'UNKNOWN'); return false;}
    setLastError('');
    appliedNotice(result.resolvedFromReceipt ? t('editUi.notice.resultApplied') : successMessage);
    await refresh();
    return true;
  };
  const trimSelected = async (): Promise<void> => {
    wireLog({event: 'trim-clicked'});
    const clip = data?.timeline.clips.find((item: Row) => item.id === selectedClipId);
    if (!clip) return;
    const result = await session.current!.run(format5TrimCommand(clip.id, Math.max(1, clip.durationFrames - 5)));
    await applyOutcome('clip-trim', result, t('editUi.notice.trimmed', {name: clip.name ?? ''}));
  };
  const addTrack = async (): Promise<void> => {
    const trackId = crypto.randomUUID();
    const result = await session.current!.runTrack({side: 'timeline',
      operation: {kind: 'track-structure', edit: {kind: 'add', trackId, trackKind: 'video'}}});
    await applyOutcome('track-add', result, t('editUi.notice.trackAdded', {kind: t('timeline.view.videoTrack')}));
  };
  const retryUnconfirmed = async (): Promise<void> => {
    wireLog({event: 'retry-called', requestId: unresolved?.requestId ?? null});
    setRetries(value => value + 1);
    const result = await lost.current!.retry();
    wireLog({event: 'retry-result', result});
    setLastOperation('retry');
    if (result.ok) {setLastError(''); appliedNotice(t('editUi.notice.resultApplied')); await refresh();}
    else if (!result.unconfirmed) setLastError(result.code);
  };
  const abandonUnconfirmed = (): void => {
    lost.current!.abandon();
    setLastOperation('abandon');
  };

  const timeline = data?.timeline ?? null;
  const projection = useMemo(() => data ? format5Projection(timeline as never, data.shots as never, data.versions as never) : null,
    [data, timeline]);
  const splitState = useMemo(() => data ? timelineSplitState({projectId, timeline: timeline as never,
    history: historySource(data, history), busy: false, pending: false, dirty: false, online: true,
    selectedClipId, playhead, mode: 'editing'}) : null, [data, timeline, history, selectedClipId, playhead]);
  const historyState = useMemo(() => data ? timelineHistoryState({projectId, timeline: timeline as never,
    history: historySource(data, history), busy: false, pending: false, dirty: false, online: true}) : null,
  [data, timeline, history]);

  if (!data) return <div className="wire-shell" data-testid="wire-loading">loading</div>;
  return <div className="wire-shell">
    <header className="wire-toolbar">
      <strong>格式 5 · 提交丢响应（真实 RPC）</strong>
      <button type="button" data-testid="wire-trim" onClick={() => {void trimSelected();}}>修剪选中</button>
      <button type="button" data-testid="wire-track-add" onClick={() => {void addTrack();}}>加轨道</button>
      <span className="wire-state" data-testid="wire-state" data-operation={lastOperation} data-error={lastError}
        data-position={history?.position ?? -1} data-unconfirmed={unresolved?.requestId ?? ''} data-retries={retries}
        data-clips={data.timeline.clips.length}>
        {lastOperation || 'ready'}{lastError ? ` · ${lastError}` : ''}{unresolved ? ' · unconfirmed' : ''}
      </span>
    </header>
    <div className="wire-main">
      <section className="wire-canvas">
        <Timeline timeline={timeline as never} assets={data.assets as never} editUiProjection={projection}
          historyState={historyState!} splitState={splitState!} onHistory={() => undefined} onSplit={() => undefined}
          onSelectClip={id => {setSelectedClipId(id); setPlayhead(timeline!.clips.find((item: Row) => item.id === id)?.startFrame ?? 0);}}
          selectedClipId={selectedClipId} selectedCueId={null} onSelectSubtitle={() => undefined}
          onAddSubtitle={() => undefined} onAddAsset={() => undefined} onMoveClip={() => undefined}
          onRemove={() => undefined} onRippleRemove={() => undefined}
          onTrackAdd={() => undefined} onTrackUpdate={() => undefined} onSeed={() => undefined} onRender={() => undefined}
          onSeek={setPlayhead} playhead={playhead} collapsed={false} onCollapse={() => undefined} busy={false}
          viewState={{pixelsPerSecond: 60, scrollLeft: 0, scrollTop: 0, snappingEnabled: true}} />
      </section>
      <aside className="wire-inspector">
        <pre className="wire-inspector-state" data-testid="wire-inspector-state">{JSON.stringify({
          clip: selectedClipId, position: history?.position ?? null, unconfirmed: unresolved?.requestId ?? null})}</pre>
      </aside>
    </div>
    {notice && <EditUiNoticeBar notice={notice} onUndo={() => setNotice(null)} onDismiss={() => setNotice(null)} />}
    <EditUiUnknownBar view={unresolved} onRetry={() => {void retryUnconfirmed();}} onAbandon={abandonUnconfirmed} />
  </div>;
}

const language = createLanguageStore({systemLanguages: ['zh-Hans']});
createRoot(document.getElementById('root')!).render(<React.StrictMode><I18nProvider store={language}><Harness /></I18nProvider></React.StrictMode>);
