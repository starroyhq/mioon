import { useI18n } from './i18n/I18nProvider.tsx';
import React, { useLayoutEffect, useMemo, useRef } from 'react';
import { Button } from '@mioon/ui/components/button';
import { WorkbenchTooltip } from './WorkspaceControls.tsx';
import { useWorkspaceVisibility } from './workspace-visibility.tsx';
import {Star,CircleSlash,RotateCcw} from '@mioon/ui/components/workbench-icons';
import { dispositionLabels, dispositionRow } from './asset-disposition-state.ts';
import type { DisplayMessage } from '../../../packages/i18n/src/index.ts';

interface DispositionRow {disposition: string}
interface DispositionEntry {phase?: string}
export interface DispositionState {scope?: string | null; entries?: Record<string, DispositionEntry>; savingAssetId?: string | null; uncertain?: boolean}
export interface DispositionController {getState(): {scope?: string | null}; set(assetId: string, value: string, scope: string | null | undefined): unknown}
export interface DispositionAsset {id: string; name: string}
type DispositionLabelMap = Readonly<Record<string, DisplayMessage>>;
import './asset-disposition.css';

// Hidden and remounted panels must not replay retained click handlers. The
// controller separately fences project epochs, pending receipts and double taps.
export function useDispositionInteraction(scope: unknown, controller: DispositionController | null | undefined, target: unknown = null) {
  const visible = useWorkspaceVisibility();
  const token = useMemo(() => ({ scope, visible, target }), [scope, visible, target]);
  const live = useRef<{scope: unknown; visible: boolean; target: unknown} | null>(null);
  useLayoutEffect(() => { live.current = token; return () => { live.current = null; }; }, [token]);
  return { visible, admit: (action: () => unknown): unknown => { if (visible && live.current === token && scope && controller?.getState().scope === scope) return action(); } };
}
export default function AssetDispositionControls({ asset, state, controller, blocked, prefix = 'asset', compact = false }: {asset: DispositionAsset; state: DispositionState; controller: DispositionController; blocked?: boolean; prefix?: string; compact?: boolean}) {
  const { t, renderMessage, formatDate, formatNumber } = useI18n();
  const row: DispositionRow | null = dispositionRow(state as never, asset.id), labels = dispositionLabels as DispositionLabelMap, entry = state?.entries?.[asset.id];
  const interaction = useDispositionInteraction(state?.scope, controller, asset.id);
  const disabled = !interaction.visible || !row || blocked || Boolean(state?.savingAssetId || state?.uncertain);
  const status = state?.savingAssetId === asset.id ? t('assets.mark.saving') : row ? renderMessage(labels[row.disposition] as DisplayMessage) : entry?.phase === 'loading' ? t('assets.mark.loading') : t('assets.mark.unknown');
  return <div className={`asset-disposition-controls ${compact ? 'asset-marks-compact' : ''}`} data-no-asset-drag draggable={false} onPointerDown={event => event.stopPropagation()} onDragStart={event => { event.preventDefault(); event.stopPropagation(); }}>
    <span className={`asset-disposition-label ${row?.disposition || 'unknown'}`} data-testid={`${prefix}-disposition-status-${asset.id}`} role="status">{status}</span>
    <div className="asset-disposition-buttons" role="group" aria-label={t('assets.mark.named', { name: asset.name })}>
      {([['favorite', t('assets.mark.favorite')], ['rejected', t('assets.mark.rejected')], ['neutral', t('assets.mark.clear')]] as ReadonlyArray<readonly [string, string]>).map(([value, label]) => <WorkbenchTooltip key={value} content={value === 'rejected' ? t('assets.mark.rejectHint') : value === 'neutral' ? t('assets.mark.clearHint') : t('assets.mark.favoriteHint')}><Button variant="ghost" size="sm" type="button" draggable={false} data-testid={`${prefix}-disposition-${value}-${asset.id}`} aria-label={t('assets.mark.actionNamed', { action: label, name: asset.name })} aria-pressed={Boolean(row && row.disposition === value)} disabled={disabled || row?.disposition === value} onClick={event => { event.stopPropagation(); interaction.admit(() => controller.set(asset.id, value, state.scope)); }}>{compact ? <>{value === 'favorite' ? <Star size={13}/> : value === 'rejected' ? <CircleSlash size={13}/> : <RotateCcw size={13}/>}<span className="sr-only">{label}</span></> : label}</Button></WorkbenchTooltip>)}
    </div>
  </div>;
}
