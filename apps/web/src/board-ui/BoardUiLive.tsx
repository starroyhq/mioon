/** UI-B2: the real-data board. It mounts the saved UI-B1 presentation over the
 * format-5 projection and routes every graph command through the one
 * preview -> commit RPC. Selection, errors and the undo notice stay local; the
 * surrounding workbench supplies data, session and refresh. */
import React, {useCallback, useState} from 'react';
import {useI18n} from '../i18n/I18nProvider.tsx';
import {format5CommandErrorMessageKey} from '../edit-ui/session.ts';
import EditUiNoticeBar from '../edit-ui/EditUiNotice.tsx';
import type {EditUiNotice} from '../edit-ui/EditUiNotice.tsx';
import BoardUiStatic from './BoardUiStatic.tsx';
import type {BoardPortConnection} from './connection-ports.ts';
import type {BoardUiEdge} from './BoardUiStatic.tsx';
import type {BoardLive} from './live.ts';
import {boardConnectIntent, boardDisconnectIntent, boardInsertIntent,
  boardLayoutIntent, boardRootCreateIntent, boardShotAppendIntent} from './live.ts';
import type {BoardHistoryView, BoardMountView, BoardOutcome} from './live-session.ts';
import type {SequenceEditIntent} from '../../../../packages/contracts/src/sequence-edit.ts';

type Row = Record<string, any>;
const uuid = (): string => globalThis.crypto?.randomUUID?.() ??
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, character => {
    const value = Math.floor(Math.random() * 16);
    return (character === 'x' ? value : (value & 0x3) | 0x8).toString(16);
  });

export interface BoardUiLiveProps {
  readonly board: BoardLive;
  readonly activeFilmId: string | null;
  readonly history: BoardHistoryView | null;
  readonly mount: BoardMountView | null;
  readonly selectedNodeId: string | null;
  readonly onSelectNode: (nodeId: string | null) => void;
  readonly run: (intent: SequenceEditIntent, noticeMessage: string) => Promise<BoardOutcome>;
  readonly onUndoNotice: (actionId: string) => Promise<boolean> | boolean | void;
  readonly onDismissNotice: (notice: EditUiNotice) => void;
  readonly notice: EditUiNotice | null;
  readonly reduceMotion?: boolean;
  readonly busy?: boolean;
  readonly showErrors?: boolean;
}

function messageOf(t: ReturnType<typeof useI18n>['t'], code: string): string {
  return t(format5CommandErrorMessageKey(code) as never);
}

