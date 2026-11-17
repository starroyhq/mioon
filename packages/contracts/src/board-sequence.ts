export type ChainNodeKind = 'shot' | 'video' | 'image' | 'audio' | 'text' | 'subject' | 'previs' | 'film';

export interface ChainNode {
  readonly id: string;
  readonly kind: ChainNodeKind;
}

export interface SequenceEdge {
  readonly fromId: string;
  readonly toId: string;
}

export interface ChainBoard {
  readonly nodes: readonly ChainNode[];
  /** Only sequence edges participate in a film's playback order. */
  readonly edges: readonly SequenceEdge[];
}

export type ChainReferenceRole = 'first_frame' | 'subject_reference' | 'composition' | 'reference_audio' | 'reference_video';
export type ChainConnectionKind = 'sequence' | 'reference';
export type ChainConnectionErrorCode =
  | 'INVALID_SEQUENCE_TYPES'
  | 'INVALID_REFERENCE_TYPES'
  | 'FILM_MUST_START'
  | 'TEXT_IS_ANNOTATION'
  | 'INVALID_CONNECTION_TYPES';
export type ChainConnection =
  | { readonly kind: 'sequence' }
  | { readonly kind: 'reference'; readonly role: ChainReferenceRole }
  | { readonly kind: 'rejected'; readonly code: ChainConnectionErrorCode };

const sequenceKinds = new Set<ChainNodeKind>(['shot', 'video', 'image']);
const referenceRoles: Partial<Record<ChainNodeKind, ChainReferenceRole>> = {
  image: 'first_frame',
  subject: 'subject_reference',
  previs: 'composition',
  audio: 'reference_audio',
  video: 'reference_video',
};

/** Image and video can use either port on a shot. With no port intent, use the sequence port. */
export function classifyChainConnection(from: ChainNodeKind, to: ChainNodeKind, intent?: ChainConnectionKind): ChainConnection {
  if (to === 'film') return {kind: 'rejected', code: 'FILM_MUST_START'};
  if (from === 'text' || to === 'text') return {kind: 'rejected', code: 'TEXT_IS_ANNOTATION'};
  if (intent !== 'reference' && (from === 'film' || sequenceKinds.has(from)) && sequenceKinds.has(to)) return {kind: 'sequence'};
  const role = Object.hasOwn(referenceRoles, from) ? referenceRoles[from] : undefined;
  if (intent !== 'sequence' && to === 'shot' && role !== undefined) return {kind: 'reference', role};
  return {kind: 'rejected', code: intent === 'sequence' ? 'INVALID_SEQUENCE_TYPES' : intent === 'reference' ? 'INVALID_REFERENCE_TYPES' : 'INVALID_CONNECTION_TYPES'};
}

export type BoardSequenceErrorCode = ChainConnectionErrorCode
  | 'MISSING_NODE'
  | 'DUPLICATE_NODE'
  | 'MISSING_EDGE'
  | 'DUPLICATE_EDGE'
  | 'MULTIPLE_PREDECESSORS'
  | 'MULTIPLE_SUCCESSORS'
  | 'CYCLE'
  | 'NODE_ALREADY_LINKED';

export interface BoardSequenceIssue {
  readonly code: BoardSequenceErrorCode;
  readonly nodeIds: readonly string[];
  readonly edges: readonly SequenceEdge[];
}

export interface FilmChain {
  readonly filmId: string;
  readonly nodeIds: readonly string[];
}

export interface FilmChainDerivation {
  readonly chains: readonly FilmChain[];
  /** A node outside the derived sequence paths, including a non-sequence node. */
  readonly detachedNodeIds: readonly string[];
  readonly issues: readonly BoardSequenceIssue[];
}

export const compareChainIds = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
export const compareSequenceEdges = (left: SequenceEdge, right: SequenceEdge): number =>
  compareChainIds(left.fromId, right.fromId) || compareChainIds(left.toId, right.toId);

