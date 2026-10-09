import React, { useState } from 'react';
import { Button } from '@mioon/ui/components/button';
import { Label } from '@mioon/ui/components/label';
import { WorkbenchSelect } from './WorkspaceControls.jsx';
import Icon from './icons.jsx';
import { assetUrl } from './api.js';
import { isImageReferenceNode, isReferenceEdge, referenceAttachIssue } from './reference-connections.js';

export function ReferenceSourcePanel({ node, project, assets, shots, edges, busy, pending, dirty, conflict, onAttach, onInspect }) {
  const [targetId, setTargetId] = useState('');
  if (!isImageReferenceNode(node, assets, project?.id)) return null;
  const target = shots.find(shot => shot.id === targetId);
  const issue = referenceAttachIssue({ source: node, shot: target, assets, edges, projectId: project.id });
  const connections = edges.filter(edge => isReferenceEdge(edge) && edge.source === node.id);
  return <section className="reference-connection-panel" aria-label="首帧参考连接" data-testid="reference-source-panel">
    <div className="section-heading"><span><Icon name="link" size={14} />首帧参考连接</span></div>
    <p>把这张图片作为目标镜头的生成首帧。每个镜头最多连接一张；连接前须清空已保存的手动参考图。</p>
    <Label className="field-label" htmlFor="attach-reference-target">目标镜头</Label>
    <WorkbenchSelect id="attach-reference-target" data-testid="attach-reference-target" value={targetId} disabled={busy} onChange={event => setTargetId(event.target.value)}>
      <option value="">选择目标镜头</option>
      {shots.map(shot => <option key={shot.id} value={shot.id}>{shot.title}</option>)}
    </WorkbenchSelect>
    {target && issue && <div className="reference-connection-issue" role="status" data-testid="reference-attach-issue"><p>{issue}</p><Button variant="ghost" size="sm" className="text-button" onClick={() => onInspect(target.id)}>打开目标镜头设置<Icon name="arrow" size={12} /></Button></div>}
    {!shots.length && <p className="input-hint">先在画布上创建一个镜头。</p>}
    {(dirty || conflict) && <p className="reference-connection-issue">请先保存或放弃节点修改，再连接首帧。</p>}
    {pending && <p className="reference-connection-issue">上次连接操作结果待确认，请在任务面板恢复同一请求。</p>}
    <Button size="sm" className="button primary full" data-testid="attach-reference" disabled={Boolean(issue) || dirty || conflict || busy} onClick={() => onAttach(node.id, target.id)}><Icon name="link" size={14} />{busy && !pending ? '正在同步连接…' : '连接为首帧参考'}</Button>
    {connections.length > 0 && <div className="reference-target-list"><span>已连接到</span>{connections.map(edge => <Button key={edge.id} variant="ghost" size="sm" className="text-button" onClick={() => onInspect(edge.target)}><Icon name="check" size={12} />{shots.find(shot => shot.id === edge.target)?.title || '镜头'}<Icon name="arrow" size={12} /></Button>)}</div>}
  </section>;
}

export function BoundReference({ edge, nodes, assets, busy, pending, dirty, conflict, onDetach, onInspect }) {
  if (!edge) return null;
  const source = nodes.find(node => node.id === edge.source);
  const asset = assets.find(item => item.id === edge.sourceAssetId);
  return <section className="bound-reference" data-testid="bound-reference" aria-label="已连接的首帧参考">
    <div className="bound-reference-heading"><Icon name="link" size={14} /><strong>已连接首帧参考</strong></div>
    <div className="bound-reference-source">{asset && <img src={assetUrl(asset)} alt={asset.name} />}<div><strong>{source?.label || asset?.name || '图片节点'}</strong><span>{asset?.name || '素材不可用，请检查项目'}</span><Button variant="ghost" size="sm" className="text-button" disabled={!source} onClick={() => onInspect(edge.source)}>查看来源节点<Icon name="arrow" size={12} /></Button></div></div>
    <p>生成会使用此连接的图片。要换图或改为文生视频，请先断开连接；原始素材与节点会保留。</p>
    {(dirty || conflict) && <p className="reference-connection-issue">请先保存或放弃镜头修改，再断开连接。</p>}
    {pending && <p className="reference-connection-issue">连接操作结果待确认，请在任务面板恢复同一请求。</p>}
    <Button variant="ghost" size="sm" className="button small full" data-testid="detach-reference" disabled={busy || dirty || conflict} onClick={() => onDetach(edge.id)}><Icon name="close" size={12} />{busy && !pending ? '正在同步连接…' : '断开首帧连接'}</Button>
  </section>;
}
