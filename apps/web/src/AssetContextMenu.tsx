import React from 'react';
import { DropdownMenuItem, DropdownMenuSeparator } from '@mioon/ui/components/dropdown-menu';
import { WorkbenchContextMenu } from '@mioon/ui/components/workbench-context-menu';
import type { WorkbenchPointerAnchor } from '@mioon/ui/components/workbench-context-menu';
import { WorkbenchBadge } from '@mioon/ui/components/workbench-controls';
import { useI18n } from './i18n/I18nProvider.tsx';
import Icon from './icons.tsx';
import { sceneSourceIssueMessage } from './scene-detection.ts';
import type { SceneSourceAsset } from './scene-detection.ts';
import './scene-detection.css';

export interface AssetContextMenuProps {
  readonly asset: SceneSourceAsset & { name: string };
  readonly kind: string;
  readonly anchor: WorkbenchPointerAnchor;
  readonly onClose: () => void;
  readonly onCanvas?: () => void;
  readonly onTimeline?: () => void;
  readonly timelineDisabled: boolean;
  readonly onPreview: () => void;
  readonly onDetectScenes?: () => void;
}
/** An asset card's right-click menu: the card's own actions, plus 拆解镜头 for a video. */
export default function AssetContextMenu({ asset, kind, anchor, onClose, onCanvas, onTimeline, timelineDisabled, onPreview, onDetectScenes }: AssetContextMenuProps) {
  const { t, renderMessage } = useI18n();
  const detect = onDetectScenes && kind === 'video', issue = detect ? sceneSourceIssueMessage(asset) : null;
  return <WorkbenchContextMenu anchor={anchor} onClose={onClose} className="asset-context-menu" data-testid="asset-context-menu" aria-label={t('scene.menu.actions', { name: asset.name })}>
    {onCanvas && <DropdownMenuItem data-testid="asset-menu-canvas" onClick={onCanvas}><Icon name="grid" size={14} />{t('assets.addToCanvas')}</DropdownMenuItem>}
    <DropdownMenuItem data-testid="asset-menu-timeline" disabled={timelineDisabled || !onTimeline} onClick={onTimeline}><Icon name="film" size={14} />{t('assets.addToEditing')}</DropdownMenuItem>
    <DropdownMenuItem data-testid="asset-menu-preview" onClick={onPreview}><Icon name="play" size={14} />{t('scene.menu.preview')}</DropdownMenuItem>
    {detect && <><DropdownMenuSeparator /><DropdownMenuItem className="scene-menu-item" data-testid="asset-menu-detect-scenes" disabled={Boolean(issue)} onClick={onDetectScenes}><Icon name="scissors" size={14} />
      <span className="scene-menu-copy">{t('scene.menu.detect')}<small>{issue ? renderMessage(issue) : t('scene.menu.detectHint')}</small></span><WorkbenchBadge>{t('scene.menu.new')}</WorkbenchBadge></DropdownMenuItem></>}
  </WorkbenchContextMenu>;
}
