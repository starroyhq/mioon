import React, { useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { PrevisNodeRecord } from '@mioon/contracts';
import { PREVIS_LIMITS } from '@mioon/contracts';
import { Button } from '@mioon/ui/components/button';
import { Input } from '@mioon/ui/components/input';
import { Label } from '@mioon/ui/components/label';
import { ScrollArea } from '@mioon/ui/components/scroll-area';
import { ArrowUpRight, Box, Link, Lock } from '@mioon/ui/components/workbench-icons';
import { useI18n } from '../i18n/I18nProvider.tsx';
import { useWorkspaceVisibility } from '../workspace-visibility.tsx';
import BoardInspectorGroup from '../BoardInspectorGroup.tsx';
import { previsSceneSummary } from './previs-editor-state.ts';
import type { PrevisTranslate } from './previs-editor-state.ts';
import './previs.css';

// The inspector of a selected previs node (09-11b): name, the project frame it
// follows, a scene summary and the way into the editor. Keyframes and the
// output section arrive with keyframe export.
export interface PrevisInspectorProps {
  node: PrevisNodeRecord;
  frame: { width: number; height: number; ratio: string };
  readOnly: boolean;
  busy: boolean;
  protectEditing?: (content: ReactNode) => ReactNode;
  onRename: (label: string) => unknown;
  onOpen: () => void;
}
export default function PrevisInspector({ node, frame, readOnly, busy, protectEditing = content => content, onRename, onOpen }: PrevisInspectorProps): React.ReactElement {
  const { t } = useI18n(), visible = useWorkspaceVisibility(), translate = t as unknown as PrevisTranslate;
  const [draft, setDraft] = useState(node.label), editing = useRef(false);
  // Follow renames from elsewhere unless the name is being typed.
  useLayoutEffect(() => { if (!editing.current) setDraft(node.label); }, [node.id, node.label]);
  const commit = (): void => {
    editing.current = false;
    if (readOnly || busy || draft === node.label) { setDraft(node.label); return; }
    onRename(draft);
  };
  const name = node.label || t('previs.node.defaultLabel');
  return <aside className="inspector previs-inspector" data-testid="previs-inspector">
    <header className="inspector-heading previs-inspector-heading"><Box size={15} aria-hidden="true" /><strong title={name}>{name}</strong><span className="previs-local-chip">{t('previs.node.local')}</span></header>
    <ScrollArea style={{ flex: 1, minHeight: 0 }}><div className="inspector-scroll" style={{ overflow: 'visible' }}>
      {protectEditing(<BoardInspectorGroup key={`previs:${node.id}`} title={t('previs.inspector.group')}>
        <div className="shot-property-row"><Label className="field-label" htmlFor="previs-node-name">{t('previs.inspector.name')}</Label>
          <Input id="previs-node-name" data-testid="previs-node-name" value={draft} maxLength={PREVIS_LIMITS.labelLength} placeholder={t('previs.node.defaultLabel')} disabled={readOnly || busy || !visible}
            onFocus={() => { editing.current = true; }} onChange={event => setDraft(event.target.value)} onBlur={commit}
            onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); else if (event.key === 'Escape') { editing.current = false; setDraft(node.label); } }} /></div>
        <div className="shot-property-row"><span className="field-label">{t('previs.inspector.frame')}</span>
          <span className="previs-inspector-frame" data-testid="previs-node-frame"><strong>{frame.ratio}</strong><span>{frame.width}×{frame.height}</span><span className="previs-follow" title={t('previs.inspector.frameHint')}><Link size={11} aria-hidden="true" />{t('previs.inspector.followProject')}</span></span></div>
        <div className="shot-property-row"><span className="field-label">{t('previs.inspector.scene')}</span><span className="previs-inspector-summary" data-testid="previs-node-summary">{previsSceneSummary(node.scene, translate)}</span></div>
        {readOnly && <p className="input-hint previs-inspector-readonly"><Lock size={11} aria-hidden="true" />{t('previs.inspector.readOnly')}</p>}
      </BoardInspectorGroup>)}
    </div></ScrollArea>
    <footer className="previs-inspector-footer"><span className="previs-saved" data-busy={busy || undefined}><span className="previs-saved-dot" aria-hidden="true" />{t(busy ? 'previs.inspector.saving' : 'previs.inspector.saved')}<span>{t('previs.inspector.localNote')}</span></span>
      <Button size="sm" className="button primary" data-testid="previs-open" disabled={!visible} onClick={onOpen}><ArrowUpRight size={14} aria-hidden="true" />{t('previs.inspector.open')}</Button></footer>
  </aside>;
}
