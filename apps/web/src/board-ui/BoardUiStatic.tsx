import React, {memo, useCallback, useMemo, useRef, useState} from 'react';
import {Background, BackgroundVariant, ReactFlow, ReactFlowProvider, useReactFlow} from '@xyflow/react';
import type {Node, NodeChange, NodeProps} from '@xyflow/react';
import type {ChainReferenceRole} from '../../../../packages/contracts/src/board-sequence.ts';
import {useI18n} from '../i18n/I18nProvider.tsx';
import {BoardPorts} from './BoardPorts.tsx';
import {boardEdgeTypes} from './BoardEdges.tsx';
import type {BoardReferenceEdge, BoardSequenceEdge} from './BoardEdges.tsx';
import {resolveBoardPortConnection, boardPorts} from './connection-ports.ts';
import type {BoardPortConnection, BoardPortEndpoint, BoardPortId} from './connection-ports.ts';
import type {BoardUiNode, BoardUiProjection} from './projection.ts';
import {BoardFilmOverview, BoardFilmStrip, BoardFloatingLabel, useBoardDuration} from './BoardFilmComponents.tsx';
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
}

type Film = BoardUiProjection['films'][number];
interface CardData extends Record<string, unknown> {
  model: BoardUiNode;
  film?: Film;
  order?: number;
  floating: boolean;
  drag: BoardPortEndpoint | null;
  activatePort: (endpoint: BoardPortEndpoint) => void;
}
type CardNode = Node<CardData, 'board-card'>;

const BoardCardView = memo(function BoardCardView({data, selected}: NodeProps<CardNode>) {
  const {model, film} = data;
  const {t, formatNumber} = useI18n();
  const durationLabel = useBoardDuration();
  const frames = film ? film.durationFrames : model.durationFrames ?? null;
  const duration = durationLabel(frames, !film);
  const statusKey = model.status === 'ready' ? 'redesign.board.completed' : model.status === 'generating' ? 'redesign.board.generating' : 'redesign.board.waiting';
  return <article className={`board-ui-card board-ui-card-${model.kind}${selected ? ' is-selected' : ''}`} data-testid={`board-card-${model.id}`} aria-label={model.name}>
    {data.floating && <BoardFloatingLabel/>}
    {film ? <div className="board-film-root"><span aria-hidden="true">▱</span><div><strong>{film.name}</strong><span>{t('boardUi.aspectDuration', {aspect: film.aspectRatio ?? t('boardUi.aspectUnknown'), duration})}</span></div></div>
      : <><header>{data.order !== undefined && <span className="board-card-order">{formatNumber(data.order, {minimumIntegerDigits: 2})}</span>}<strong title={model.name}>{model.name}</strong>
        {model.kind === 'shot' && <span className={`board-card-status status-${model.status ?? 'pending'}`}>{t(statusKey)}</span>}</header>
        {model.kind === 'text' ? <p className="board-text-content">{model.name}</p> : <div className="board-card-picture">{model.thumbnailUrl ? <img src={model.thumbnailUrl} alt="" draggable={false}/> : <span aria-hidden="true">▱</span>}</div>}
        {(model.kind === 'shot' || (model.kind === 'video' || model.kind === 'image') && (model.aspectRatio || frames !== null)) && <footer>
          <span>{model.aspectRatio ? t('boardUi.aspectDuration', {aspect: model.aspectRatio, duration}) : duration}</span>
        </footer>}
      </>}
    <BoardPorts nodeId={model.id} kind={model.kind} drag={data.drag} onActivate={data.activatePort}/>
  </article>;
});
const nodeTypes = {'board-card': BoardCardView};

