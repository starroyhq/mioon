/** Real format-5 board-RPC harness for UI-B2. Mounts the production
 * BoardUiLive/BoardInspector/session over the real project service; only the
 * shell around the board is a fixture. */
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import '../../../packages/ui/src/styles/globals.css';
import '../../../apps/web/src/styles.css';
import '../../../apps/web/src/edit-ui/edit-ui.css';
import '../../../apps/web/src/board-ui/board-ui.css';
import './fixture.css';
import {I18nProvider, createLanguageStore, useI18n} from '../../../apps/web/src/i18n/I18nProvider.tsx';
import BoardUiLive from '../../../apps/web/src/board-ui/BoardUiLive.tsx';
import BoardInspector from '../../../apps/web/src/board-ui/BoardInspector.tsx';
import {projectLiveBoard, boardConnectIntent, boardDeleteIntent, boardVersionIntent,
  subjectBindingDetachOperation, subjectBindingModeOperation, subjectBindingRestoreOperation,
  subjectCardCreateOperation, subjectCardDeleteOperation} from '../../../apps/web/src/board-ui/live.ts';
import {dragSubject} from '../../../apps/web/src/board-ui/subject-drag.ts';
import {BoardUiSession} from '../../../apps/web/src/board-ui/live-session.ts';
import type {BoardBinding, BoardMountView, BoardOutcome} from '../../../apps/web/src/board-ui/live-session.ts';
import type {EditUiNotice} from '../../../apps/web/src/edit-ui/EditUiNotice.tsx';
import type {SequenceHistoryView} from '../../../apps/web/src/edit-ui/session.ts';
import type {SequenceEditAllocation, SequenceEditIntent, SubjectEditOperation} from '../../../packages/contracts/src/sequence-edit.ts';

type Row = Record<string, any>;
const projectId = '70000000-0000-4000-8000-000000000001';
const rpc = async (operation: string, input: unknown): Promise<any> => {
  const response = await fetch('/rpc', {method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({operation, input})});
  const body = await response.json() as {ok: boolean; data?: any; error?: {code?: string; message?: string}};
  if (!body.ok) throw Object.assign(new Error(body.error?.message ?? 'RPC failed'), {code: body.error?.code ?? 'RPC_FAILED'});
  return body.data;
};
const syntheticThumb = (assetId: string): string => {
  const colors = ['#284b63', '#846b3e', '#5c3f66', '#2f5d50'];
  const color = colors[[...assetId].reduce((sum, character) => sum + character.charCodeAt(0), 0) % colors.length];
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270"><rect width="480" height="270" fill="${color}"/><circle cx="240" cy="122" r="52" fill="#e8e2d2" opacity=".85"/><rect x="20" y="236" width="150" height="8" rx="4" fill="#e8e2d2" opacity=".35"/></svg>`)}`;
};
const uuid = (): string => globalThis.crypto.randomUUID();
const SUBJECT_CHARACTER = '70000000-0000-4000-8000-000000000090';
const SUBJECT_LOOK = '70000000-0000-4000-8000-000000000091';

