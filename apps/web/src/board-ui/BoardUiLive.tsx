/** UI-B2: the real-data board. It mounts the saved UI-B1 presentation over the
 * format-5 projection and routes every graph command through the one
 * preview -> commit RPC. Selection, errors and the undo notice stay local; the
 * surrounding workbench supplies data, session and refresh. */
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {WorkbenchButton} from '@mioon/ui/components/workbench-controls';
import {Box, Clapperboard, ClipboardPaste, Copy, CopyPlus, Grid2X2, Image, Plus, Sparkles, Trash2, Type, User, Video, X} from '@mioon/ui/components/workbench-icons';
import {useI18n} from '../i18n/I18nProvider.tsx';
import {canvasEditMacShortcuts} from '../CanvasEditingControls.tsx';
import {format5BoardFailureMessageKey} from '../edit-ui/session.ts';
import {isSequenceEditNoop} from '../edit-ui/lost-response.ts';
import EditUiNoticeBar from '../edit-ui/EditUiNotice.tsx';
import type {EditUiNotice} from '../edit-ui/EditUiNotice.tsx';
import BoardUiStatic from './BoardUiStatic.tsx';
import type {BoardPortConnection} from './connection-ports.ts';
import type {BoardUiEdge} from './BoardUiStatic.tsx';
import type {BoardLive} from './live.ts';
import {boardConnectIntent, boardDeleteIntent, boardDisconnectIntent, boardDuplicateIntent, boardInsertIntent,
  boardLayoutIntent, boardNodeCreateIntent, boardRestoreIntent, boardRootCreateIntent, boardShotAppendIntent,
  computeBoardTidyMoves} from './live.ts';
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
  /** Workbench-owned delete decision; the context menu and Delete key use it so
   * a generated/main-track shot receives the same confirmation as the inspector. */
  readonly onDelete?: (nodeId: string) => void;
  readonly showErrors?: boolean;
  /** FR-C2: an asset-library card dropped on the board. */
  readonly onAssetDrop?: (assetId: string, position: {x: number; y: number}) => void;
  /** FR-C2: pan this newly-created card into view. */
  readonly revealNodeId?: string | null;
  /** Previs creation is the same exact-replay intent formats 3/4 use. */
  readonly onAddPrevis?: () => void;
  readonly addingPrevis?: boolean;
  readonly previsDisabled?: boolean;
  /** 21-01 toolbar parity callbacks owned by the surrounding workbench. */
  readonly onAddImage?: () => void;
  readonly onAddVideo?: () => void;
  readonly onGenerateImage?: () => void;
  readonly onOpenVersions?: (nodeId: string) => void;
}

function messageOf(t: ReturnType<typeof useI18n>['t'], failure: {code: string; reason?: string}): string {
  return t(format5BoardFailureMessageKey(failure.code, failure.reason) as never);
}