function addEdge(map: Map<string, SequenceEdge[]>, id: string, edge: SequenceEdge): void {
  const current = map.get(id);
  if (current) current.push(edge);
  else map.set(id, [edge]);
}

function issue(code: BoardSequenceErrorCode, nodeIds: readonly string[], edges: readonly SequenceEdge[] = []): BoardSequenceIssue {
  return {
    code,
    nodeIds: [...new Set(nodeIds)].sort(compareChainIds),
    edges: edges.map(({fromId, toId}) => ({fromId, toId})).sort(compareSequenceEdges),
  };
}

function compareLists<T>(left: readonly T[], right: readonly T[], compare: (left: T, right: T) => number): number {
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const order = compare(left[index]!, right[index]!);
    if (order !== 0) return order;
  }
  return left.length - right.length;
}

function compareIssues(left: BoardSequenceIssue, right: BoardSequenceIssue): number {
  return compareChainIds(left.code, right.code) || compareLists(left.nodeIds, right.nodeIds, compareChainIds)
    || compareLists(left.edges, right.edges, compareSequenceEdges);
}

type Adjacency = ReadonlyMap<string, readonly SequenceEdge[]>;

/** One diagnostic per cyclic strongly connected component, even when degrees are invalid. */
function cycleIssues(ids: Iterable<string>, outgoing: Adjacency, incoming: Adjacency): BoardSequenceIssue[] {
  const finished: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const stack = [{id, nextEdge: 0}];
    while (stack.length) {
      const frame = stack.at(-1)!;
      const next = outgoing.get(frame.id)?.[frame.nextEdge++];
      if (next === undefined) {
        finished.push(frame.id);
        stack.pop();
      } else if (!seen.has(next.toId)) {
        seen.add(next.toId);
        stack.push({id: next.toId, nextEdge: 0});
      }
    }
  }
  seen.clear();
  const issues: BoardSequenceIssue[] = [];
  for (let index = finished.length - 1; index >= 0; index--) {
    const id = finished[index]!;
    if (seen.has(id)) continue;
    const component = new Set([id]);
    const stack = [id];
    seen.add(id);
    while (stack.length) {
      for (const edge of incoming.get(stack.pop()!) ?? []) {
        if (seen.has(edge.fromId)) continue;
        seen.add(edge.fromId);
        component.add(edge.fromId);
        stack.push(edge.fromId);
      }
    }
    if (component.size > 1 || outgoing.get(id)?.some(edge => edge.toId === id)) {
      const members = [...component];
      const edges = members.flatMap(member => (outgoing.get(member) ?? []).filter(edge => component.has(edge.toId)));
      issues.push(issue('CYCLE', members, edges));
    }
  }
  return issues;
}

function inspectBoard(board: ChainBoard) {
  const nodes = new Map<string, ChainNode>();
  const duplicateIds = new Set<string>();
  const issues: BoardSequenceIssue[] = [];
  for (const node of board.nodes) {
    if (duplicateIds.has(node.id)) continue;
    if (nodes.has(node.id)) {
      nodes.delete(node.id);
      duplicateIds.add(node.id);
      issues.push(issue('DUPLICATE_NODE', [node.id]));
    } else nodes.set(node.id, node);
  }
  const incoming = new Map<string, SequenceEdge[]>();
  const outgoing = new Map<string, SequenceEdge[]>();
  const edges = [...board.edges].sort(compareSequenceEdges);
  for (let index = 0; index < edges.length;) {
    const edge = edges[index++]!;
    const endpoints = [edge.fromId, edge.toId];
    if (index < edges.length && compareSequenceEdges(edge, edges[index]!) === 0) {
      issues.push(issue('DUPLICATE_EDGE', endpoints, [edge]));
      while (index < edges.length && compareSequenceEdges(edge, edges[index]!) === 0) index++;
    }
    const from = nodes.get(edge.fromId);
    const to = nodes.get(edge.toId);
    if (!from || !to) {
      const missing = endpoints.filter(id => !nodes.has(id) && !duplicateIds.has(id));
      if (missing.length) issues.push(issue('MISSING_NODE', missing, [edge]));
      continue;
    }
    const classification = classifyChainConnection(from.kind, to.kind, 'sequence');
    if (classification.kind === 'rejected') {
      issues.push(issue(classification.code, endpoints, [edge]));
      continue;
    }
    addEdge(incoming, edge.toId, edge);
    addEdge(outgoing, edge.fromId, edge);
  }
  for (const [id, predecessors] of incoming) {
    if (predecessors.length > 1) issues.push(issue('MULTIPLE_PREDECESSORS', [id], predecessors));
  }
  for (const [id, successors] of outgoing) {
    if (successors.length > 1) issues.push(issue('MULTIPLE_SUCCESSORS', [id], successors));
  }
  const orderedIds = [...nodes.keys()].sort(compareChainIds);
  for (const cycle of cycleIssues(orderedIds, outgoing, incoming)) issues.push(cycle);
  return {nodes, orderedIds, edges, incoming, outgoing, issues: issues.sort(compareIssues)};
}

