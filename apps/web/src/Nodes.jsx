import { Button } from '@video-workbench/ui/components/button';
import React, { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import Icon from './icons.jsx';
import { activeJob, assetUrl, statusText, versionUrl } from './api.js';

export function Media({ asset, version, className = '', controls = false, ...props }) {
  const url = version ? versionUrl(version) : assetUrl(asset);
  const video = Boolean(version || asset?.mimeType?.startsWith('video/'));
  const audio = asset?.mimeType?.startsWith('audio/');
  if (!url) return <div className={`media-placeholder ${className}`}><Icon name="film" size={32} /><span>等待你的第一个画面</span></div>;
  if (audio) return <div className={`media-audio ${className}`}><Icon name="music" size={28} />{controls ? <audio className="nodrag nowheel" src={url} controls preload="metadata" {...props} /> : <span>音频素材</span>}</div>;
  return video ? <video className={`media-content ${className} ${controls ? 'nodrag nowheel' : ''}`} src={url} controls={controls} muted playsInline preload="metadata" {...props} /> : <img className={`media-content ${className}`} src={url} alt={asset?.name || '镜头参考图'} loading="lazy" {...props} />;
}
const ShotNode = memo(function ShotNode({ data, selected }) {
  const { record, asset, version, job, index, onInspect, onGenerate } = data;
  const generating = job && activeJob(job);
  return <article className={`canvas-node shot-node ${selected ? 'is-selected' : ''}`} data-testid={`shot-node-${record.id}`}>
    <Handle type="target" position={Position.Left} aria-label="镜头输入连接" />
    <header className="node-header"><span className="node-number">{String(index + 1).padStart(2, '0')}</span><span className="node-title">{record.title}</span><Icon name="film" size={15} /></header>
    <div className="shot-media"><Media asset={asset} version={version} controls={Boolean(version)} /><span className="media-corner">{record.aspectRatio} · {record.duration}s</span>{version && <span className={`version-tag ${version.isMock ? 'mock' : ''}`}>V{version.number}{version.isMock ? ' · 模拟' : ''}</span>}{generating && <div className="node-generating"><span className="spinner" />{statusText(job.status)}<span>{Math.round(job.progress || 0)}%</span></div>}</div>
    <div className="node-body"><p>{record.prompt || '写下这个镜头的画面、动作与光线…'}</p><div className="node-meta"><span className={`status-dot ${version ? 'green' : generating ? 'orange' : ''}`} /><span>{generating ? statusText(job.status) : version ? '已选用版本' : '待生成'}</span><span className="spacer" /><span>{record.referenceAssetIds?.length || 0} 张参考</span></div></div>
    <footer className="node-footer"><Button variant="ghost" className="node-link nodrag" onClick={() => onInspect(record.id, 'versions')}><Icon name="layers" size={14} />{data.versionCount || 0} 个版本</Button><Button variant="ghost" className="node-generate nodrag" aria-label={`生成 ${record.title}`} title={data.generationLabel ? `使用 ${data.generationLabel} 生成；参数与右侧设置一致` : '在右侧选择生成服务商'} disabled={generating || data.busy} onClick={() => onGenerate(record)}><Icon name="sparkle" size={13} />生成</Button></footer>
    <Handle type="source" position={Position.Right} aria-label="镜头输出连接" />
  </article>;
});
const AssetNode = memo(function AssetNode({ data, selected }) {
  const { record, asset } = data;
  return <article className={`canvas-node asset-node ${selected ? 'is-selected' : ''}`} data-testid={`asset-node-${record.id}`}>
    <Handle type="target" position={Position.Left} />
    <header className="node-header"><span className="type-icon"><Icon name={record.type === 'video' ? 'film' : record.type === 'audio' ? 'music' : 'image'} size={16} /></span><span className="node-title">{record.label || asset?.name || '参考素材'}</span><span className="tiny-label">{record.type.toUpperCase()}</span></header>
    <div className="asset-node-media"><Media asset={asset} controls={record.type !== 'image'} /></div>
    <footer className="asset-node-footer"><span>参考素材</span><span>{asset?.width && asset?.height ? `${asset.width} × ${asset.height}` : record.type.toUpperCase()}</span></footer>
    <Handle type="source" position={Position.Right} />
  </article>;
});
const TextNode = memo(function TextNode({ data, selected }) {
  return <article className={`canvas-node text-node ${selected ? 'is-selected' : ''}`} data-testid={`text-node-${data.record.id}`}><Handle type="target" position={Position.Left} /><header className="node-header"><span className="type-icon"><Icon name="text" size={16} /></span><span className="node-title">{data.record.label || '创作笔记'}</span><span className="tiny-label">TEXT</span></header><div className="text-node-content">{data.record.text || '一个想法，一段情绪，一条故事线。\n\n选中卡片，在右侧写下你的灵感。'}</div><Handle type="source" position={Position.Right} /></article>;
});
export const nodeTypes = { shot: ShotNode, image: AssetNode, video: AssetNode, audio: AssetNode, text: TextNode };
