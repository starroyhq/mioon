import React, { useState } from 'react';
import { Button } from '@mioon/ui/components/button';
import { Label } from '@mioon/ui/components/label';
import { WorkbenchSelect } from './WorkspaceControls.jsx';
import Icon from './icons.jsx';
import { assetUrl } from './api.js';
import { isImageReferenceNode, isReferenceEdge, referenceAttachIssue, referenceSourceDetails, referenceTargetOptions } from './reference-connections.js';

export function ReferenceSourcePanel({ node, project, assets, shots, edges, busy, pending, dirty, conflict, onAttach, onInspect }) {
  const [targetId, setTargetId] = useState('');
  if (!project?.id || !isImageReferenceNode(node, assets, project.id)) return null;
  const source = referenceSourceDetails({ sourceId: node.id, assetId: node.assetId, projectId: project.id, nodes: [node], assets });
  const targets = referenceTargetOptions(shots, project.id);
  const selectedTarget = targets.find(option => option.shot.id === targetId);
  const target = selectedTarget?.shot;
  const issue = referenceAttachIssue({ source: node, shot: target, assets, edges, projectId: project.id });
  const connections = edges.filter(edge => isReferenceEdge(edge) && edge.projectId === project.id && edge.source === node.id);
  return <section className="reference-connection-panel" aria-label="首帧参考连接" data-testid="reference-source-panel">
    <div className="section-heading"><span><Icon name="link" size={14} />首帧参考连接</span></div>
    <p data-testid="reference-source-label" title={source.description} aria-label={source.description}>{source.displayDescription}</p>
    <p>把这张图片作为目标镜头的生成首帧。每个镜头最多连接一张；连接前须清空已保存的手动参考图。</p>
    <Label className="field-label" htmlFor="attach-reference-target">目标镜头</Label>
    <WorkbenchSelect id="attach-reference-target" data-testid="attach-reference-target" value={target?.id || ''} title={selectedTarget?.label} aria-describedby={target ? 'reference-target-description' : undefined} disabled={busy} onChange={event => setTargetId(event.target.value)}>
      <option value="">选择目标镜头</option>
      {targets.map(({ shot, label }) => <option key={shot.id} value={shot.id}>{label}</option>)}
    </WorkbenchSelect>
    {selectedTarget && <p id="reference-target-description" className="input-hint" title={selectedTarget.label}>{selectedTarget.label}</p>}
    {target && issue && <div className="reference-connection-issue" role="status" data-testid="reference-attach-issue"><p>{issue}</p><Button variant="ghost" size="sm" className="text-button" onClick={() => onInspect(target.id)}>打开目标镜头设置<Icon name="arrow" size={12} /></Button></div>}
    {!targets.length && <p className="input-hint">先在画布上创建一个镜头。</p>}
    {(dirty || conflict) && <p className="reference-connection-issue">请先保存或放弃节点修改，再连接首帧。</p>}
    {pending && <p className="reference-connection-issue">上次连接操作结果待确认，请在任务面板恢复同一请求。</p>}
    <Button size="sm" className="button primary full" data-testid="attach-reference" disabled={Boolean(issue) || dirty || conflict || busy} onClick={() => onAttach(node.id, target.id)}><Icon name="link" size={14} />{busy && !pending ? '正在同步连接…' : '连接为首帧参考'}</Button>
    {connections.length > 0 && <div className="reference-target-list"><span>已连接到</span>{connections.map(edge => {
      const option = targets.find(item => item.shot.id === edge.target);
      return option ? <Button key={edge.id} variant="ghost" size="sm" className="text-button" title={option.label} aria-label={`查看已连接目标：${option.label}`} onClick={() => onInspect(option.shot.id)}><Icon name="check" size={12} />{option.label}<Icon name="arrow" size={12} /></Button> : <span key={edge.id}>目标镜头不可用</span>;
    })}</div>}
  </section>;
}

export function BoundReference({ edge, nodes, assets, busy, pending, dirty, conflict, onDetach, onInspect }) {
  if (!isReferenceEdge(edge)) return null;
  const { source, asset, sourceName, sourceLabel, assetLabel, description } = referenceSourceDetails({ sourceId: edge.source, assetId: edge.sourceAssetId, projectId: edge.projectId, nodes, assets });
  return <section className="bound-reference" data-testid="bound-reference" aria-label={`已连接的首帧参考，${description}`}>
    <div className="bound-reference-heading"><Icon name="link" size={14} /><strong>已连接首帧参考</strong></div>
    <div className="bound-reference-source">{asset && <img src={assetUrl(asset)} alt={assetLabel} />}<div><strong title={assetLabel}>来源素材：{assetLabel}</strong><span title={sourceLabel}>来源节点：{sourceName}</span><Button variant="ghost" size="sm" className="text-button" title={sourceLabel} aria-label={`查看来源节点：${sourceLabel}`} disabled={!source} onClick={() => onInspect(source.id)}>查看来源节点<Icon name="arrow" size={12} /></Button></div></div>
    <p>生成会使用此连接的图片。要换图或改为文生视频，请先断开连接；原始素材与节点会保留。</p>
    {(dirty || conflict) && <p className="reference-connection-issue">请先保存或放弃镜头修改，再断开连接。</p>}
    {pending && <p className="reference-connection-issue">连接操作结果待确认，请在任务面板恢复同一请求。</p>}
    <Button variant="ghost" size="sm" className="button small full" data-testid="detach-reference" disabled={busy || dirty || conflict} onClick={() => onDetach(edge.id)}><Icon name="close" size={12} />{busy && !pending ? '正在同步连接…' : '断开首帧连接'}</Button>
  </section>;
}
