import React, {memo} from 'react';
import type {CSSProperties} from 'react';
import {BaseEdge, getSmoothStepPath, Position} from '@xyflow/react';
import type {Edge, EdgeProps, EdgeTypes, GetBezierPathParams} from '@xyflow/react';
import type {ChainReferenceRole} from '../../../../packages/contracts/src/board-sequence.ts';
import {useI18n} from '../i18n/I18nProvider.tsx';
import './edges.css';

export type BoardSequenceEdge = Edge<{reduceMotion?: boolean; selected?: boolean}, 'sequence'>;
export type BoardReferenceEdge = Edge<{role: ChainReferenceRole; reduceMotion?: boolean; selected?: boolean;
  unsupported?: boolean}, 'reference'> & {
  data: {role: ChainReferenceRole; reduceMotion?: boolean; selected?: boolean; unsupported?: boolean};
};

const roleKeys = {
  first_frame: 'boardUi.role.firstFrame',
  last_frame: 'boardUi.role.lastFrame',
  reference_image: 'boardUi.role.referenceImage',
  subject_reference: 'boardUi.role.subject',
  style_reference: 'boardUi.role.style',
  composition: 'boardUi.role.composition',
  reference_audio: 'boardUi.role.audio',
  reference_video: 'boardUi.role.video',
} as const satisfies Record<ChainReferenceRole, string>;

const portNormals = {
  [Position.Left]: {x: -1, y: 0},
  [Position.Right]: {x: 1, y: 0},
  [Position.Top]: {x: 0, y: -1},
  [Position.Bottom]: {x: 0, y: 1},
};
type ReferencePathParams = Pick<GetBezierPathParams, 'sourceX'|'sourceY'|'targetX'|'targetY'|'sourcePosition'|'targetPosition'>;

/** Endpoint normals define the curve; no obstacle routing is implied. */
export function getBoardReferencePath({sourceX, sourceY, targetX, targetY,
  sourcePosition = Position.Bottom, targetPosition = Position.Top}: ReferencePathParams): [string, number, number] {
  const sourceNormal = portNormals[sourcePosition], targetNormal = portNormals[targetPosition];
  const dx = targetX - sourceX, dy = targetY - sourceY;
  const reach = (facingGap: number): number => facingGap > 0
    ? Math.min(96, facingGap * .4)
    : Math.min(64, Math.max(16, Math.hypot(dx, dy) * .15));
  // Facing vertical handles spend at most 40% of the gap at either end.
  // Their ordered Y control polygon makes the cubic monotone without overshoot.
  const sourceReach = reach(dx * sourceNormal.x + dy * sourceNormal.y);
  const targetReach = reach(-dx * targetNormal.x - dy * targetNormal.y);
  const sourceControl = {x: sourceX + sourceNormal.x * sourceReach, y: sourceY + sourceNormal.y * sourceReach};
  const targetControl = {x: targetX + targetNormal.x * targetReach, y: targetY + targetNormal.y * targetReach};
  return [
    `M${sourceX},${sourceY} C${sourceControl.x},${sourceControl.y} ${targetControl.x},${targetControl.y} ${targetX},${targetY}`,
    (sourceX + 3 * sourceControl.x + 3 * targetControl.x + targetX) / 8,
    (sourceY + 3 * sourceControl.y + 3 * targetControl.y + targetY) / 8,
  ];
}

export const SequenceEdgeView = memo(function SequenceEdgeView(props: EdgeProps<BoardSequenceEdge>) {
  const [path] = getSmoothStepPath({...props, offset: 32, borderRadius: 24});
  const motionStyle: CSSProperties = {offsetPath: `path('${path}') view-box`};
  return <g className={`board-sequence-edge${props.data?.selected ? ' is-selected' : ''}`} data-board-edge-kind="sequence" data-edge-id={props.id}
    data-testid={`board-sequence-edge-${props.id}`} data-reduce-motion={props.data?.reduceMotion ? 'true' : undefined}>
    <BaseEdge id={props.id} path={path} interactionWidth={props.interactionWidth}
      className="board-sequence-line" style={{...props.style, strokeDasharray: 'none'}} />
    <circle className="board-sequence-dot" r={2.8} cx={0} cy={0} style={motionStyle} aria-hidden="true" />
  </g>;
});

export const ReferenceEdgeView = memo(function ReferenceEdgeView(props: EdgeProps<BoardReferenceEdge>) {
  const {t} = useI18n();
  const [path, labelX, labelY] = getBoardReferencePath(props);
  const unsupported = props.data?.unsupported === true;
  return <g className={`board-reference-edge${props.data?.selected ? ' is-selected' : ''}${unsupported ? ' is-unsupported' : ''}`}
    data-board-edge-kind="reference" data-edge-id={props.id} data-unsupported={unsupported ? 'true' : undefined}
    data-testid={`board-reference-edge-${props.id}`} data-reduce-motion={props.data?.reduceMotion ? 'true' : undefined}>
    <BaseEdge id={props.id} path={path} interactionWidth={props.interactionWidth}
      className="board-reference-line" style={{...props.style, strokeDasharray: '7 6'}} />
    <foreignObject className="board-reference-label-box" x={labelX - 90} y={labelY - 14} width={180} height={28}>
      <div className="board-reference-label">{t(roleKeys[props.data.role])}
        {unsupported && <span className="board-reference-unsupported"> · {t('boardUi.inputs.unsupported')}</span>}
      </div>
    </foreignObject>
  </g>;
});

export const boardEdgeTypes = {sequence: SequenceEdgeView, reference: ReferenceEdgeView} satisfies EdgeTypes;
