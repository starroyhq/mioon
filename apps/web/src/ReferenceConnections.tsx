import { useI18n } from './i18n/I18nProvider.tsx';
import React, { useState } from 'react';
import { Button } from '@mioon/ui/components/button';
import { Label } from '@mioon/ui/components/label';
import { WorkbenchSelect } from './WorkspaceControls.tsx';
import Icon from './icons.tsx';
import { assetUrl } from './api.ts';
import { isImageReferenceNode, isReferenceEdge, referenceAttachIssueDescriptor, referenceSourceDetails, referenceTargetOptions } from './reference-connections.ts';

export function ReferenceSourcePanel({ node, project, assets, shots, edges, busy, pending, dirty, conflict, onAttach, onInspect }) {
  const { locale, t, renderMessage, formatDate, formatNumber } = useI18n();
  const [targetId, setTargetId] = useState('');
  if (!project?.id || !isImageReferenceNode(node, assets, project.id)) return null;
  const source = referenceSourceDetails({ sourceId: node.id, assetId: node.assetId, projectId: project.id, nodes: [node], assets, locale });
  const targets = referenceTargetOptions(shots, project.id, locale);
  const selectedTarget = targets.find(option => option.shot.id === targetId);
  const target = selectedTarget?.shot;
  const issue = referenceAttachIssueDescriptor({ source: node, shot: target, assets, edges, projectId: project.id });
  const connections = edges.filter(edge => isReferenceEdge(edge) && edge.projectId === project.id && edge.source === node.id);
  return <section className="reference-connection-panel" aria-label={t('shell.referenceLink')} data-testid="reference-source-panel">
    <div className="section-heading"><span><Icon name="link" size={14} />{t('shell.referenceLink')}</span></div>
    <p data-testid="reference-source-label" title={source.description} aria-label={source.description}>{source.displayDescription}</p>
    <p>{t('assets.reference.attachHint')}</p>
    <Label className="field-label" htmlFor="attach-reference-target">{t('assets.reference.target')}</Label>
    <WorkbenchSelect id="attach-reference-target" data-testid="attach-reference-target" value={target?.id || ''} title={selectedTarget?.label} aria-describedby={target ? 'reference-target-description' : undefined} disabled={busy} onChange={event => setTargetId(event.target.value)}>
      <option value="">{t('assets.reference.targetPlaceholder')}</option>
      {targets.map(({ shot, label }) => <option key={shot.id} value={shot.id}>{label}</option>)}
    </WorkbenchSelect>
    {selectedTarget && <p id="reference-target-description" className="input-hint" title={selectedTarget.label}>{selectedTarget.label}</p>}
    {target && issue && <div className="reference-connection-issue" role="status" data-testid="reference-attach-issue"><p>{renderMessage(issue)}</p><Button variant="ghost" size="sm" className="text-button" onClick={() => onInspect(target.id)}>{t('assets.reference.openTargetSettings')}<Icon name="arrow" size={12} /></Button></div>}
    {!targets.length && <p className="input-hint">{t('assets.reference.createShotHint')}</p>}
    {(dirty || conflict) && <p className="reference-connection-issue">{t('assets.reference.saveNodeFirst')}</p>}
    {pending && <p className="reference-connection-issue">{t('assets.reference.previousPending')}</p>}
    <Button size="sm" className="button primary full" data-testid="attach-reference" disabled={Boolean(issue) || dirty || conflict || busy} onClick={() => onAttach(node.id, target.id)}><Icon name="link" size={14} />{busy && !pending ? t('assets.reference.syncing') : t('assets.reference.connect')}</Button>
    {connections.length > 0 && <div className="reference-target-list"><span>{t('assets.reference.connectedTo')}</span>{connections.map(edge => {
      const option = targets.find(item => item.shot.id === edge.target);
      return option ? <Button key={edge.id} variant="ghost" size="sm" className="text-button" title={option.label} aria-label={t('assets.reference.connectedTarget', { name: option.label })} onClick={() => onInspect(option.shot.id)}><Icon name="check" size={12} />{option.label}<Icon name="arrow" size={12} /></Button> : <span key={edge.id}>{t('assets.reference.targetUnavailable')}</span>;
    })}</div>}
  </section>;
}

export function BoundReference({ edge, nodes, assets, busy, pending, dirty, conflict, onDetach, onInspect }) {
  const { locale, t, renderMessage, formatDate, formatNumber } = useI18n();
  if (!isReferenceEdge(edge)) return null;
  const { source, asset, sourceName, sourceLabel, assetLabel, description } = referenceSourceDetails({ sourceId: edge.source, assetId: edge.sourceAssetId, projectId: edge.projectId, nodes, assets, locale });
  return <section className="bound-reference" data-testid="bound-reference" aria-label={t('assets.reference.boundDescription', { description })}>
    <div className="bound-reference-heading"><Icon name="link" size={14} /><strong>{t('assets.reference.connected')}</strong></div>
    <div className="bound-reference-source">{asset && <img src={assetUrl(asset)} alt={assetLabel} />}<div><strong title={assetLabel}>{t('assets.reference.sourceAsset', { name: assetLabel })}</strong><span title={sourceLabel}>{t('assets.reference.sourceNode', { name: sourceName })}</span><Button variant="ghost" size="sm" className="text-button" title={sourceLabel} aria-label={t('assets.reference.viewSourceNode', { name: sourceLabel })} disabled={!source} onClick={() => onInspect(source.id)}>{t('assets.reference.openSource')}<Icon name="arrow" size={12} /></Button></div></div>
    <p>{t('assets.reference.boundHint')}</p>
    {(dirty || conflict) && <p className="reference-connection-issue">{t('assets.reference.saveShotFirst')}</p>}
    {pending && <p className="reference-connection-issue">{t('assets.reference.pending')}</p>}
    <Button variant="ghost" size="sm" className="button small full" data-testid="detach-reference" disabled={busy || dirty || conflict} onClick={() => onDetach(edge.id)}><Icon name="close" size={12} />{busy && !pending ? t('assets.reference.syncing') : t('assets.reference.disconnect')}</Button>
  </section>;
}