function Harness(): React.ReactElement {
  const {t} = useI18n();
  const [data, setData] = useState<Row | null>(null);
  const [history, setHistory] = useState<any>(null);
  const [mount, setMount] = useState<BoardMountView | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>('70000000-0000-4000-8000-000000000003');
  const [notice, setNotice] = useState<EditUiNotice | null>(null);
  const [busy, setBusy] = useState(false);
  const [reduced, setReduced] = useState(false);
  const [openedNode, setOpenedNode] = useState<string | null>(null);
  const stateRef = useRef<Row>({});
  const session = useRef(new BoardUiSession(rpc, () => projectId));
  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await rpc('project.get', {projectId});
      next.projectFormatVersion = 5;
      const nextHistory = await rpc('sequence.history.get', {projectId});
      const nextMount = await rpc('sequence.board.get', {projectId});
      setData(next); setHistory(nextHistory); setMount(nextMount);
    } catch (error) {
      console.error('board fixture refresh failed', error);
      (window as any).__boardWireError = String((error as Error)?.message ?? error);
      throw error;
    }
  }, []);
  useEffect(() => {void refresh();}, [refresh]);
  useEffect(() => {
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const update = (): void => setReduced(query?.matches === true);
    update(); query?.addEventListener?.('change', update);
    return () => query?.removeEventListener?.('change', update);
  }, []);
  const projection = useMemo(() => data ? projectLiveBoard({shots: data.shots, nodes: data.nodes, edges: data.edges,
    versions: data.versions, assets: data.assets, jobs: data.jobs, clips: data.timeline?.clips ?? [],
    subjects: mount?.subjects ?? [], frameAspect: '9:16', thumbnailFor: syntheticThumb}) : null,
  [data, mount?.subjects]);
  const activeFilmId = data?.timeline?.mainTrack?.sequenceNodeId ?? null;
  const run = useCallback(async (intent: SequenceEditIntent, message: string): Promise<BoardOutcome> => {
    setBusy(true);
    try {
      const outcome = await session.current.run(intent);
      if (outcome.ok && outcome.status === 'applied') {
        setNotice({id: outcome.actionId, message});
        await refresh();
      }
      return outcome;
    } finally {setBusy(false);}
  }, [refresh]);
  const runSubject = useCallback(async (operation: SubjectEditOperation, allocation: SequenceEditAllocation | undefined,
    message: string): Promise<BoardOutcome> => {
    setBusy(true);
    try {
      const outcome = await session.current.runSubject(operation, allocation);
      if (outcome.ok && outcome.status === 'applied') {setNotice({id: outcome.actionId, message}); await refresh();}
      return outcome;
    } finally {setBusy(false);}
  }, [refresh]);
  const subjectName = (subjectId: string): string => mount?.subjects.find(subject => subject.id === subjectId)?.name ?? '';
  const cardNodeForSubject = (subjectId: string): string | null =>
    projection?.nodes.find(node => node.kind === 'subject' && node.subjectId === subjectId)?.id ?? null;
  const addSubjectCard = useCallback((subjectId: string, position: {x: number; y: number}): void => {
    void runSubject(subjectCardCreateOperation(uuid(), subjectId, position), undefined,
      t('boardUi.notice.subjectCardAdded', {name: mount?.subjects.find(subject => subject.id === subjectId)?.name ?? ''}));
  }, [runSubject, mount, t]);
  const setBindingMode = useCallback((binding: BoardBinding, mode: 'follow' | 'locked', versionId: string | null): void => {
    void runSubject(subjectBindingModeOperation(binding.id, mode, versionId), undefined,
      t('boardUi.notice.bindingUpdated', {name: subjectName(binding.subjectId)}));
  }, [runSubject, mount, t]);
  const detachBinding = useCallback((binding: BoardBinding): void => {
    void runSubject(subjectBindingDetachOperation(binding.id), undefined, t('boardUi.notice.subjectDetached'));
  }, [runSubject, t]);
  const restoreBinding = useCallback((binding: BoardBinding): void => {
    const cardNodeId = cardNodeForSubject(binding.subjectId);
    if (!cardNodeId) return;
    const edgeId = uuid();
    void runSubject(subjectBindingRestoreOperation(binding.id, 'follow', null),
      {clips: [], nodes: [], splitClips: [], edges: [{id: edgeId, fromId: cardNodeId, toId: binding.shotId}]},
      t('boardUi.notice.subjectLinked', {name: subjectName(binding.subjectId)}));
  }, [runSubject, projection, mount, t]);
  const deleteCard = useCallback((nodeId: string, subjectId: string): void => {
    setSelectedNodeId(null);
    void runSubject(subjectCardDeleteOperation(nodeId), undefined,
      t('boardUi.notice.subjectCardDeleted', {name: subjectName(subjectId)}));
  }, [runSubject, mount, t]);
  const undoNotice = useCallback(async (actionId: string): Promise<boolean> => {
    const view = await session.current.history();
    if (!view?.undo || view.undo.actionId !== actionId) {setNotice(null); return false;}
    const outcome = await session.current.undo(view);
    setNotice(null);
    if (outcome.ok) await refresh();
    return outcome.ok;
  }, [refresh]);
  useEffect(() => {
    const key = async (event: KeyboardEvent): Promise<void> => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'z') return;
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, [contenteditable="true"]')) return;
      event.preventDefault();
      const view = await session.current.history();
      if (!view) return;
      const outcome = event.shiftKey ? await session.current.redo(view as never) : await session.current.undo(view as never);
      if (outcome.ok) await refresh(); else setNotice({id: `error-${Date.now()}`, message: t('editUi.error.SEQUENCE_EDIT_HISTORY_CONFLICT')});
    };
    window.addEventListener('keydown', event => {void key(event);});
    return () => window.removeEventListener('keydown', () => {});
  }, [refresh, t]);
  const restore = useCallback(async (archivedId: string, name: string): Promise<void> => {
    if (!projection) return;
    const chain = projection.projection.films.find(film => film.id === activeFilmId) ?? projection.projection.films[0];
    const tail = chain?.items.at(-1)?.nodeId ?? activeFilmId;
    if (tail) await run(boardConnectIntent(tail, archivedId), t('boardUi.notice.restored', {name}));
  }, [projection, activeFilmId, run, t]);
  useEffect(() => {
    stateRef.current = {ready: Boolean(data), data, history, mount, selectedNodeId, notice, busy, reduced, openedNode,
      cards: projection?.nodes.map(node => ({id: node.id, kind: node.kind, name: node.name, subjectId: node.subjectId})) ?? [],
      films: projection?.projection.films.map(film => ({id: film.id, items: film.items.map(item => item.nodeId)})) ?? [],
      floating: projection?.projection.floatingNodeIds ?? [], positions: projection?.positions ?? {},
      timelineRevision: data?.timeline?.revision, syncRevision: mount?.syncRevision, inSync: mount?.inSync,
      subjects: mount?.subjects ?? [], bindings: mount?.bindings ?? []};
    (window as any).__boardWireState = stateRef.current;
  }, [data, history, mount, selectedNodeId, notice, busy, reduced, openedNode, projection]);
  if (!projection) return <div className="board-fixture-loading">Loading…</div>;
  return <div className="board-fixture">
    <header className="board-fixture-head"><strong>Mioon · 画板</strong><span data-testid="fixture-format">格式 5</span>
      <span data-testid="fixture-sync" data-synced={mount?.inSync ? 'true' : 'false'}>{t(mount?.inSync ? 'boardUi.synced' : 'boardUi.outOfSync')}</span></header>
    <main className="board-fixture-board" data-testid="board-fixture-board">
      <BoardUiLive board={projection} activeFilmId={activeFilmId} history={history} mount={mount}
        selectedNodeId={selectedNodeId} onSelectNode={setSelectedNodeId} run={run} runSubject={runSubject}
        onUndoNotice={undoNotice} onDismissNotice={notice => setNotice(current => current?.id === notice.id ? null : current)}
        notice={notice} reduceMotion={reduced} busy={busy}/>
    </main>
    <aside className="board-fixture-inspector">
      <BoardInspector board={projection} activeFilmId={activeFilmId} mount={mount} selectedNodeId={selectedNodeId}
        versions={data?.versions ?? []} shots={data?.shots ?? []} busy={busy}
        onSelectVersion={(nodeId, versionId) => {void run(boardVersionIntent(nodeId, versionId), t('boardUi.notice.version', {name: projection.nodes.find(node => node.id === nodeId)?.name ?? ''}));}}
        onDelete={nodeId => {void run(boardDeleteIntent(nodeId), t('boardUi.notice.deleted', {name: projection.nodes.find(node => node.id === nodeId)?.name ?? ''})); setSelectedNodeId(null);}}
        onOpenInEditing={nodeId => setOpenedNode(nodeId)}
        onRestore={(archivedId, name) => {void restore(archivedId, name);}}
        onSetBindingMode={setBindingMode} onDetachBinding={detachBinding} onRestoreBinding={restoreBinding}
        onDeleteSubjectCard={deleteCard}/>
      <section className="board-fixture-subjects" data-testid="board-fixture-subjects">
        <h4>{t('boardUi.inspector.subjects')}</h4>
        {(mount?.subjects ?? []).map(subject => <div key={subject.id} className="board-fixture-subject"
          data-testid={`fixture-subject-${subject.id}`} draggable
          onDragStart={event => dragSubject(event.nativeEvent, subject.id)}
          onClick={() => addSubjectCard(subject.id, {x: 620, y: 260})} role="button" tabIndex={0}
          onKeyDown={event => {if (event.key === 'Enter' || event.key === ' ') {event.preventDefault(); addSubjectCard(subject.id, {x: 620, y: 260});}}}>
          <span>{subject.name}</span><small>{t(`boardUi.kind.${subject.kind}`)}</small>
        </div>)}
      </section>
      <p className="board-fixture-opened" data-testid="board-fixture-opened">{openedNode ?? ''}</p>
    </aside>
    <div className="board-fixture-status" data-testid="board-fixture-status">
      <span data-testid="fixture-history-position">{history?.position ?? 0}</span>
      <span data-testid="fixture-history-undo">{history?.undo?.operation ?? ''}</span>
      <span data-testid="fixture-history-redo">{history?.redo?.operation ?? ''}</span>
      <span data-testid="fixture-at-earliest">{history?.atEarliest ? 'true' : 'false'}</span>
    </div>
  </div>;
}

const store = createLanguageStore({systemLanguages: ['zh-Hans']});
createRoot(document.getElementById('root')!).render(<I18nProvider store={store}><Harness/></I18nProvider>);
