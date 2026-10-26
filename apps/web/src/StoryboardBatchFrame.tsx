import React from 'react';
import { EdgeLabelRenderer, useNodes } from '@xyflow/react';
import Icon from './icons.tsx';
import './scene-storyboard.css';

const pad = 24, head = 52;
/** The outline around a just-built storyboard's shots (09-08b). It only shows the
 * selection; there is no group entity, so it sits under the nodes and takes no input. */
export default function StoryboardBatchFrame({ shotIds, title, detail, time }: { shotIds: readonly string[]; title: string; detail: string; time: string }) {
  const nodes = useNodes(), wanted = new Set(shotIds);
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const node of nodes) {
    if (!wanted.has(node.id)) continue;
    const width = node.measured?.width ?? node.width ?? 0, height = node.measured?.height ?? node.height ?? 0;
    left = Math.min(left, node.position.x); top = Math.min(top, node.position.y);
    right = Math.max(right, node.position.x + width); bottom = Math.max(bottom, node.position.y + height);
  }
  if (!Number.isFinite(left) || right <= left || bottom <= top) return null;
  return <EdgeLabelRenderer><div className="storyboard-batch-frame" data-testid="storyboard-batch-frame"
    style={{ transform: `translate(${left - pad}px, ${top - pad - head}px)`, width: right - left + pad * 2, height: bottom - top + pad * 2 + head }}>
    <header><Icon name="film" size={14} /><strong>{title}</strong><span>{detail}</span><time>{time}</time></header>
  </div></EdgeLabelRenderer>;
}
