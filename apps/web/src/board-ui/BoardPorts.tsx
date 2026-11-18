import React, {memo} from 'react';
import {Handle, Position} from '@xyflow/react';
import type {ChainNodeKind} from '../../../../packages/contracts/src/board-sequence.ts';
import {useI18n} from '../i18n/I18nProvider.tsx';
import {boardPorts, isBoardPortCandidate} from './connection-ports.ts';
import type {BoardPortEndpoint, BoardPortId} from './connection-ports.ts';
import './edges.css';

export interface BoardPortsProps {
  readonly nodeId: string;
  readonly kind: ChainNodeKind;
  readonly drag?: BoardPortEndpoint | null;
  readonly isConnectable?: boolean;
  readonly onActivate?: (endpoint: BoardPortEndpoint) => void;
}

const sides = {left: Position.Left, right: Position.Right, top: Position.Top, bottom: Position.Bottom};
const labels = {
  'sequence-in': 'boardUi.port.sequenceIn',
  'sequence-out': 'boardUi.port.sequenceOut',
  'reference-in-top': 'boardUi.port.referenceInTop',
  'reference-in-bottom': 'boardUi.port.referenceInBottom',
  'reference-out-top': 'boardUi.port.referenceOutTop',
  'reference-out-bottom': 'boardUi.port.referenceOutBottom',
} as const satisfies Record<BoardPortId, string>;

export const BoardPorts = memo(function BoardPorts({nodeId, kind, drag, isConnectable = true, onActivate}: BoardPortsProps) {
  const {t} = useI18n();
  return <>{boardPorts(kind).map(port => {
    const candidate = Boolean(isConnectable && drag && isBoardPortCandidate(drag, {id: nodeId, kind}, port));
    const origin = drag?.nodeId === nodeId && drag.portId === port.id;
    const endpoint = {nodeId, kind, portId: port.id};
    return <Handle key={port.id} id={port.id} type={port.type} position={sides[port.side]}
      className={`board-port board-port-${port.family}${candidate ? ' is-candidate' : ''}${origin ? ' is-origin' : ''}`}
      isConnectable={isConnectable} isConnectableEnd={!drag || candidate}
      role="button" tabIndex={onActivate && isConnectable ? 0 : -1} aria-label={t(labels[port.id])}
      aria-disabled={!isConnectable || Boolean(drag && !candidate && !origin)}
      data-testid={`board-port-${nodeId}-${port.id}`} data-port-family={port.family} data-port-type={port.type}
      data-port-side={port.side} data-candidate={candidate ? 'true' : 'false'}
      onKeyDown={event => {
        if (!onActivate || !isConnectable || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault(); event.stopPropagation();
        if (!drag || candidate || origin) onActivate(endpoint);
      }} />;
  })}</>;
});

export default BoardPorts;
