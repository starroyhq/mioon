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
import type {SequenceEditAllocation, SequenceEditIntent, SubjectEditOperation} from '../../../../packages/contracts/src/sequence-edit.ts';
import {subjectBindingCreateOperation, subjectBindingDetachOperation, subjectBindingRestoreOperation,
  subjectCardCreateOperation} from './live.ts';
import type {BoardEditRequest, SequenceGenerationInputView} from './inputs.ts';
import {referenceAttachRequest, referenceDetachRequest, unsupportedReferenceEdgeIds} from './inputs.ts';

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
  /** RI-b reference-line actions (attach/role/reorder/detach). Subject-card
   * lines keep their SB-b `runSubject` path. */
  readonly runReference: (request: BoardEditRequest, noticeMessage: string) => Promise<BoardOutcome>;
  readonly runSubject: (operation: SubjectEditOperation, allocation: SequenceEditAllocation | undefined,
    noticeMessage: string) => Promise<BoardOutcome>;
  /** RI-b live generation inputs of the selected service for the selected shot;
   * unsupported reference lines get the connector marker from this projection. */
  readonly inputs?: SequenceGenerationInputView | null;
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
  const [subjectPicker, setSubjectPicker] = useState(false);
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
  const subjectOp = useCallback(async (operation: SubjectEditOperation, allocation: SequenceEditAllocation | undefined,
    noticeMessage: string): Promise<void> => {
    setErrorCode(null);
    const outcome = await props.runSubject(operation, allocation, noticeMessage);
    if (!outcome.ok) setErrorCode(outcome.code);
    else if (outcome.status === 'not_applied') setErrorCode('SEQUENCE_EDIT_NOOP');
  }, [props.runSubject]);
  const editSubject = (operation: SubjectEditOperation, allocation: SequenceEditAllocation | undefined,
    noticeMessage: string): void => { if (!busy) void subjectOp(operation, allocation, noticeMessage); };
  const referenceOp = useCallback(async (request: BoardEditRequest, noticeMessage: string): Promise<void> => {
    setErrorCode(null);
    const outcome = await props.runReference(request, noticeMessage);
    if (!outcome.ok) setErrorCode(outcome.code);
    else if (outcome.status === 'not_applied') setErrorCode('SEQUENCE_EDIT_NOOP');
  }, [props.runReference]);
  const editReference = (request: BoardEditRequest, noticeMessage: string): void => {
    if (!busy) void referenceOp(request, noticeMessage);
  };
  const connectSequence = (connection: BoardPortConnection): void => {
    if (busy) return;
    if (connection.kind === 'sequence') {
      edit(boardConnectIntent(connection.sourceId, connection.targetId), t('boardUi.notice.inserted', {name: nameOf(connection.sourceId)}));
      return;
    }
    const source = props.board.nodes.find(node => node.id === connection.sourceId);
    const target = props.board.nodes.find(node => node.id === connection.targetId);
    // RI-b: a material card (image/video/audio/previs) becomes a reference line.
    if (source && source.kind !== 'subject' && target?.kind === 'shot') {
      editReference(referenceAttachRequest(source.id, target.id, connection.role),
        t('boardUi.notice.referenceAttached', {name: target.name}));
      return;
    }
    // SB-b: a subject card's reference line to a shot is one subject binding.
    if (source?.kind !== 'subject' || !source.subjectId || target?.kind !== 'shot') {
      setErrorCode('REFERENCE_READONLY');
      return;
    }
    const role = source.subjectKind === 'look' ? 'style' : 'subject' as const;
    const mount = props.mount;
    const existing = mount?.bindings.find(binding => binding.shotId === target.id
      && binding.subjectId === source.subjectId && binding.role === role);
    const edgeId = uuid();
    const allocation = {clips: [], nodes: [], splitClips: [], edges: [{id: edgeId, fromId: source.id, toId: target.id}]};
    if (existing?.bindingMode === 'detached') {
      editSubject(subjectBindingRestoreOperation(existing.id, 'follow', null), allocation,
        t('boardUi.notice.subjectLinked', {name: source.name}));
      return;
    }
    if (existing) {setErrorCode('SEQUENCE_EDIT_SUBJECT_BINDING_INVALID'); return;}
    editSubject(subjectBindingCreateOperation(uuid(), target.id, source.subjectId, role), allocation,
      t('boardUi.notice.subjectLinked', {name: source.name}));
  };
  const detachReference = (): void => {
    if (!selectedEdge || selectedEdge.kind !== 'reference') return;
    if (selectedEdge.role === 'subject_reference' || selectedEdge.role === 'style_reference') {
      const binding = props.mount?.bindings.find(item => item.edgeId === selectedEdge.id);
      if (!binding) {setErrorCode('SEQUENCE_EDIT_SUBJECT_BINDING_INVALID'); return;}
      editSubject(subjectBindingDetachOperation(binding.id), undefined, t('boardUi.notice.subjectDetached'));
      setSelectedEdgeId(null);
      return;
    }
    if (selectedEdge.sourceAssetId === undefined) {setErrorCode('REFERENCE_READONLY'); return;}
    const target = props.board.nodes.find(node => node.id === selectedEdge.targetId);
    editReference(referenceDetachRequest(selectedEdge.id, selectedEdge.targetId),
      t('boardUi.notice.referenceDetached', {name: target?.name ?? ''}));
    setSelectedEdgeId(null);
  };
  const addSubject = (subjectId: string, subjectName: string): void => {
    const position = {x: Math.max(0, ...Object.values(props.board.positions).map(point => point.x)) + 340, y: 120};
    editSubject(subjectCardCreateOperation(uuid(), subjectId, position), undefined,
      t('boardUi.notice.subjectCardAdded', {name: subjectName}));
    setSubjectPicker(false);
  };
  const dropSubject = (subjectId: string, position: {x: number; y: number}): void => {
    const subject = props.mount?.subjects.find(item => item.id === subjectId);
    if (!subject) return;
    editSubject(subjectCardCreateOperation(uuid(), subjectId, position), undefined,
      t('boardUi.notice.subjectCardAdded', {name: subject.name}));
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
  const unsupportedEdges = unsupportedReferenceEdgeIds(props.inputs, props.board.edges);
  const error = errorCode === 'REFERENCE_READONLY' ? t('boardUi.referenceReadonly')
    : errorCode ? messageOf(t, errorCode) : null;
  return <div className="board-ui-live" data-testid="board-ui-live" data-busy={busy ? 'true' : undefined}>
    <BoardUiStatic projection={props.board.projection} nodes={props.board.nodes} edges={props.board.edges}
      positions={props.board.positions} reduceMotion={props.reduceMotion} selectedNodeId={props.selectedNodeId}
      onSelectNode={props.onSelectNode} onConnect={connectSequence} onAddShot={addShot}
      showInspector={false} selectedEdgeId={selectedEdgeId} onSelectEdge={setSelectedEdgeId}
      onNodesMoved={moveNodes} filmSynced={props.mount?.inSync ?? true} virtualize={props.board.nodes.length > 200}
      onSubjectDrop={dropSubject} unsupportedEdgeIds={unsupportedEdges}/>
    <div className="board-ui-live-toolbar" role="toolbar" aria-label={t('boardUi.board')}>
      <button type="button" data-testid="board-ui-add-shot" disabled={busy} onClick={addShot}>{t('boardUi.addShot')}</button>
      <button type="button" data-testid="board-ui-add-root" disabled={busy} onClick={addRoot}>{t('boardUi.addRoot')}</button>
      <button type="button" data-testid="board-ui-add-subject" disabled={busy} aria-expanded={subjectPicker}
        onClick={() => setSubjectPicker(open => !open)}>{t('boardUi.addSubject')}</button>
      <button type="button" data-testid="board-ui-archive" disabled={busy} aria-expanded={archiveOpen}
        onClick={() => setArchiveOpen(open => !open)}>{t('boardUi.archiveCount', {count: archived.length})}</button>
    </div>
    {subjectPicker && <div className="board-ui-live-subject-picker" data-testid="board-ui-subject-picker" role="dialog"
      aria-label={t('boardUi.addSubject')}>
      <header><strong>{t('boardUi.addSubject')}</strong><button type="button" aria-label={t('boardUi.collapse')}
        onClick={() => setSubjectPicker(false)}>×</button></header>
      {(props.mount?.subjects ?? []).filter(subject => !props.board.nodes.some(node => node.subjectId === subject.id)).length
        ? <ul>{(props.mount?.subjects ?? []).filter(subject => !props.board.nodes.some(node => node.subjectId === subject.id))
          .map(subject => <li key={subject.id}><span title={subject.name}>{subject.name}</span>
            <button type="button" data-testid={`board-ui-subject-add-${subject.id}`} disabled={busy}
              onClick={() => addSubject(subject.id, subject.name)}>{t('boardUi.addSubject')}</button></li>)}</ul>
        : <p>{t('boardUi.subjectPickerEmpty')}</p>}
    </div>}
    {selectedEdge && <div className="board-ui-live-actions" role="toolbar" aria-label={t('boardUi.board')}>
      {selectedEdge.kind === 'sequence' && selected && canInsert(selected.id, selectedEdge) &&
        <button type="button" data-testid="board-ui-insert" disabled={busy} onClick={insert}>{t('boardUi.insertHere')}</button>}
      {selectedEdge.kind === 'sequence' && <button type="button" data-testid="board-ui-disconnect" disabled={busy}
        onClick={disconnect}>{t('boardUi.disconnectEdge')}</button>}
      {(selectedEdge.kind === 'reference' && (selectedEdge.role === 'subject_reference' || selectedEdge.role === 'style_reference')
        || selectedEdge.kind === 'reference' && selectedEdge.sourceAssetId !== undefined)
        && <button type="button" data-testid="board-ui-reference-detach" disabled={busy}
          onClick={detachReference}>{t('boardUi.disconnectEdge')}</button>}
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
