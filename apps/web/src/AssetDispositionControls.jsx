import React, { useLayoutEffect, useMemo, useRef } from 'react';
import { Button } from '@mioon/ui/components/button';
import { WorkbenchTooltip } from './WorkspaceControls.jsx';
import { useWorkspaceVisibility } from './workspace-visibility.jsx';
import { dispositionLabels, dispositionRow } from './asset-disposition-state.js';
import './asset-disposition.css';

// Hidden and remounted panels must not replay retained click handlers. The
// controller separately fences project epochs, pending receipts and double taps.
export function useDispositionInteraction(scope, controller, target = null) {
  const visible = useWorkspaceVisibility();
  const token = useMemo(() => ({ scope, visible, target }), [scope, visible, target]);
  const live = useRef(null);
  useLayoutEffect(() => { live.current = token; return () => { live.current = null; }; }, [token]);
  return { visible, admit: action => { if (visible && live.current === token && scope && controller?.getState().scope === scope) return action(); } };
}
export default function AssetDispositionControls({ asset, state, controller, blocked, prefix = 'asset' }) {
  const row = dispositionRow(state, asset.id), entry = state?.entries?.[asset.id];
  const interaction = useDispositionInteraction(state?.scope, controller, asset.id);
  const disabled = !interaction.visible || !row || blocked || Boolean(state?.savingAssetId || state?.uncertain);
  const status = state?.savingAssetId === asset.id ? '正在保存标记…' : row ? dispositionLabels[row.disposition] : entry?.phase === 'loading' ? '标记读取中' : '标记状态未知';
  return <div className="asset-disposition-controls" data-no-asset-drag draggable={false} onPointerDown={event => event.stopPropagation()} onDragStart={event => { event.preventDefault(); event.stopPropagation(); }}>
    <span className={`asset-disposition-label ${row?.disposition || 'unknown'}`} data-testid={`${prefix}-disposition-status-${asset.id}`} role="status">{status}</span>
    <div className="asset-disposition-buttons" role="group" aria-label={`${asset.name} 的素材标记`}>
      {[['favorite', '收藏'], ['rejected', '拒选'], ['neutral', '清除标记']].map(([value, label]) => <WorkbenchTooltip key={value} content={value === 'rejected' ? '拒选仅作筛选标记，已有片段保持不变' : value === 'neutral' ? '恢复为未标记素材' : '标为收藏'}><Button variant="ghost" size="sm" type="button" draggable={false} data-testid={`${prefix}-disposition-${value}-${asset.id}`} aria-label={`${label} ${asset.name}`} aria-pressed={Boolean(row && row.disposition === value)} disabled={disabled || row?.disposition === value} onClick={event => { event.stopPropagation(); interaction.admit(() => controller.set(asset.id, value, state.scope)); }}>{label}</Button></WorkbenchTooltip>)}
    </div>
  </div>;
}
