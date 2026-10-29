import React, { memo, useEffect, useRef } from 'react';
import type { ReactElement } from 'react';
import { Handle, Position } from '@xyflow/react';
import { Box, Diamond, RefreshCw } from '@mioon/ui/components/workbench-icons';
import { useI18n } from '../i18n/I18nProvider.tsx';
import { VISUAL_SOURCE_HANDLE, VISUAL_TARGET_HANDLE } from '../reference-connections.ts';
import './previs.css';

// The previs card on the canvas (09-11): the latest card thumbnail the editor
// rendered, the keyframe count, the project frame and the local-render note.
// A thumbnail older than the saved scene (Mio or an undo changed it) says so
// until the editor renders the card again.
export interface PrevisNodeData {
  record: { id: string; label?: string; scene?: { keyframes?: readonly unknown[] } | null };
  thumbnail: string | null;
  /** The thumbnail was rendered before the current scene was saved. */
  outdated?: boolean;
  ratio: string;
  /** Opens the editor for this node. */
  onOpen?: (nodeId: string) => void;
}
function PrevisNodeCard({ data, selected }: { data: PrevisNodeData; selected?: boolean }): ReactElement {
  const { t } = useI18n(), record = data.record, name = record.label || t('previs.node.defaultLabel');
  const keyframes = Array.isArray(record.scene?.keyframes) ? record.scene!.keyframes!.length : 0;
  const card = useRef<HTMLElement | null>(null), open = useRef(data.onOpen);
  open.current = data.onOpen;
  // The canvas zooms on a double-click and stops the event before React sees
  // it, unless the node can be dragged. The card takes its double-click first.
  useEffect(() => {
    const element = card.current;
    if (!element) return;
    const onDoubleClick = (event: MouseEvent): void => {
      if (!open.current || (event.target as Element | null)?.closest?.('.react-flow__handle')) return;
      event.preventDefault(); event.stopPropagation();
      open.current(record.id);
    };
    element.addEventListener('dblclick', onDoubleClick);
    return () => element.removeEventListener('dblclick', onDoubleClick);
  }, [record.id]);
  return <article ref={card} className={`canvas-node previs-node ${selected ? 'is-selected' : ''}`} data-testid={`previs-node-${record.id}`} data-text-selectable={false}>
    <Handle id={VISUAL_TARGET_HANDLE} type="target" position={Position.Left} aria-label={t('previs.node.visualInput')} title={t('shell.node.visualOnly')} />
    <header className="node-header"><span className="type-icon"><Box size={15} aria-hidden="true" /></span><span className="node-title" title={name}>{name}</span></header>
    <div className="previs-node-media">
      {data.thumbnail ? <img src={data.thumbnail} alt={t('previs.node.thumbnail', { name })} draggable={false} data-testid={`previs-node-thumbnail-${record.id}`} />
        : <div className="previs-node-empty"><Box size={22} aria-hidden="true" /><span>{t('previs.node.empty')}</span></div>}
      {data.thumbnail && data.outdated && <span className="previs-node-badge previs-node-outdated" data-testid={`previs-node-outdated-${record.id}`} title={t('previs.node.outdatedHint')}><RefreshCw size={10} aria-hidden="true" />{t('previs.node.outdated')}</span>}
      {keyframes > 0 && <span className="previs-node-badge" data-testid={`previs-node-keyframes-${record.id}`}><Diamond size={10} aria-hidden="true" />{t('previs.node.keyframes', { count: keyframes })}</span>}
    </div>
    <footer className="node-footer"><span className="node-output-spec">{data.ratio}</span><span className="previs-node-local">{t('previs.node.local')}</span></footer>
    <Handle id={VISUAL_SOURCE_HANDLE} type="source" position={Position.Right} aria-label={t('previs.node.visualOutput')} title={t('shell.node.visualOnly')} />
  </article>;
}
const PrevisNode = memo(PrevisNodeCard);
export default PrevisNode;
