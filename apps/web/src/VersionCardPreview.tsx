import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { WorkbenchButton } from '@mioon/ui/components/workbench-controls';
import { WorkbenchPopover, WorkbenchPopoverTrigger, WorkbenchPopoverTitle, WorkbenchPopoverClose, WorkbenchPopoverContent } from '@mioon/ui/components/workbench-popover';
import { Play, X } from '@mioon/ui/components/workbench-icons';
import { useWorkspaceVisibility, WorkspaceVisibilityProvider } from './workspace-visibility.tsx';
import { useI18n } from './i18n/I18nProvider.tsx';

/** A compact card keeps a full, explicit player available in an owned portal. */
export default function VersionCardPreview({ sourceKey, title, renderMedia }: { sourceKey: string; title: string; renderMedia(controls: boolean): React.ReactNode }) {
  const { t } = useI18n(), visible = useWorkspaceVisibility(), [opened, setOpened] = useState(false);
  const token = useMemo(() => ({ sourceKey, visible }), [sourceKey, visible]), live = useRef<typeof token | null>(null);
  useLayoutEffect(() => { live.current = token; setOpened(false); return () => { live.current = null; }; }, [token]);
  const current = () => visible && live.current === token;
  return <WorkbenchPopover open={opened && visible} onOpenChange={next => { if (current()) setOpened(next); }}>
    <WorkbenchPopoverTrigger render={<WorkbenchButton variant="ghost" className="version-card-preview-trigger" aria-label={t('redesign.board.previewVersion', { version: title })} disabled={!visible} />}>
      {renderMedia(false)}<span className="version-card-preview-play"><Play size={14} /></span>
    </WorkbenchPopoverTrigger>
    <WorkbenchPopoverContent className="version-card-preview-popover" side="left" hidden={!visible} inert={!visible} finalFocus={visible ? undefined : false}>
      <header><WorkbenchPopoverTitle>{title}</WorkbenchPopoverTitle><WorkbenchPopoverClose render={<WorkbenchButton variant="icon" aria-label={t('common.close')} />}><X size={14} /></WorkbenchPopoverClose></header>
      {opened && visible && <WorkspaceVisibilityProvider visible={opened}>{renderMedia(true)}</WorkspaceVisibilityProvider>}
    </WorkbenchPopoverContent>
  </WorkbenchPopover>;
}
