import {classifyChainConnection} from '../../../../packages/contracts/src/board-sequence.ts';
import type {ChainNodeKind, ChainReferenceRole} from '../../../../packages/contracts/src/board-sequence.ts';

export type BoardPortFamily = 'sequence' | 'reference';
export type BoardPortId = 'sequence-in' | 'sequence-out'
  | 'reference-in-top' | 'reference-in-bottom' | 'reference-out-top' | 'reference-out-bottom';

export interface BoardPort {
  readonly id: BoardPortId;
  readonly family: BoardPortFamily;
  readonly type: 'source' | 'target';
  readonly side: 'left' | 'right' | 'top' | 'bottom';
}

export interface BoardPortEndpoint {
  readonly nodeId: string;
  readonly kind: ChainNodeKind;
  readonly portId: BoardPortId;
}

interface BoardPortConnectionEndpoints {
  readonly sourceId: string;
  readonly targetId: string;
  readonly sourcePort: BoardPortId;
  readonly targetPort: BoardPortId;
}

export type BoardPortConnection =
  | (BoardPortConnectionEndpoints & {readonly kind: 'sequence'})
  | (BoardPortConnectionEndpoints & {readonly kind: 'reference'; readonly role: ChainReferenceRole});

const sequenceIn: BoardPort = {id: 'sequence-in', family: 'sequence', type: 'target', side: 'left'};
const sequenceOut: BoardPort = {id: 'sequence-out', family: 'sequence', type: 'source', side: 'right'};
const referenceIn: readonly BoardPort[] = [
  {id: 'reference-in-top', family: 'reference', type: 'target', side: 'top'},
  {id: 'reference-in-bottom', family: 'reference', type: 'target', side: 'bottom'},
];
const referenceOut: readonly BoardPort[] = [
  {id: 'reference-out-top', family: 'reference', type: 'source', side: 'top'},
  {id: 'reference-out-bottom', family: 'reference', type: 'source', side: 'bottom'},
];

const ports: Readonly<Record<ChainNodeKind, readonly BoardPort[]>> = {
  film: [sequenceOut],
  shot: [sequenceIn, sequenceOut, ...referenceIn],
  image: [sequenceIn, sequenceOut, ...referenceOut],
  video: [sequenceIn, sequenceOut, ...referenceOut],
  audio: referenceOut,
  subject: referenceOut,
  previs: referenceOut,
  text: [],
};

export function boardPorts(kind: ChainNodeKind): readonly BoardPort[] {
  return ports[kind];
}

/** Type/port compatibility only. CS admits the resulting graph and persists a connection later. */
export function resolveBoardPortConnection(first: BoardPortEndpoint, second: BoardPortEndpoint): BoardPortConnection | null {
  if (first.nodeId === second.nodeId) return null;
  const firstPort = boardPorts(first.kind).find(port => port.id === first.portId);
  const secondPort = boardPorts(second.kind).find(port => port.id === second.portId);
  if (!firstPort || !secondPort || firstPort.family !== secondPort.family || firstPort.type === secondPort.type) return null;
  const source = firstPort.type === 'source' ? first : second;
  const target = firstPort.type === 'target' ? first : second;
  const classification = classifyChainConnection(source.kind, target.kind, firstPort.family);
  if (classification.kind === 'rejected') return null;
  const endpoints = {sourceId: source.nodeId, targetId: target.nodeId, sourcePort: source.portId, targetPort: target.portId};
  return classification.kind === 'sequence'
    ? {...endpoints, kind: 'sequence'}
    : {...endpoints, kind: 'reference', role: classification.role};
}

export function isBoardPortCandidate(
  drag: BoardPortEndpoint,
  targetNode: {readonly id: string; readonly kind: ChainNodeKind},
  targetPort: BoardPort | BoardPortId,
): boolean {
  return resolveBoardPortConnection(drag, {
    nodeId: targetNode.id,
    kind: targetNode.kind,
    portId: typeof targetPort === 'string' ? targetPort : targetPort.id,
  }) !== null;
}