/** From each film, follow only unambiguous edges, alongside independent graph diagnostics. */
export function deriveFilmChains(board: ChainBoard): FilmChainDerivation {
  const graph = inspectBoard(board);
  const chains: FilmChain[] = [];
  const attached = new Set<string>();
  const detachedNodeIds: string[] = [];
  for (const id of graph.orderedIds) {
    if (graph.nodes.get(id)!.kind !== 'film') continue;
    const nodeIds: string[] = [];
    let current = id;
    for (;;) {
      const next = graph.outgoing.get(current);
      if (next?.length !== 1) break;
      const target = next[0]!.toId;
      if (graph.incoming.get(target)?.length !== 1 || attached.has(target)) break;
      attached.add(target);
      nodeIds.push(target);
      current = target;
    }
    chains.push({filmId: id, nodeIds});
  }
  for (const id of graph.orderedIds) {
    if (graph.nodes.get(id)!.kind !== 'film' && !attached.has(id)) detachedNodeIds.push(id);
  }
  return {chains, detachedNodeIds, issues: graph.issues};
}

export type BoardSequenceEdit =
  | ({ readonly kind: 'connect' } & SequenceEdge)
  | ({ readonly kind: 'disconnect' } & SequenceEdge)
  | ({ readonly kind: 'insert'; readonly nodeId: string } & SequenceEdge)
  | { readonly kind: 'delete'; readonly nodeId: string };

export type BoardSequenceEditPlan =
  | { readonly ok: true; readonly board: ChainBoard; readonly addedEdges: readonly SequenceEdge[]; readonly removedEdges: readonly SequenceEdge[] }
  | { readonly ok: false; readonly code: BoardSequenceErrorCode; readonly issues: readonly BoardSequenceIssue[] };

function rejected(first: BoardSequenceIssue, issues: readonly BoardSequenceIssue[] = [first]): BoardSequenceEditPlan {
  return {ok: false, code: first.code, issues};
}