function BoardUiCanvas(props: BoardUiStaticProps) {
  const {projection, nodes, edges, reduceMotion = false} = props;
  const {t} = useI18n();
  const flow = useReactFlow<CardNode, BoardSequenceEdge | BoardReferenceEdge>();
  const [drag, setDrag] = useState<BoardPortEndpoint | null>(null);
  const [selection, setSelection] = useState<string | null>(null);
  const [open, setOpen] = useState(true);
  const [moved, setMoved] = useState<Readonly<Record<string, {x: number; y: number}>>>({});
  const [sizes, setSizes] = useState<Readonly<Record<string, {width: number; height: number}>>>({});
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
      data: {model, film: films.get(model.id), order: order.get(model.id), floating: floating.has(model.id), drag, activatePort},
    }));
  }, [nodes, projection, props.positions, selectedId, moved, sizes, drag, activatePort]);
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
    return connection.kind === 'sequence' ? [{...base, type: 'sequence', data: {reduceMotion}}]
      : [{...base, type: 'reference', data: {role: edge.role ?? connection.role, reduceMotion}}];
  }), [edges, byId, reduceMotion, moved, props.positions]);
  const locate = (id: string) => {
    select(id);
    const node = flow.getNode(id);
    if (node) void flow.setCenter(node.position.x + (node.measured?.width ?? 240) / 2, node.position.y + (node.measured?.height ?? 160) / 2, {zoom: flow.getZoom()});
    props.onLocateNode?.(id);
  };
  const positionsChanged = (changes: NodeChange<CardNode>[]) => {
    const positions = changes.flatMap(change => change.type === 'position' && change.position ? [[change.id, change.position] as const] : []);
    if (positions.length) setMoved(previous => ({...previous, ...Object.fromEntries(positions)}));
    const dimensions = changes.flatMap(change => change.type === 'dimensions' && change.dimensions ? [[change.id, change.dimensions] as const] : []);
    if (dimensions.length) setSizes(previous => {
      const next = {...previous};
      let changed = false;
      for (const [id, size] of dimensions) if (previous[id]?.width !== size.width || previous[id]?.height !== size.height) {
        next[id] = {width: size.width, height: size.height};
        changed = true;
      }
      return changed ? next : previous;
    });
    const selected = changes.find(change => change.type === 'select' && change.selected);
    if (selected?.type === 'select') select(selected.id);
    else if (changes.some(change => change.type === 'select' && !change.selected && change.id === selectedId)) select(null);
  };
  const film = projection.films.find(item => item.items.some(node => node.nodeId === selectedId) || item.id === selectedId) ?? projection.films[0];
  const selected = selectedId ? byId.get(selectedId) : null;
  return <div className="board-ui-static" data-testid="board-ui-static" data-reduce-motion={reduceMotion ? 'true' : undefined} onKeyDownCapture={event => {if (event.key === 'Escape') setDrag(null);}}>
    <div className="board-ui-canvas" data-testid="board-ui-canvas">
      <ReactFlow<CardNode, BoardSequenceEdge | BoardReferenceEdge> nodes={flowNodes} edges={flowEdges} nodeTypes={nodeTypes} edgeTypes={boardEdgeTypes}
        proOptions={{hideAttribution: true}}
        fitView fitViewOptions={{padding: .12, maxZoom: .9}} minZoom={.05} maxZoom={2} onlyRenderVisibleElements={false}
        onNodesChange={positionsChanged} onNodeClick={(_, node) => select(node.id)} onPaneClick={() => select(null)}
        onConnectStart={(_, start) => {
          const node = start.nodeId ? byId.get(start.nodeId) : null;
          const port = node && boardPorts(node.kind).find(value => value.id === start.handleId);
          setDrag(node && port ? {nodeId: node.id, kind: node.kind, portId: port.id} : null);
        }}
        onConnectEnd={() => setDrag(null)}
        isValidConnection={value => normalizeConnection(value) !== null}
        onConnect={value => {const result = normalizeConnection(value); if (result) props.onConnect(result); setDrag(null);}}
      ><Background variant={BackgroundVariant.Dots} gap={24} size={1.5} color="var(--wb-canvas-dot, #ffffff1f)"/></ReactFlow>
      {film && <BoardFilmStrip film={film} open={open} onOpenChange={setOpen} selectedNodeId={selectedId} onLocateNode={locate} onAddShot={props.onAddShot}/>}
    </div>
    <aside className="board-ui-inspector">{!selected ? <BoardFilmOverview overview={projection.overview}/>
      : <section className="board-selection-summary" data-testid="board-selected-summary"><h3>{selected.name}</h3><span>{selected.aspectRatio ?? (selected.kind === 'film' ? film?.aspectRatio ?? t('boardUi.aspectUnknown') : '')}</span></section>}</aside>
  </div>;
}

/** Controlled presentation composition. UI-B2 supplies data and command callbacks later. */
export default function BoardUiStatic(props: BoardUiStaticProps) {
  return <ReactFlowProvider><BoardUiCanvas {...props}/></ReactFlowProvider>;
}