export default function BoardUiLive(props: BoardUiLiveProps): React.ReactElement {
  const {t, formatNumber} = useI18n();
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [subjectPicker, setSubjectPicker] = useState(false);
  const [failure, setFailure] = useState<{code: string; reason?: string} | null>(null);
  const [copied, setCopied] = useState<readonly {kind: 'shot' | 'node'; id: string}[]>([]);
  const [menu, setMenu] = useState<{x: number; y: number; nodeId: string} | null>(null);
  const [paneMenu, setPaneMenu] = useState<{x: number; y: number; position: {x: number; y: number}} | null>(null);
  const measuredSizesRef = useRef<Readonly<Record<string, {readonly width: number; readonly height: number}>>>({});
  const busy = Boolean(props.busy);
  const mac = canvasEditMacShortcuts();
  const commandKey = mac ? '⌘' : 'Ctrl+';
  const shortcut = {
    copy: `${commandKey}C`,
    paste: `${commandKey}V`,
    duplicate: `${commandKey}D`,
    tidy: mac ? '⇧⌘L' : 'Ctrl+Shift+L',
    del: mac ? '⌫' : 'Del',
  };
  const selected = props.selectedNodeId ? props.board.nodes.find(node => node.id === props.selectedNodeId) ?? null : null;
  const selectedEdge = selectedEdgeId ? props.board.edges.find(edge => edge.id === selectedEdgeId) ?? null : null;
  const film = props.board.projection.films.find(item => item.id === props.activeFilmId) ?? props.board.projection.films[0] ?? null;
  const call = useCallback(async (intent: SequenceEditIntent, noticeMessage: string): Promise<void> => {
    setFailure(null);
    const outcome = await props.run(intent, noticeMessage);
    if (!outcome.ok && !('unconfirmed' in outcome) && !isSequenceEditNoop(outcome)) setFailure({code: outcome.code, ...(outcome.reason ? {reason: outcome.reason} : {})});
  }, [props.run]);
  const edit = (intent: SequenceEditIntent, noticeMessage: string): void => { if (!busy) void call(intent, noticeMessage); };
  const deleteNode = (nodeId: string, name: string): void => {
    if (busy) return;
    setMenu(null);
    if (props.onDelete) { props.onDelete(nodeId); return; }
    edit(boardDeleteIntent(nodeId), t('boardUi.notice.deleted', {name}));
  };
  const subjectOp = useCallback(async (operation: SubjectEditOperation, allocation: SequenceEditAllocation | undefined,
    noticeMessage: string): Promise<void> => {
    setFailure(null);
    const outcome = await props.runSubject(operation, allocation, noticeMessage);
    if (!outcome.ok && !('unconfirmed' in outcome) && !isSequenceEditNoop(outcome)) setFailure({code: outcome.code, ...(outcome.reason ? {reason: outcome.reason} : {})});
  }, [props.runSubject]);
  const editSubject = (operation: SubjectEditOperation, allocation: SequenceEditAllocation | undefined,
    noticeMessage: string): void => { if (!busy) void subjectOp(operation, allocation, noticeMessage); };
  const referenceOp = useCallback(async (request: BoardEditRequest, noticeMessage: string): Promise<void> => {
    setFailure(null);
    const outcome = await props.runReference(request, noticeMessage);
    if (!outcome.ok && !('unconfirmed' in outcome) && !isSequenceEditNoop(outcome)) setFailure({code: outcome.code, ...(outcome.reason ? {reason: outcome.reason} : {})});
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
      setFailure({code: 'REFERENCE_READONLY'});
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
    if (existing) {setFailure({code: 'SEQUENCE_EDIT_SUBJECT_BINDING_INVALID'}); return;}
    editSubject(subjectBindingCreateOperation(uuid(), target.id, source.subjectId, role), allocation,
      t('boardUi.notice.subjectLinked', {name: source.name}));
  };
  const detachReference = (): void => {
    if (!selectedEdge || selectedEdge.kind !== 'reference') return;
    if (selectedEdge.role === 'subject_reference' || selectedEdge.role === 'style_reference') {
      const binding = props.mount?.bindings.find(item => item.edgeId === selectedEdge.id);
      if (!binding) {setFailure({code: 'SEQUENCE_EDIT_SUBJECT_BINDING_INVALID'}); return;}
      editSubject(subjectBindingDetachOperation(binding.id), undefined, t('boardUi.notice.subjectDetached'));
      setSelectedEdgeId(null);
      return;
    }
    if (selectedEdge.sourceAssetId === undefined) {setFailure({code: 'REFERENCE_READONLY'}); return;}
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
  const addText = (position?: {x: number; y: number}): void => {
    const points = Object.values(props.board.positions);
    const target = position ?? (points.length
      ? {x: Math.min(...points.map(point => point.x)), y: Math.max(...points.map(point => point.y)) + 260}
      : {x: 120, y: 260});
    edit(boardNodeCreateIntent(uuid(), 'text', t('projects.default.note'), target, {text: ''}), t('boardUi.notice.textAdded'));
  };
  const tidyBoard = (): void => {
    if (busy || !props.board.nodes.length) return;
    const moves = computeBoardTidyMoves(props.board, measuredSizesRef.current);
    setMenu(null);
    setPaneMenu(null);
    if (!moves.length) return;
    edit(boardLayoutIntent(moves), t('canvas.edit.tidiedToast', {count: moves.length}));
  };
  const canTidy = !busy && props.board.nodes.length > 0;
  const moveNodes = (moves: readonly {readonly nodeId: string; readonly x: number; readonly y: number}[]): void => {
    if (!moves.length || busy) return;
    edit(boardLayoutIntent(moves), t('boardUi.notice.moved', {count: moves.length}));
  };
  const restore = (archivedId: string, name: string): void => {
    // board.restore owns the UI-B2 semantics: shots re-enter at the active chain
    // tail, other node kinds come back detached. The archived list owns the kind
    // because the archived node is no longer part of the live board projection.
    const kind = props.mount?.archived.find(item => item.id === archivedId)?.kind ?? 'node';
    edit(boardRestoreIntent([{kind, id: archivedId}]), t('boardUi.notice.restored', {name}));
    setArchiveOpen(false);
  };
  const duplicate = (items: readonly {kind: 'shot' | 'node'; id: string}[]): void => {
    if (!items.length || busy) return;
    const maxX = Math.max(0, ...Object.values(props.board.positions).map(point => point.x));
    edit(boardDuplicateIntent(items, {x: maxX + 80, y: 120, width: 600, height: 420}),
      t('boardUi.notice.duplicated', {count: items.length}));
    setMenu(null);
  };
  const copy = (nodeId: string | null): void => {
    const node = nodeId ? props.board.nodes.find(value => value.id === nodeId) : null;
    if (!node || node.kind === 'film' || node.kind === 'subject') return;
    setCopied([{kind: node.kind === 'shot' ? 'shot' : 'node', id: node.id}]);
    setMenu(null);
  };
  useEffect(() => {
    const keydown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;
      if (!event.metaKey && !event.ctrlKey && (event.key === 'Delete' || event.key === 'Backspace')) {
        const node = props.selectedNodeId ? props.board.nodes.find(value => value.id === props.selectedNodeId) : null;
        if (node && node.kind !== 'film' && node.kind !== 'subject') {
          event.preventDefault();
          deleteNode(node.id, node.name);
        }
        return;
      }
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() === 'c') { if (props.selectedNodeId) {copy(props.selectedNodeId); event.preventDefault();} return; }
      if (event.key.toLowerCase() === 'v') { if (copied.length) {duplicate(copied); event.preventDefault();} return; }
      if (event.key.toLowerCase() === 'l' && event.shiftKey) {
        if (canTidy) {tidyBoard(); event.preventDefault();}
        return;
      }
      if (event.key.toLowerCase() === 'd') {
        const node = props.selectedNodeId ? props.board.nodes.find(value => value.id === props.selectedNodeId) : null;
        if (node && node.kind !== 'film' && node.kind !== 'subject') {
          duplicate([{kind: node.kind === 'shot' ? 'shot' : 'node', id: node.id}]);
          event.preventDefault();
        }
      }
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [busy, canTidy, copied, props.onDelete, props.selectedNodeId, props.board]);
  const archived = props.mount?.archived ?? [];
  const unsupportedEdges = unsupportedReferenceEdgeIds(props.inputs, props.board.edges);
  const error = failure?.code === 'REFERENCE_READONLY' ? t('boardUi.referenceReadonly')
    : failure ? messageOf(t, failure) : null;
  const clampMenuPoint = (x: number, y: number, width = 204, height = 248): {x: number; y: number} => {
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1440;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 900;
    return {x: Math.max(8, Math.min(x, vw - width)), y: Math.max(8, Math.min(y, vh - height))};
  };
  const contextMenu = (event: React.MouseEvent<HTMLDivElement>): void => {
    const target = (event.target as HTMLElement).closest('[data-testid^="board-card-"]');
    const nodeId = target?.getAttribute('data-testid')?.replace('board-card-', '') ?? null;
    if (!nodeId || !props.board.nodes.some(node => node.id === nodeId)) {setMenu(null); return;}
    event.preventDefault();
    setPaneMenu(null);
    const point = clampMenuPoint(event.clientX, event.clientY);
    setMenu({...point, nodeId});
  };
  const menuNode = menu ? props.board.nodes.find(node => node.id === menu.nodeId) : null;
  return <div className="board-ui-live" data-testid="board-ui-live" data-busy={busy ? 'true' : undefined}
    onContextMenu={contextMenu} onPointerDown={event => { if (!(event.target as HTMLElement).closest('.board-ui-context-menu')) {setMenu(null); setPaneMenu(null);} }}>
    <BoardUiStatic projection={props.board.projection} nodes={props.board.nodes} edges={props.board.edges}
      positions={props.board.positions} reduceMotion={props.reduceMotion} selectedNodeId={props.selectedNodeId}
      onSelectNode={props.onSelectNode} onConnect={connectSequence} onAddShot={addShot}
      onOpenVersions={props.onOpenVersions}
      onMeasuredSizesChange={sizes => {measuredSizesRef.current = sizes;}}
      showInspector={false} selectedEdgeId={selectedEdgeId} onSelectEdge={setSelectedEdgeId}
      onNodesMoved={moveNodes} filmSynced={props.mount?.inSync ?? true} virtualize={props.board.nodes.length > 200}
      onSubjectDrop={dropSubject} unsupportedEdgeIds={unsupportedEdges} onAssetDrop={props.onAssetDrop}
      onPaneContextMenu={(position, screen) => {
        setMenu(null);
        const point = clampMenuPoint(screen.x, screen.y, 196, 152);
        setPaneMenu({position, ...point});
      }}
      revealNodeId={props.revealNodeId}/>
    <div className="board-ui-live-toolbar" role="toolbar" aria-label={t('boardUi.board')}>
      <WorkbenchButton variant="primary" data-testid="board-ui-add-shot" disabled={busy} onClick={addShot}>
        <Plus size={15} aria-hidden="true"/><span>{t('boardUi.addShot')}</span>
      </WorkbenchButton>
      <span className="board-toolbar-separator" aria-hidden="true"/>
      <WorkbenchButton variant="ghost" data-testid="board-ui-add-text" aria-label={t('shell.text')} title={t('shell.text')}
        disabled={busy} onClick={() => addText()}>
        <Type size={15} aria-hidden="true"/><span className="board-tool-label">{t('shell.text')}</span>
      </WorkbenchButton>
      {props.onAddImage && <WorkbenchButton variant="ghost" data-testid="board-ui-add-image" aria-label={t('assets.image')} title={t('assets.image')}
        disabled={busy} onClick={props.onAddImage}>
        <Image size={15} aria-hidden="true"/><span className="board-tool-label">{t('assets.image')}</span>
      </WorkbenchButton>}
      {props.onAddVideo && <WorkbenchButton variant="ghost" data-testid="board-ui-add-video" aria-label={t('assets.video')} title={t('assets.video')}
        disabled={busy} onClick={props.onAddVideo}>
        <Video size={15} aria-hidden="true"/><span className="board-tool-label">{t('assets.video')}</span>
      </WorkbenchButton>}
      {props.onGenerateImage && <WorkbenchButton variant="ghost" data-testid="board-ui-generate-image" aria-label={t('boardUi.generateImage')} title={t('boardUi.generateImage')}
        disabled={busy} onClick={props.onGenerateImage}>
        <Sparkles size={15} aria-hidden="true"/><span className="board-tool-label">{t('boardUi.generateImage')}</span>
      </WorkbenchButton>}
      <WorkbenchButton variant="ghost" data-testid="board-ui-tidy" aria-label={t('canvas.edit.tidy')}
        title={`${t('canvas.edit.tidyHint')} · ${mac ? '⇧⌘L' : 'Ctrl+Shift+L'}`}
        aria-keyshortcuts={mac ? 'Meta+Shift+L' : 'Control+Shift+L'} disabled={!canTidy} onClick={tidyBoard}>
        <Grid2X2 size={15} aria-hidden="true"/><span className="board-tool-label">{t('canvas.edit.tidy')}</span>
      </WorkbenchButton>
      <span className="board-toolbar-separator" aria-hidden="true"/>
      <WorkbenchButton variant="ghost" data-testid="board-ui-add-root" aria-label={t('boardUi.addRoot')} title={t('boardUi.addRoot')}
        disabled={busy} onClick={addRoot}>
        <Clapperboard size={15} aria-hidden="true"/><span className="board-tool-label">{t('boardUi.addRoot')}</span>
      </WorkbenchButton>
      <WorkbenchButton variant="ghost" data-testid="board-ui-add-subject" aria-label={t('boardUi.addSubject')} title={t('boardUi.addSubject')}
        disabled={busy} aria-expanded={subjectPicker} onClick={() => setSubjectPicker(open => !open)}>
        <User size={15} aria-hidden="true"/><span className="board-tool-label">{t('boardUi.addSubject')}</span>
      </WorkbenchButton>
      {props.onAddPrevis && <WorkbenchButton variant="ghost" data-testid="board-ui-add-previs"
        aria-label={t('previs.toolbar.add')} title={t('previs.toolbar.add')}
        disabled={busy || props.previsDisabled || props.addingPrevis} onClick={props.onAddPrevis}>
        <Box size={15} aria-hidden="true"/><span className="board-tool-label">{t('previs.toolbar.add')}</span>
      </WorkbenchButton>}
      <WorkbenchButton variant="ghost" className="board-toolbar-archive" data-testid="board-ui-archive"
        aria-label={t('boardUi.archiveCount', {count: archived.length})} title={t('boardUi.archiveCount', {count: archived.length})}
        disabled={busy} aria-expanded={archiveOpen} onClick={() => setArchiveOpen(open => !open)}>
        <Trash2 size={15} aria-hidden="true"/><span className="board-tool-label">{t('canvas.edit.archive')}</span>
        <span className="board-archive-count" aria-hidden="true">{formatNumber(archived.length)}</span>
      </WorkbenchButton>
    </div>
    {paneMenu && <div className="board-ui-context-menu" role="menu" data-testid="board-pane-menu"
      aria-label={t('boardUi.board')} style={{left: paneMenu.x, top: paneMenu.y}} onPointerDown={event => event.stopPropagation()}>
      <button type="button" role="menuitem" data-testid="board-pane-add-text" disabled={busy}
        onClick={() => {
          addText(paneMenu.position);
          setPaneMenu(null);
        }}><Type size={14} aria-hidden="true"/><span>{t('boardUi.menu.addText')}</span></button>
      <button type="button" role="menuitem" data-testid="board-pane-paste" disabled={busy || !copied.length}
        onClick={() => {
          duplicate(copied);
          setPaneMenu(null);
        }}><ClipboardPaste size={14} aria-hidden="true"/><span>{t('boardUi.menu.paste')}</span><kbd aria-hidden="true">{shortcut.paste}</kbd></button>
      <hr className="board-context-separator" aria-hidden="true"/>
      <button type="button" role="menuitem" data-testid="board-pane-tidy" disabled={!canTidy}
        onClick={tidyBoard}><Grid2X2 size={14} aria-hidden="true"/><span>{t('canvas.edit.tidy')}</span><kbd aria-hidden="true">{shortcut.tidy}</kbd></button>
    </div>}
    {menu && menuNode && menuNode.kind !== 'film' && menuNode.kind !== 'subject' && <div className="board-ui-context-menu"
      role="menu" data-testid="board-ui-context-menu" aria-label={t('canvas.edit.menu')} style={{left: menu.x, top: menu.y}}>
      <button type="button" role="menuitem" data-testid="board-menu-copy" onClick={() => copy(menu.nodeId)}>
        <Copy size={14} aria-hidden="true"/><span>{t('boardUi.menu.copy')}</span><kbd aria-hidden="true">{shortcut.copy}</kbd>
      </button>
      <button type="button" role="menuitem" data-testid="board-menu-paste" disabled={busy || !copied.length}
        onClick={() => duplicate(copied)}>
        <ClipboardPaste size={14} aria-hidden="true"/><span>{t('boardUi.menu.paste')}</span><kbd aria-hidden="true">{shortcut.paste}</kbd>
      </button>
      <button type="button" role="menuitem" data-testid="board-menu-duplicate" disabled={busy}
        onClick={() => duplicate([{kind: menuNode.kind === 'shot' ? 'shot' : 'node', id: menuNode.id}])}>
        <CopyPlus size={14} aria-hidden="true"/><span>{t('boardUi.menu.duplicate')}</span><kbd aria-hidden="true">{shortcut.duplicate}</kbd>
      </button>
      <hr className="board-context-separator" aria-hidden="true"/>
      <button type="button" role="menuitem" data-testid="board-menu-tidy" disabled={!canTidy} onClick={tidyBoard}>
        <Grid2X2 size={14} aria-hidden="true"/><span>{t('canvas.edit.tidy')}</span>
      </button>
      <hr className="board-context-separator" aria-hidden="true"/>
      <button type="button" role="menuitem" className="is-destructive" data-testid="board-menu-delete" disabled={busy} onClick={() => deleteNode(menuNode.id, menuNode.name)}>
        <Trash2 size={14} aria-hidden="true"/><span>{t('boardUi.deleteNode')}</span><kbd aria-hidden="true">{shortcut.del}</kbd>
      </button>
    </div>}
    {subjectPicker && <div className="board-ui-live-subject-picker" data-testid="board-ui-subject-picker" role="dialog"
      aria-label={t('boardUi.addSubject')}>
      <header><strong>{t('boardUi.addSubject')}</strong><button type="button" aria-label={t('boardUi.collapse')}
        onClick={() => setSubjectPicker(false)}><X size={14} aria-hidden="true"/></button></header>
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
        onClick={() => setArchiveOpen(false)}><X size={14} aria-hidden="true"/></button></header>
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