export default function BoardUiLive(props: BoardUiLiveProps): React.ReactElement {
  const {t} = useI18n();
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const busy = Boolean(props.busy);
  const selected = props.selectedNodeId ? props.board.nodes.find(node => node.id === props.selectedNodeId) ?? null : null;
  const selectedEdge = selectedEdgeId ? props.board.edges.find(edge => edge.id === selectedEdgeId) ?? null : null;
  const film = props.board.projection.films.find(item => item.id === props.activeFilmId) ?? props.board.projection.films[0] ?? null;
  const call = useCallback(async (intent: SequenceEditIntent, noticeMessage: string): Promise<void> => {
    setErrorCode(null);
    const outcome = await props.run(intent, noticeMessage);
    if (!outcome.ok) setErrorCode(outcome.code);
    else if (outcome.status === 'not_applied') setErrorCode('SEQUENCE_EDIT_NOOP');
  }, [props.run]);
  const edit = (intent: SequenceEditIntent, noticeMessage: string): void => { if (!busy) void call(intent, noticeMessage); };
  const connectSequence = (connection: BoardPortConnection): void => {
    if (busy) return;
    if (connection.kind !== 'sequence') {setErrorCode('REFERENCE_READONLY'); return;}
    edit(boardConnectIntent(connection.sourceId, connection.targetId), t('boardUi.notice.inserted', {name: nameOf(connection.sourceId)}));
  };
  const nameOf = (nodeId: string): string => props.board.nodes.find(node => node.id === nodeId)?.name ?? '';
  const disconnect = (): void => {
    if (!selectedEdge || selectedEdge.kind !== 'sequence') return;
    edit(boardDisconnectIntent(selectedEdge.sourceId, selectedEdge.targetId), t('boardUi.notice.disconnected'));
    setSelectedEdgeId(null);
  };
  const insert = (): void => {
    if (!selectedEdge || !selected || selectedEdge.kind !== 'sequence') return;
    if (selected.id === selectedEdge.sourceId || selected.id === selectedEdge.targetId || selected.kind === 'film' || selected.kind === 'subject') return;
    edit(boardInsertIntent(selectedEdge.sourceId, selectedEdge.targetId, selected.id),
      t('boardUi.notice.inserted', {name: selected.name}));
    setSelectedEdgeId(null);
  };
  const addShot = (): void => {
    const count = props.board.projection.films.reduce((sum, item) => sum + item.items.filter(entry => entry.kind === 'shot').length, 0) + 1;
    const name = t('boardUi.newShotName', {count});
    edit(boardShotAppendIntent(uuid(), name), t('boardUi.notice.shotAdded', {name}));
  };
  const addRoot = (): void => {
    const count = props.board.projection.films.length + 1;
    const name = t('boardUi.newFilmName', {count});
    const maxX = Math.max(0, ...Object.values(props.board.positions).map(position => position.x));
    edit(boardRootCreateIntent(uuid(), name, {x: maxX + 360, y: 0}), t('boardUi.notice.rootCreated', {name}));
  };
  const moveNodes = (moves: readonly {readonly nodeId: string; readonly x: number; readonly y: number}[]): void => {
    if (!moves.length || busy) return;
    edit(boardLayoutIntent(moves), t('boardUi.notice.moved', {count: moves.length}));
  };
  const restore = (archivedId: string, name: string): void => {
    if (!props.activeFilmId) return;
    const chain = props.board.projection.films.find(item => item.id === props.activeFilmId);
    const tail = chain?.items.at(-1)?.nodeId ?? props.activeFilmId;
    edit(boardConnectIntent(tail, archivedId), t('boardUi.notice.restored', {name}));
    setArchiveOpen(false);
  };
  const archived = props.mount?.archived ?? [];
  const error = errorCode === 'REFERENCE_READONLY' ? t('boardUi.referenceReadonly')
    : errorCode ? messageOf(t, errorCode) : null;
  return <div className="board-ui-live" data-testid="board-ui-live" data-busy={busy ? 'true' : undefined}>
    <BoardUiStatic projection={props.board.projection} nodes={props.board.nodes} edges={props.board.edges}
      positions={props.board.positions} reduceMotion={props.reduceMotion} selectedNodeId={props.selectedNodeId}
      onSelectNode={props.onSelectNode} onConnect={connectSequence} onAddShot={addShot}
      showInspector={false} selectedEdgeId={selectedEdgeId} onSelectEdge={setSelectedEdgeId}
      onNodesMoved={moveNodes} filmSynced={props.mount?.inSync ?? true} virtualize={props.board.nodes.length > 200}/>
    <div className="board-ui-live-toolbar" role="toolbar" aria-label={t('boardUi.board')}>
      <button type="button" data-testid="board-ui-add-shot" disabled={busy} onClick={addShot}>{t('boardUi.addShot')}</button>
      <button type="button" data-testid="board-ui-add-root" disabled={busy} onClick={addRoot}>{t('boardUi.addRoot')}</button>
      <button type="button" data-testid="board-ui-archive" disabled={busy} aria-expanded={archiveOpen}
        onClick={() => setArchiveOpen(open => !open)}>{t('boardUi.archiveCount', {count: archived.length})}</button>
    </div>
    {selectedEdge && <div className="board-ui-live-actions" role="toolbar" aria-label={t('boardUi.board')}>
      {selectedEdge.kind === 'sequence' && selected && canInsert(selected.id, selectedEdge) &&
        <button type="button" data-testid="board-ui-insert" disabled={busy} onClick={insert}>{t('boardUi.insertHere')}</button>}
      {selectedEdge.kind === 'sequence' && <button type="button" data-testid="board-ui-disconnect" disabled={busy}
        onClick={disconnect}>{t('boardUi.disconnectEdge')}</button>}
    </div>}
    {archiveOpen && <div className="board-ui-live-archive" data-testid="board-ui-archive-popover" role="dialog"
      aria-label={t('boardUi.archivedTitle')}>
      <header><strong>{t('boardUi.archivedTitle')}</strong><button type="button" aria-label={t('boardUi.collapse')}
        onClick={() => setArchiveOpen(false)}>×</button></header>
      {archived.length ? <ul>{archived.map(item => <li key={item.id}>
        <span title={item.name}>{item.name}</span>
        <button type="button" data-testid={`board-ui-restore-${item.id}`} disabled={busy}
          onClick={() => restore(item.id, item.name)}>{t('boardUi.restoreNode')}</button>
      </li>)}</ul> : <p>{t('boardUi.archiveEmpty')}</p>}
    </div>}
    {error && props.showErrors !== false && <div className="board-ui-live-error" role="alert" data-testid="board-ui-error">{error}</div>}
    <EditUiNoticeBar notice={props.notice} onUndo={notice => { void props.onUndoNotice(notice.id); }}
      onDismiss={notice => props.onDismissNotice(notice)}/>
  </div>;
}

function canInsert(nodeId: string, edge: BoardUiEdge): boolean {
  return edge.kind === 'sequence' && nodeId !== edge.sourceId && nodeId !== edge.targetId;
}