/** Plan a sequence-only edit. Insertion can reorder a node inside its own chain. */
export function planBoardSequenceEdit(board: ChainBoard, operation: BoardSequenceEdit): BoardSequenceEditPlan {
  const graph = inspectBoard(board);
  if (graph.issues.length) return rejected(graph.issues[0]!, graph.issues);

  const addedEdges: SequenceEdge[] = [];
  const removedEdges: SequenceEdge[] = [];
  let removedNodeId: string | undefined;
  const existing = (edge: SequenceEdge) => graph.outgoing.get(edge.fromId)?.find(item => item.toId === edge.toId);
  const validateEdge = (edge: SequenceEdge): BoardSequenceIssue | undefined => {
    const {fromId, toId} = edge;
    const from = graph.nodes.get(fromId);
    const to = graph.nodes.get(toId);
    if (!from || !to) return issue('MISSING_NODE', [fromId, toId].filter(id => !graph.nodes.has(id)), [edge]);
    const classification = classifyChainConnection(from.kind, to.kind, 'sequence');
    return classification.kind === 'rejected' ? issue(classification.code, [fromId, toId], [edge]) : undefined;
  };

  if (operation.kind === 'connect') {
    const edge = {fromId: operation.fromId, toId: operation.toId};
    const invalid = validateEdge(edge);
    if (invalid) return rejected(invalid);
    if (existing(edge)) return rejected(issue('DUPLICATE_EDGE', [edge.fromId, edge.toId], [edge]));
    const successor = graph.outgoing.get(edge.fromId)?.[0];
    if (successor) return rejected(issue('MULTIPLE_SUCCESSORS', [edge.fromId], [successor, edge]));
    const predecessor = graph.incoming.get(edge.toId)?.[0];
    if (predecessor) return rejected(issue('MULTIPLE_PREDECESSORS', [edge.toId], [predecessor, edge]));
    const path = [edge.toId];
    const cycleEdges = [edge];
    while (path.at(-1)! !== edge.fromId) {
      const next = graph.outgoing.get(path.at(-1)!)?.[0];
      if (!next) break;
      path.push(next.toId);
      cycleEdges.push(next);
    }
    if (path.at(-1) === edge.fromId) return rejected(issue('CYCLE', path, cycleEdges));
    addedEdges.push(edge);
  } else if (operation.kind === 'delete') {
    removedNodeId = operation.nodeId;
    if (!graph.nodes.has(removedNodeId)) return rejected(issue('MISSING_NODE', [removedNodeId]));
    const predecessor = graph.incoming.get(removedNodeId)?.[0];
    const successor = graph.outgoing.get(removedNodeId)?.[0];
    if (predecessor) removedEdges.push(predecessor);
    if (successor) removedEdges.push(successor);
    if (predecessor && successor) addedEdges.push({fromId: predecessor.fromId, toId: successor.toId});
  } else {
    const edge = existing(operation);
    if (!edge) return rejected(issue('MISSING_EDGE', [operation.fromId, operation.toId], [{fromId: operation.fromId, toId: operation.toId}]));
    if (operation.kind === 'disconnect') removedEdges.push(edge);
    else if (operation.nodeId !== edge.fromId && operation.nodeId !== edge.toId) {
      const {nodeId} = operation;
      const predecessor = graph.incoming.get(nodeId)?.[0];
      const successor = graph.outgoing.get(nodeId)?.[0];
      const chainHead = (start: string): string => {
        let current = start;
        for (let prior = graph.incoming.get(current)?.[0]; prior; prior = graph.incoming.get(current)?.[0]) {
          current = prior.fromId;
        }
        return current;
      };
      if ((predecessor || successor) && chainHead(nodeId) !== chainHead(edge.fromId))
        return rejected(issue('NODE_ALREADY_LINKED', [nodeId]));
      const before = {fromId: edge.fromId, toId: nodeId};
      const after = {fromId: nodeId, toId: edge.toId};
      const invalid = validateEdge(before) ?? validateEdge(after);
      if (invalid) return rejected(invalid);
      removedEdges.push(edge);
      if (predecessor) removedEdges.push(predecessor);
      if (successor) removedEdges.push(successor);
      if (predecessor && successor) addedEdges.push({fromId: predecessor.fromId, toId: successor.toId});
      addedEdges.push(before, after);
    }
  }

  const removed = new Set(removedEdges);
  const nodes = graph.orderedIds.filter(id => id !== removedNodeId).map(id => graph.nodes.get(id)!);
  const edges = [...graph.edges.filter(edge => !removed.has(edge)), ...addedEdges].sort(compareSequenceEdges);
  return {
    ok: true,
    board: {nodes, edges},
    addedEdges: addedEdges.sort(compareSequenceEdges),
    removedEdges: removedEdges.sort(compareSequenceEdges),
  };
}
