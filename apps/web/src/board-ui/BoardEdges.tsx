import React, {memo} from 'react';
import type {CSSProperties} from 'react';
import {BaseEdge, getBezierPath, getSmoothStepPath} from '@xyflow/react';
import type {Edge, EdgeProps, EdgeTypes} from '@xyflow/react';
import type {ChainReferenceRole} from '../../../../packages/contracts/src/board-sequence.ts';
import {useI18n} from '../i18n/I18nProvider.tsx';
import './edges.css';

export type BoardSequenceEdge = Edge<{reduceMotion?: boolean}, 'sequence'>;
export type BoardReferenceEdge = Edge<{role: ChainReferenceRole; reduceMotion?: boolean}, 'reference'> & {
  data: {role: ChainReferenceRole; reduceMotion?: boolean};
};

const roleKeys = {
  first_frame: 'boardUi.role.firstFrame',
  subject_reference: 'boardUi.role.subject',
  composition: 'boardUi.role.composition',
  reference_audio: 'boardUi.role.audio',
  reference_video: 'boardUi.role.video',
} as const satisfies Record<ChainReferenceRole, string>;

export const SequenceEdgeView = memo(function SequenceEdgeView(props: EdgeProps<BoardSequenceEdge>) {
  const [path] = getSmoothStepPath({...props, offset: 32, borderRadius: 24});
  const motionStyle: CSSProperties = {offsetPath: `path('${path}') view-box`};
  return <g className="board-sequence-edge" data-board-edge-kind="sequence" data-edge-id={props.id}
    data-testid={`board-sequence-edge-${props.id}`} data-reduce-motion={props.data?.reduceMotion ? 'true' : undefined}>
    <BaseEdge id={props.id} path={path} interactionWidth={props.interactionWidth}
      className="board-sequence-line" style={{...props.style, strokeDasharray: 'none'}} />
    <circle className="board-sequence-dot" r={2.8} cx={0} cy={0} style={motionStyle} aria-hidden="true" />
  </g>;
});

export const ReferenceEdgeView = memo(function ReferenceEdgeView(props: EdgeProps<BoardReferenceEdge>) {
  const {t} = useI18n();
  const [path, labelX, labelY] = getBezierPath(props);
  return <g className="board-reference-edge" data-board-edge-kind="reference" data-edge-id={props.id}
    data-testid={`board-reference-edge-${props.id}`} data-reduce-motion={props.data?.reduceMotion ? 'true' : undefined}>
    <BaseEdge id={props.id} path={path} interactionWidth={props.interactionWidth}
      className="board-reference-line" style={{...props.style, strokeDasharray: '7 6'}} />
    <foreignObject className="board-reference-label-box" x={labelX - 90} y={labelY - 14} width={180} height={28}>
      <div className="board-reference-label">{t(roleKeys[props.data.role])}</div>
    </foreignObject>
  </g>;
});

export const boardEdgeTypes = {sequence: SequenceEdgeView, reference: ReferenceEdgeView} satisfies EdgeTypes;
