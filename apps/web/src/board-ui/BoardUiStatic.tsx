import React, {memo, useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Background, BackgroundVariant, ReactFlow, ReactFlowProvider, useReactFlow, useStore} from '@xyflow/react';
import type {Node, NodeChange, NodeProps} from '@xyflow/react';
import {WorkbenchButton} from '@mioon/ui/components/workbench-controls';
import {Circle, CircleAlert, CircleCheck, Clapperboard, Film, Focus, Layers, Minus, Plus} from '@mioon/ui/components/workbench-icons';
import type {ChainReferenceRole} from '../../../../packages/contracts/src/board-sequence.ts';
import CompactNodePlayer from '../CompactNodePlayer.tsx';
import {measuredFitPadding} from '../canvas-fit.ts';
import {useI18n} from '../i18n/I18nProvider.tsx';
import {BoardPorts} from './BoardPorts.tsx';
import {boardEdgeTypes} from './BoardEdges.tsx';
import type {BoardReferenceEdge, BoardSequenceEdge} from './BoardEdges.tsx';
import {shouldUseStaticBoardEdges} from './edge-motion.ts';
import {resolveBoardPortConnection, boardPorts} from './connection-ports.ts';
import type {BoardPortConnection, BoardPortEndpoint, BoardPortId} from './connection-ports.ts';
import type {BoardUiNode, BoardUiProjection} from './projection.ts';
import {BoardFilmOverview, BoardFilmStrip, BoardFloatingLabel, useBoardDuration} from './BoardFilmComponents.tsx';
import {SUBJECT_DRAG, droppedSubject} from './subject-drag.ts';
import '@xyflow/react/dist/style.css';
import './board-ui.css';

export interface BoardUiEdge {
  readonly id: string;
  readonly kind: 'sequence' | 'reference';
  readonly sourceId: string;
  readonly targetId: string;
  readonly role?: ChainReferenceRole;
  readonly sourcePort?: BoardPortId;
  readonly targetPort?: BoardPortId;
  /** RI-b material-line source asset; present only on reference edges. */
  readonly sourceAssetId?: string;
  /** RI-b/SB-b owner binding row; subject lines are edited by the subject card. */
  readonly subjectBindingId?: string;
}

export interface BoardUiStaticProps {
  readonly projection: BoardUiProjection;
  readonly nodes: readonly BoardUiNode[];
  readonly edges: readonly BoardUiEdge[];
  readonly positions?: Readonly<Record<string, {x: number; y: number}>>;
  readonly reduceMotion?: boolean;
  readonly selectedNodeId?: string | null;
  readonly onSelectNode?: (nodeId: string | null) => void;
  readonly onConnect: (connection: BoardPortConnection) => void;
  readonly onLocateNode?: (nodeId: string) => void;
  readonly onAddShot: () => void;
  /** The real workbench supplies its own inspector; the static fixture keeps the inline one. */
  readonly showInspector?: boolean;
  readonly filmSynced?: boolean;
  readonly selectedEdgeId?: string | null;
  readonly onSelectEdge?: (edgeId: string | null) => void;
  /** Batch coordinate writes after one drag gesture, for the unified history. */
  readonly onNodesMoved?: (moves: readonly {readonly nodeId: string; readonly x: number; readonly y: number}[]) => void;
  /** Virtualize off-screen cards for the 500-shot board measurement. */
  readonly virtualize?: boolean;
  /** SB-b: drop a subject from the library at the flow position. */
  readonly onSubjectDrop?: (subjectId: string, position: {readonly x: number; readonly y: number}) => void;
  /** FR-C2: drop one asset-library card onto the board. */
  readonly onAssetDrop?: (assetId: string, position: {readonly x: number; readonly y: number}) => void;
  /** FR-C2: blank-canvas context menu position in flow and screen coordinates. */
  readonly onPaneContextMenu?: (position: {readonly x: number; readonly y: number},
    screen: {readonly x: number; readonly y: number}) => void;
  /** FR-C2: pan this newly-created card into view after an add. */
  readonly revealNodeId?: string | null;
  /** RI-b: reference lines the selected service cannot use, so the connector
   * shows the same state as the property panel (empty while no service is
   * selected). */
  readonly unsupportedEdgeIds?: ReadonlySet<string>;
  /** Open the shot's versions tab in the inspector from the shot card footer. */
  readonly onOpenVersions?: (nodeId: string) => void;
  /** Report measured card dimensions so the live board's tidy layout avoids overlap. */
  readonly onMeasuredSizesChange?: (sizes: Readonly<Record<string, {readonly width: number; readonly height: number}>>) => void;
}

