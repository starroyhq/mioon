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
import { previsKeyframeLabel, previsKeyframeName } from './previs-keyframes.ts';
import { previsConnectedShots, previsFramedNames, previsKeyframeUses, previsShotFrames, previsShotNumber } from './previs-output.ts';
import type { PrevisEdgeView, PrevisShotView } from './previs-output.ts';
import './previs.css';

// The inspector of a selected previs node (09-11b): name, the project frame it
// follows and a scene summary; its keyframes with what each one frames and
// feeds; the shots it is linked to and the export format; the way into the editor.
export interface PrevisInspectorProps {
  node: PrevisNodeRecord;
  frame: { width: number; height: number; aspect?: number; ratio: string };
  readOnly: boolean;
  busy: boolean;
  shots?: readonly PrevisShotView[];
  edges?: readonly PrevisEdgeView[];
  /** Cached keyframe thumbnails by keyframe ID. */
  keyframeThumbnails?: Readonly<Record<string, string>>;
  protectEditing?: (content: ReactNode) => ReactNode;
  onRename: (label: string) => unknown;
  onOpen: () => void;
}
export default function PrevisInspector({ node, frame, readOnly, busy, shots = [], edges = [], keyframeThumbnails = {}, protectEditing = content => content, onRename, onOpen }: PrevisInspectorProps): React.ReactElement {
  const { t } = useI18n(), visible = useWorkspaceVisibility(), translate = t as unknown as PrevisTranslate;
  const [draft, setDraft] = useState(node.label), editing = useRef(false);
  // Follow renames from elsewhere unless the name is being typed.
  useLayoutEffect(() => { if (!editing.current) setDraft(node.label); }, [node.id, node.label]);
  const commit = (): void => {
    editing.current = false;
    if (readOnly || busy || draft === node.label) { setDraft(node.label); return; }
    onRename(draft);
  };
  const name = node.label || t('previs.node.defaultLabel'), scene = node.scene, aspect = frame.aspect ?? frame.width / frame.height;
  const uses = previsKeyframeUses(scene, shots), connected = previsConnectedShots(node.id, shots, edges), separator = t('previs.list.separator');
  const shotLine = (shot: PrevisShotView): string => shot.title ? t('previs.shot.label', { number: previsShotNumber(shot), title: shot.title }) : t('previs.shot.untitled', { number: previsShotNumber(shot) });
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
        <div className="shot-property-row"><span className="field-label">{t('previs.inspector.scene')}</span><span className="previs-inspector-summary" data-testid="previs-node-summary">{previsSceneSummary(scene, translate)}</span></div>
        {readOnly && <p className="input-hint previs-inspector-readonly"><Lock size={11} aria-hidden="true" />{t('previs.inspector.readOnly')}</p>}
      </BoardInspectorGroup>)}
      <BoardInspectorGroup key={`keyframes:${node.id}`} title={t('previs.inspector.keyframes')} meta={scene.keyframes.length || undefined}>
        {scene.keyframes.length ? <ol className="previs-inspector-keyframes" data-testid="previs-inspector-keyframes" style={{ '--previs-frame-aspect': String(aspect) } as React.CSSProperties}>
          {scene.keyframes.map((keyframe, index) => {
            const focal = Math.round(keyframe.camera.focalLength), names = previsFramedNames(scene, keyframe.camera, aspect, translate), use = uses.get(keyframe.id)?.[0], url = keyframeThumbnails[keyframe.id];
            return <li key={keyframe.id} data-testid={`previs-inspector-keyframe-${keyframe.id}`}>
              <span className="previs-keyframe-thumb">{url ? <img src={url} alt="" draggable={false} /> : <Box size={14} aria-hidden="true" />}</span>
              <span className="previs-inspector-keyframe-text"><strong><span className="previs-keyframe-label">{previsKeyframeLabel(index)}</span>{previsKeyframeName(keyframe, translate)}</strong>
                <small>{names.length ? t('previs.inspector.keyframeDetail', { focal, names: names.join(separator) }) : t('previs.inspector.keyframeNothing', { focal })}</small></span>
              {use && <span className="previs-keyframe-badge"><Link size={10} aria-hidden="true" /><span>{t(use.role === 'first' ? 'previs.keyframe.useFirst' : 'previs.keyframe.useLast', { number: previsShotNumber(use.shot) })}</span></span>}
            </li>;
          })}
        </ol> : <p className="input-hint">{t('previs.inspector.noKeyframes')}</p>}
      </BoardInspectorGroup>
      <BoardInspectorGroup key={`output:${node.id}`} title={t('previs.inspector.output')}>
        <div className="previs-inspector-output" data-testid="previs-inspector-output">
          <span className="field-label">{t('previs.inspector.connectedTo')}</span>
          {connected.length ? <ul>{connected.map(shot => {
            const frames = previsShotFrames(scene, shot), roles = [frames.first >= 0 ? t('previs.inspector.roleFirst', { label: previsKeyframeLabel(frames.first) }) : null, frames.last >= 0 ? t('previs.inspector.roleLast', { label: previsKeyframeLabel(frames.last) }) : null].filter(Boolean);
            return <li key={shot.id} data-testid={`previs-inspector-shot-${shot.id}`}><strong title={shotLine(shot)}>{shotLine(shot)}</strong><small>{roles.length ? roles.join(' · ') : t('previs.inspector.roleNone')}</small></li>;
          })}</ul> : <p className="input-hint">{t('previs.inspector.notConnected')}</p>}
          <span className="field-label">{t('previs.inspector.export')}</span>
          <span className="previs-inspector-format">{t('previs.inspector.exportFormat', { width: frame.width, height: frame.height })}</span>
        </div>
      </BoardInspectorGroup>
    </div></ScrollArea>
    <footer className="previs-inspector-footer"><span className="previs-saved" data-busy={busy || undefined}><span className="previs-saved-dot" aria-hidden="true" />{t(busy ? 'previs.inspector.saving' : 'previs.inspector.saved')}<span>{t('previs.inspector.localNote')}</span></span>
      <Button size="sm" className="button primary" data-testid="previs-open" disabled={!visible} onClick={onOpen}><ArrowUpRight size={14} aria-hidden="true" />{t('previs.inspector.open')}</Button></footer>
  </aside>;
}
