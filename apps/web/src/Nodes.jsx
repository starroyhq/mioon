import { Button } from '@video-workbench/ui/components/button';
import React, { memo, useLayoutEffect, useRef } from 'react';
import { Handle, Position } from '@xyflow/react';
import Icon from './icons.jsx';
import { activeJob, assetUrl, statusText, versionUrl } from './api.js';
import { REFERENCE_SOURCE_HANDLE, REFERENCE_TARGET_HANDLE, VISUAL_SOURCE_HANDLE, VISUAL_TARGET_HANDLE } from './reference-connections.js';

export function disposeMedia(element) {
  if (!element) return;
  element.pause();
  element.removeAttribute('src');
  // Release the decoder and cancel pending loads when a workspace leaves the DOM.
  element.load();
}

export function Media({ asset, version, className = '', controls = false, ...props }) {
  const media = useRef(null);
  const url = version ? versionUrl(version) : assetUrl(asset);
  const video = Boolean(version || asset?.mimeType?.startsWith('video/'));
  const audio = asset?.mimeType?.startsWith('audio/');
  const sourceKey = `${version?.id || asset?.id || ''}:${url}:${audio ? 'audio' : 'video'}:${controls}`;
  useLayoutEffect(() => {
    const element = media.current;
    if (!element) return;
    // React Strict Mode replays effects without recreating the media element.
    if (element.getAttribute('src') !== url) element.setAttribute('src', url);
    return () => disposeMedia(element);
  }, [sourceKey]);
  if (!url) return <div className={`media-placeholder ${className}`}><Icon name="film" size={32} /><span>等待你的第一个画面</span></div>;
  if (audio) return <div className={`media-audio ${className}`}><Icon name="music" size={28} />{controls ? <audio ref={media} key={sourceKey} className="nodrag nowheel" src={url} controls preload="metadata" {...props} /> : <span>音频素材</span>}</div>;
  return video ? <video ref={media} key={sourceKey} className={`media-content ${className} ${controls ? 'nodrag nowheel' : ''}`} src={url} controls={controls} muted playsInline preload="metadata" {...props} /> : <img className={`media-content ${className}`} src={url} alt={asset?.name || '镜头参考图'} loading="lazy" {...props} />;
}
const ShotNode = memo(function ShotNode({ data, selected }) {
  const { record, asset, version, job, index, onInspect, onGenerate } = data;
  const generating = job && activeJob(job);
  return <article className={`canvas-node shot-node ${selected ? 'is-selected' : ''}`} data-testid={`shot-node-${record.id}`}>
    <Handle id={VISUAL_TARGET_HANDLE} type="target" position={Position.Left} aria-label="镜头视觉连线输入，不参与生成" title="视觉连线 · 不参与生成" />
    <Handle id={REFERENCE_TARGET_HANDLE} type="target" position={Position.Left} className="reference-handle" style={{ top: 66 }} aria-label="首帧参考输入" title="将图片的首帧输出连接到这里" isConnectable={!data.referenceBusy && !data.referenceConnection && !record.referenceAssetIds?.length} />
    <span className="reference-port-label target-label">首帧输入</span>
    <header className="node-header"><span className="node-number">{String(index + 1).padStart(2, '0')}</span><span className="node-title">{record.title}</span><Icon name="film" size={15} /></header>
    <div className="shot-media"><Media asset={asset} version={version} controls={Boolean(version)} /><span className="media-corner">{record.aspectRatio} · {record.duration}s</span>{version && <span className={`version-tag ${version.isMock ? 'mock' : ''}`}>V{version.number}{version.isMock ? ' · 模拟' : ''}</span>}{generating && <div className="node-generating"><span className="spinner" />{statusText(job.status)}<span>{Math.round(job.progress || 0)}%</span></div>}</div>
    <div className="node-body"><p>{record.prompt || '写下这个镜头的画面、动作与光线…'}</p><div className="node-meta"><span className={`status-dot ${version ? 'green' : generating ? 'orange' : ''}`} /><span>{generating ? statusText(job.status) : version ? '已选用版本' : '待生成'}</span><span className="spacer" /><span>{record.referenceAssetIds?.length || 0} 张参考</span></div></div>
    {data.referenceConnection && <Button variant="ghost" className="node-bound-reference nodrag" onClick={() => onInspect(record.id, 'settings')} title={data.referenceSourceLabel}><Icon name="link" size={12} /><span>首帧 · {data.referenceSourceLabel}</span></Button>}
    <footer className="node-footer"><Button variant="ghost" className="node-link nodrag" onClick={() => onInspect(record.id, 'versions')}><Icon name="layers" size={14} />{data.versionCount || 0} 个版本</Button><Button variant="ghost" className="node-generate nodrag" aria-label={`生成 ${record.title}`} title={data.generationLabel ? `使用 ${data.generationLabel} 生成；参数与右侧设置一致` : '在右侧选择生成服务商'} disabled={generating || data.busy || data.referenceBusy} onClick={() => onGenerate(record)}><Icon name="sparkle" size={13} />生成</Button></footer>
    <Handle id={VISUAL_SOURCE_HANDLE} type="source" position={Position.Right} aria-label="镜头视觉连线输出，不参与生成" title="视觉连线 · 不参与生成" />
  </article>;
});
const AssetNode = memo(function AssetNode({ data, selected }) {
  const { record, asset } = data;
  return <article className={`canvas-node asset-node ${selected ? 'is-selected' : ''}`} data-testid={`asset-node-${record.id}`}>
    <Handle id={VISUAL_TARGET_HANDLE} type="target" position={Position.Left} aria-label="素材视觉连线输入，不参与生成" title="视觉连线 · 不参与生成" />
    <header className="node-header"><span className="type-icon"><Icon name={record.type === 'video' ? 'film' : record.type === 'audio' ? 'music' : 'image'} size={16} /></span><span className="node-title">{record.label || asset?.name || '参考素材'}</span><span className="tiny-label">{record.type.toUpperCase()}</span></header>
    <div className="asset-node-media"><Media asset={asset} controls={record.type !== 'image'} /></div>
    <footer className="asset-node-footer"><span>参考素材</span><span>{asset?.width && asset?.height ? `${asset.width} × ${asset.height}` : record.type.toUpperCase()}</span></footer>
    {data.canReference && <><Button variant="ghost" className="node-reference-action nodrag" data-testid={`connect-reference-${record.id}`} onClick={() => data.onInspect(record.id)}><Icon name="link" size={13} />连接首帧到镜头<Icon name="arrow" size={12} /></Button><Handle id={REFERENCE_SOURCE_HANDLE} type="source" position={Position.Right} className="reference-handle" style={{ top: 66 }} aria-label="首帧参考输出" title="连接到镜头的首帧输入，作为生成参考图" isConnectable={!data.referenceBusy} /><span className="reference-port-label source-label">首帧输出</span></>}
    <Handle id={VISUAL_SOURCE_HANDLE} type="source" position={Position.Right} aria-label="素材视觉连线输出，不参与生成" title="视觉连线 · 不参与生成" />
  </article>;
});
const TextNode = memo(function TextNode({ data, selected }) {
  return <article className={`canvas-node text-node ${selected ? 'is-selected' : ''}`} data-testid={`text-node-${data.record.id}`}><Handle id={VISUAL_TARGET_HANDLE} type="target" position={Position.Left} aria-label="笔记视觉连线输入，不参与生成" title="视觉连线 · 不参与生成" /><header className="node-header"><span className="type-icon"><Icon name="text" size={16} /></span><span className="node-title">{data.record.label || '创作笔记'}</span><span className="tiny-label">TEXT</span></header><div className="text-node-content">{data.record.text || '一个想法，一段情绪，一条故事线。\n\n选中卡片，在右侧写下你的灵感。'}</div><Handle id={VISUAL_SOURCE_HANDLE} type="source" position={Position.Right} aria-label="笔记视觉连线输出，不参与生成" title="视觉连线 · 不参与生成" /></article>;
});
export const nodeTypes = { shot: ShotNode, image: AssetNode, video: AssetNode, audio: AssetNode, text: TextNode };