type Film = BoardUiProjection['films'][number];
interface CardData extends Record<string, unknown> {
  model: BoardUiNode;
  film?: Film;
  order?: number;
  floating: boolean;
  drag: BoardPortEndpoint | null;
  activatePort: (endpoint: BoardPortEndpoint) => void;
  onOpenVersions?: (nodeId: string) => void;
}
type CardNode = Node<CardData, 'board-card'>;

const BoardZoomControls = memo(function BoardZoomControls() {
  const {t} = useI18n();
  const flow = useReactFlow();
  const zoom = useStore(state => Math.round(state.transform[2] * 100));
  return <div className="board-zoom-controls" data-testid="board-zoom-controls" role="group" aria-label={t('boardUi.board')}>
    <WorkbenchButton variant="icon" size="compact" data-testid="board-zoom-out" aria-label={t('shell.zoomOut')} title={t('shell.zoomOutCanvas')}
      onClick={() => void flow.zoomOut({duration: 150})}><Minus size={14} aria-hidden="true"/></WorkbenchButton>
    <span className="board-zoom-value" data-testid="board-zoom-value">{zoom}%</span>
    <WorkbenchButton variant="icon" size="compact" data-testid="board-zoom-in" aria-label={t('shell.zoomIn')} title={t('shell.zoomInCanvas')}
      onClick={() => void flow.zoomIn({duration: 150})}><Plus size={14} aria-hidden="true"/></WorkbenchButton>
    <i className="board-zoom-divider" aria-hidden="true"/>
    <WorkbenchButton variant="icon" size="compact" data-testid="board-zoom-fit" aria-label={t('shell.fitCanvas')} title={t('shell.fitCanvasHint')}
      onClick={() => {
        const padding = (typeof document !== 'undefined' ? measuredFitPadding(document.querySelector('[data-testid="canvas-drop-zone"]'), 0.16) : 0.16) as never;
        void flow.fitView({padding, duration: 250, maxZoom: 1});
      }}><Focus size={14} aria-hidden="true"/></WorkbenchButton>
  </div>;
});

const BoardCardView = memo(function BoardCardView({data, selected}: NodeProps<CardNode>) {
  const {model, film} = data;
  const {t, formatNumber} = useI18n();
  const durationLabel = useBoardDuration();
  const frames = film ? film.durationFrames : model.durationFrames ?? null;
  const duration = durationLabel(frames, !film);
  const status = model.status ?? 'pending';
  const statusKey = status === 'ready' ? 'redesign.board.completed'
    : status === 'generating' ? 'redesign.board.generating'
    : status === 'failed' ? 'redesign.board.failed'
    : 'redesign.board.waiting';
  const progress = model.generationProgress ?? null;
  const shotVideoPlayer = model.kind === 'shot' && Boolean(model.thumbnailUrl) && model.thumbnailKind === 'video';
  return <article className={`board-ui-card board-ui-card-${model.kind}${selected ? ' is-selected' : ''}`} data-testid={`board-card-${model.id}`} aria-label={model.name}>
    {data.floating && <BoardFloatingLabel/>}
    {film ? <div className="board-film-root"><span className="board-film-root-icon" aria-hidden="true"><Clapperboard size={18}/></span><div><strong>{film.name}</strong><span>{t('boardUi.aspectDuration', {aspect: film.aspectRatio ?? t('boardUi.aspectUnknown'), duration})}</span></div></div>
      : <><header>{data.order !== undefined && <span className="board-card-order">{formatNumber(data.order, {minimumIntegerDigits: 2})}</span>}<strong title={model.name}>{model.name}</strong>
        {model.kind === 'shot' && <span className={`board-card-status status-${status}`} data-status={status}>
          {status === 'ready' ? <CircleCheck size={11} aria-hidden="true"/>
            : status === 'generating' ? <span className="board-status-spinner" aria-hidden="true"/>
            : status === 'failed' ? <CircleAlert size={11} aria-hidden="true"/>
            : <Circle size={10} aria-hidden="true"/>}
          <span>{t(statusKey)}</span>
        </span>}
        {model.kind === 'subject' && model.subjectKind && <span className="board-card-subject-kind">{t(`boardUi.kind.${model.subjectKind}`)}</span>}</header>
        {model.kind === 'text' ? <p className="board-text-content">{model.name}</p>
          : <div className="board-card-picture">
            {shotVideoPlayer
              ? <CompactNodePlayer sourceKey={`${model.id}:${model.thumbnailUrl}`} renderMedia={events =>
                <video src={model.thumbnailUrl!} muted playsInline preload="metadata" draggable={false} className="media-content" {...events}/>} />
              : model.thumbnailUrl
                ? model.thumbnailKind === 'video'
                  ? <video src={model.thumbnailUrl} muted playsInline preload="metadata" aria-hidden="true" draggable={false}/>
                  : <img src={model.thumbnailUrl} alt="" draggable={false}/>
                : model.kind === 'shot' && status === 'failed'
                  ? <CircleAlert size={24} className="board-card-failed-icon" aria-hidden="true"/>
                  : <Film size={22} className="board-card-placeholder-icon" aria-hidden="true"/>}
            {model.kind === 'shot' && status === 'generating' && <div className="board-card-generating" data-testid={`board-card-generating-${model.id}`}>
              <span className="spinner" aria-hidden="true"/>
              <span>{progress !== null ? `${progress}% · ${t('redesign.board.generating')}` : t('redesign.board.generating')}</span>
              <div className="board-card-progress" role="progressbar" aria-label={t('redesign.board.generating')}
                aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress ?? 0}>
                <span style={{width: `${Math.max(8, progress ?? 15)}%`}}/>
              </div>
            </div>}
          </div>}
        {(model.kind === 'shot' || (model.kind === 'video' || model.kind === 'image') && (model.aspectRatio || frames !== null)) && <footer>
          <span className="board-card-meta">{model.aspectRatio ? t('boardUi.aspectDuration', {aspect: model.aspectRatio, duration}) : duration}</span>
          {model.kind === 'shot' && <button type="button" className="board-card-versions nodrag" data-testid={`board-card-versions-${model.id}`}
            onClick={event => {event.stopPropagation(); data.onOpenVersions?.(model.id);}}>
            <Layers size={12} aria-hidden="true"/>
            <span>{t('shell.node.versionCount', {count: model.versionCount ?? 0})}</span>
          </button>}
        </footer>}
      </>}
    <BoardPorts nodeId={model.id} kind={model.kind} drag={data.drag} onActivate={data.activatePort}/>
  </article>;
});
const nodeTypes = {'board-card': BoardCardView};
// Keep in sync with Timeline.tsx ASSET_DRAG; board-ui must not import the whole editor.
const ASSET_DRAG_MIME = 'application/x-workbench-asset';

function BoardUiCanvas(props: BoardUiStaticProps) {
  const {projection, nodes, edges, reduceMotion = false} = props;
  const {t} = useI18n();
  const flow = useReactFlow<CardNode, BoardSequenceEdge | BoardReferenceEdge>();
  // Subscribe only to the boolean threshold crossing so panning and zooming
  // within one regime never trigger extra React renders.
  const staticEdges = useStore(state => shouldUseStaticBoardEdges(state.transform[2]));
  useEffect(() => {
    if (!props.revealNodeId) return;
    const flowNode = flowNodes.find(node => node.id === props.revealNodeId);
    if (!flowNode) return;
    flow.setCenter(flowNode.position.x + 130, flowNode.position.y + 132,
      {zoom: Math.max(0.55, Math.min(1, flow.getZoom())), duration: 250});
  }, [props.revealNodeId]);
  const [drag, setDrag] = useState<BoardPortEndpoint | null>(null);
  const [selection, setSelection] = useState<string | null>(null);
  const [open, setOpen] = useState(true);
  const [moved, setMoved] = useState<Readonly<Record<string, {x: number; y: number}>>>({});
  const [sizes, setSizes] = useState<Readonly<Record<string, {width: number; height: number}>>>({});
  const dirtyMoves = useRef(new Set<string>());
  const selectedId = props.selectedNodeId === undefined ? selection : props.selectedNodeId;
  const selectionRef = useRef(selectedId);
  selectionRef.current = selectedId;
  const byId = useMemo(() => new Map(nodes.map(node => [node.id, node])), [nodes]);
  const select = useCallback((id: string | null) => {
    if (selectionRef.current === id) return;
    selectionRef.current = id;
    setSelection(id);
    props.onSelectNode?.(id);
  }, [props.onSelectNode]);
  const normalizeConnection = useCallback((value: Pick<BoardSequenceEdge, 'source'|'target'|'sourceHandle'|'targetHandle'>) => {
    const source = byId.get(value.source), target = byId.get(value.target);
    const sourcePort = source && boardPorts(source.kind).find(port => port.id === value.sourceHandle);
    const targetPort = target && boardPorts(target.kind).find(port => port.id === value.targetHandle);
    return source && target && sourcePort && targetPort ? resolveBoardPortConnection(
      {nodeId: source.id, kind: source.kind, portId: sourcePort.id},
      {nodeId: target.id, kind: target.kind, portId: targetPort.id},
    ) : null;
  }, [byId]);
  const activatePort = useCallback((endpoint: BoardPortEndpoint) => {
    if (!drag) {setDrag(endpoint); return;}
    const connection = resolveBoardPortConnection(drag, endpoint);
    if (connection) props.onConnect(connection);
    if (connection || drag.nodeId === endpoint.nodeId && drag.portId === endpoint.portId) setDrag(null);
  }, [drag, props.onConnect]);
  const flowNodes = useMemo(() => {
    const films = new Map(projection.films.map(film => [film.id, film]));
    const order = new Map(projection.films.flatMap(film => film.items.map((item, index) => [item.nodeId, index + 1] as const)));
    const floating = new Set(projection.floatingNodeIds);
    return nodes.map((model, index): CardNode => ({
      id: model.id, type: 'board-card', position: moved[model.id] ?? props.positions?.[model.id] ?? {x: index % 4 * 290, y: Math.floor(index / 4) * 280},
      // Missing dimensions make React Flow hide replacement nodes and drop keyboard focus.
      measured: sizes[model.id],
      selected: selectedId === model.id, ariaLabel: model.name,
      data: {model, film: films.get(model.id), order: order.get(model.id), floating: floating.has(model.id), drag, activatePort, onOpenVersions: props.onOpenVersions},
    }));
  }, [nodes, projection, props.positions, selectedId, moved, sizes, drag, activatePort, props.onOpenVersions]);
  const flowEdges = useMemo(() => edges.flatMap((edge): (BoardSequenceEdge | BoardReferenceEdge)[] => {
    const source = byId.get(edge.sourceId), target = byId.get(edge.targetId);
    if (!source || !target) return [];
    const sourceY = moved[source.id]?.y ?? props.positions?.[source.id]?.y ?? 0;
    const targetY = moved[target.id]?.y ?? props.positions?.[target.id]?.y ?? 0;
    const below = sourceY > targetY;
    const sourcePort = edge.sourcePort ?? (edge.kind === 'sequence' ? 'sequence-out' : below ? 'reference-out-top' : 'reference-out-bottom');
    const targetPort = edge.targetPort ?? (edge.kind === 'sequence' ? 'sequence-in' : below ? 'reference-in-bottom' : 'reference-in-top');
    const connection = resolveBoardPortConnection({nodeId: source.id, kind: source.kind, portId: sourcePort}, {nodeId: target.id, kind: target.kind, portId: targetPort});
    if (!connection || connection.kind !== edge.kind) return [];
    const base = {id: edge.id, source: connection.sourceId, target: connection.targetId, sourceHandle: connection.sourcePort, targetHandle: connection.targetPort};
    return connection.kind === 'sequence' ? [{...base, type: 'sequence', data: {reduceMotion, selected: edge.id === props.selectedEdgeId}}]
      : [{...base, type: 'reference', data: {role: edge.role ?? connection.role, reduceMotion,
        selected: edge.id === props.selectedEdgeId, unsupported: props.unsupportedEdgeIds?.has(edge.id) === true}}];
  }), [edges, byId, reduceMotion, moved, props.positions, props.selectedEdgeId, props.unsupportedEdgeIds]);
  const locate = (id: string) => {
    select(id);
    const node = flow.getNode(id);
    if (node) void flow.setCenter(node.position.x + (node.measured?.width ?? 240) / 2, node.position.y + (node.measured?.height ?? 160) / 2, {zoom: flow.getZoom()});
    props.onLocateNode?.(id);
  };
  const positionsChanged = (changes: NodeChange<CardNode>[]) => {
    const positions = changes.flatMap(change => change.type === 'position' && change.position ? [[change.id, change.position] as const] : []);
    if (positions.length) {
      for (const [id] of positions) dirtyMoves.current.add(id);
      setMoved(previous => ({...previous, ...Object.fromEntries(positions)}));
    }
    const dimensions = changes.flatMap(change => change.type === 'dimensions' && change.dimensions ? [[change.id, change.dimensions] as const] : []);
    if (dimensions.length) setSizes(previous => {
      const next = {...previous};
      let changed = false;
      for (const [id, size] of dimensions) if (previous[id]?.width !== size.width || previous[id]?.height !== size.height) {
        next[id] = {width: size.width, height: size.height};
        changed = true;
      }
      if (changed) props.onMeasuredSizesChange?.(next);
      return changed ? next : previous;
    });
    const selected = changes.find(change => change.type === 'select' && change.selected);
    if (selected?.type === 'select') select(selected.id);
    else if (changes.some(change => change.type === 'select' && !change.selected && change.id === selectedId)) select(null);
  };
  const flushMoves = (): void => {
    const pending = [...dirtyMoves.current].filter(id => moved[id]).map(id => ({nodeId: id, x: moved[id]!.x, y: moved[id]!.y}));
    dirtyMoves.current.clear();
    if (pending.length) props.onNodesMoved?.(pending);
  };
  const film = projection.films.find(item => item.items.some(node => node.nodeId === selectedId) || item.id === selectedId) ?? projection.films[0];
  const selected = selectedId ? byId.get(selectedId) : null;
  return <div className={`board-ui-static${props.showInspector === false ? ' board-ui-no-inspector' : ''}`} data-testid="board-ui-static" data-reduce-motion={reduceMotion ? 'true' : undefined} data-board-static-edges={staticEdges ? 'true' : undefined} onKeyDownCapture={event => {if (event.key === 'Escape') {setDrag(null); props.onSelectEdge?.(null);}}}>
    <div className="board-ui-canvas" data-testid="board-ui-canvas"
      onDragOver={event => {if (event.dataTransfer.types.includes(SUBJECT_DRAG) || event.dataTransfer.types.includes(ASSET_DRAG_MIME)) {
        event.preventDefault(); event.dataTransfer.dropEffect = 'copy';}}}
      onDrop={event => {
        const subjectId = droppedSubject(event.nativeEvent);
        if (subjectId && props.onSubjectDrop) {
          event.preventDefault(); event.stopPropagation();
          const position = flow.screenToFlowPosition({x: event.clientX, y: event.clientY});
          props.onSubjectDrop(subjectId, position);
          return;
        }
        const assetId = event.dataTransfer.getData(ASSET_DRAG_MIME);
        if (assetId && props.onAssetDrop) {
          event.preventDefault(); event.stopPropagation();
          props.onAssetDrop(assetId, flow.screenToFlowPosition({x: event.clientX, y: event.clientY}));
        }
      }}>
      <ReactFlow<CardNode, BoardSequenceEdge | BoardReferenceEdge> nodes={flowNodes} edges={flowEdges} nodeTypes={nodeTypes} edgeTypes={boardEdgeTypes}
        proOptions={{hideAttribution: true}}
        fitView fitViewOptions={{padding: .12, maxZoom: .9}} minZoom={.05} maxZoom={2} onlyRenderVisibleElements={props.virtualize ?? false}
        onNodesChange={positionsChanged} onNodeClick={(_, node) => {props.onSelectEdge?.(null); select(node.id);}}
        onNodeDragStop={flushMoves} onEdgeClick={(_, edge) => props.onSelectEdge?.(edge.id)}
        onPaneClick={() => {select(null); props.onSelectEdge?.(null);}}
        onPaneContextMenu={event => {
          const position = flow.screenToFlowPosition({x: event.clientX, y: event.clientY});
          props.onPaneContextMenu?.(position, {x: event.clientX, y: event.clientY});
        }}
        onConnectStart={(_, start) => {
          const node = start.nodeId ? byId.get(start.nodeId) : null;
          const port = node && boardPorts(node.kind).find(value => value.id === start.handleId);
          setDrag(node && port ? {nodeId: node.id, kind: node.kind, portId: port.id} : null);
        }}
        onConnectEnd={() => setDrag(null)}
        isValidConnection={value => normalizeConnection(value) !== null}
        onConnect={value => {const result = normalizeConnection(value); if (result) props.onConnect(result); setDrag(null);}}
      ><Background variant={BackgroundVariant.Dots} gap={24} size={1.5} color="var(--wb-canvas-dot, #ffffff1f)"/></ReactFlow>
      <BoardZoomControls/>
      {film && <BoardFilmStrip film={film} open={open} onOpenChange={setOpen} selectedNodeId={selectedId} onLocateNode={locate} onAddShot={props.onAddShot} synced={props.filmSynced ?? true}/>}
    </div>
    {props.showInspector !== false && <aside className="board-ui-inspector">{!selected ? <BoardFilmOverview overview={projection.overview}/>
      : <section className="board-selection-summary" data-testid="board-selected-summary"><h3>{selected.name}</h3><span>{selected.aspectRatio ?? (selected.kind === 'film' ? film?.aspectRatio ?? t('boardUi.aspectUnknown') : '')}</span></section>}</aside>}
  </div>;
}

/** Controlled presentation composition. UI-B2 supplies data and command callbacks later. */
export default function BoardUiStatic(props: BoardUiStaticProps) {
  return <ReactFlowProvider><BoardUiCanvas {...props}/></ReactFlowProvider>;
}
