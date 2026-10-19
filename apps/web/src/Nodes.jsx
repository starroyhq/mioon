import { statusDescriptor, providerDisplayName } from './creation-i18n.ts';
import { useI18n } from './i18n/I18nProvider.tsx';
import { Button } from '@mioon/ui/components/button';
import React, { memo, useLayoutEffect, useRef } from 'react';
import { Handle, Position } from '@xyflow/react';
import Icon from './icons.jsx';
import { activeJob, assetUrl, versionUrl } from './api.js';
import { REFERENCE_SOURCE_HANDLE, REFERENCE_TARGET_HANDLE, VISUAL_SOURCE_HANDLE, VISUAL_TARGET_HANDLE } from './reference-connections.js';
import { useWorkspaceVisibility } from './workspace-visibility.jsx';
import CompactNodePlayer from './CompactNodePlayer.tsx';
import './board-redesign.css';

export function disposeMedia(element) {
  if (!element) return;
  element.pause();
  element.removeAttribute('src');
  // Release the decoder and cancel pending loads when a workspace leaves the DOM.
  element.load();
}

export function Media({ asset, version, className = '', controls = false, ...props }) {
  const { t, renderMessage, formatDate, formatNumber } = useI18n();
  const media = useRef(null);
  const visible = useWorkspaceVisibility();
  const visibleRef = useRef(visible);
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
  useLayoutEffect(() => {
    visibleRef.current = visible;
    // Hiding is not disposal: retain src and the exact playback position.
    if (!visible) media.current?.pause();
  }, [visible, sourceKey]);
  function guardPlayback(event, callback) {
    const element = event.currentTarget;
    // A queued play/playing event may arrive after a panel was collapsed.
    if (!visibleRef.current || element !== media.current || !element.isConnected) {
      element.pause();
      return;
    }
    callback?.(event);
  }
  const playbackProps = {
    ...props,
    onPlay: event => guardPlayback(event, props.onPlay),
    onPlaying: event => guardPlayback(event, props.onPlaying),
    onTimeUpdate: event => guardPlayback(event, props.onTimeUpdate),
  };
  if (!url) return <div className={`media-placeholder ${className}`}><Icon name="film" size={32} /><span>{t('assets.waitFirstVisual')}</span></div>;
  if (audio) return <div className={`media-audio ${className}`}><Icon name="music" size={28} />{controls ? <audio ref={media} key={sourceKey} className="nodrag nowheel" src={url} controls preload="metadata" {...playbackProps} /> : <span>{t('assets.audioAsset')}</span>}</div>;
  return video ? <video ref={media} key={sourceKey} className={`media-content ${className} ${controls ? 'nodrag nowheel' : ''}`} src={url} controls={controls} muted playsInline preload="metadata" {...playbackProps} /> : <img className={`media-content ${className}`} src={url} alt={asset?.name || t('assets.shotReference')} loading="lazy" {...props} />;
}
const ShotNode = memo(function ShotNode({ data, selected }) {
  const { t, renderMessage, formatDate, formatNumber } = useI18n();
  const { record, asset, version, job, index, onInspect, onGenerate } = data;
  const generating = !data.generationUnavailableReason && job && activeJob(job);
  return <article className={`canvas-node shot-node ${selected ? 'is-selected' : ''}`} data-testid={`shot-node-${record.id}`}>
    <Handle id={VISUAL_TARGET_HANDLE} type="target" position={Position.Left} aria-label={t('shell.node.shotVisualInput')} title={t('shell.node.visualOnly')} />
    <Handle id={REFERENCE_TARGET_HANDLE} type="target" position={Position.Left} className="reference-handle" style={{ top: 66 }} aria-label={t('shell.node.referenceInput')} title={t('shell.node.referenceInputHint')} isConnectable={!data.referenceBusy && !data.referenceConnection && !record.referenceAssetIds?.length} />
    <span className="reference-port-label target-label">{t('shell.node.firstFrameInput')}</span>
    <header className="node-header"><span className="node-number">{String(index + 1).padStart(2, '0')}</span><span className="node-title" title={record.title}>{record.title}</span><span className={`node-status-badge ${generating ? 'running' : job?.status === 'failed' ? 'failed' : version ? 'complete' : ''}`}>{generating ? renderMessage(statusDescriptor(job.status)) : job?.status === 'failed' ? t('redesign.board.failed') : version ? t('redesign.board.completed') : t('redesign.board.waiting')}</span></header>
    <div className="shot-media">{version ? <CompactNodePlayer sourceKey={version.id} renderMedia={events => <Media asset={asset} version={version} {...events} />} /> : <Media asset={asset} version={version} />}{generating && <div className="node-generating"><span className="spinner" /><span>{Math.round(Math.max(0, Math.min(100, Number(job.progress) || 0)))}% · {renderMessage(statusDescriptor(job.status))}</span><div className="node-progress" role="progressbar" aria-label={renderMessage(statusDescriptor(job.status))} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.max(0, Math.min(100, Number(job.progress) || 0))}><span style={{ width: `${Math.max(0, Math.min(100, Number(job.progress) || 0))}%` }} /></div></div>}</div>
    <div className="node-body"><p>{record.prompt || t('shell.node.promptPlaceholder')}</p><div className="node-meta"><span className={`status-dot ${version ? 'green' : generating ? 'orange' : ''}`} /><span>{generating ? renderMessage(statusDescriptor(job.status)) : version ? t('shell.node.versionSelected') : t('shell.node.awaitingGeneration')}</span><span className="spacer" /><span>{t('shell.node.referenceCount', { count: record.referenceAssetIds?.length || 0 })}</span></div></div>
    {data.referenceConnection && <Button variant="ghost" className="node-bound-reference nodrag" onClick={() => onInspect(record.id, 'settings')} title={renderMessage(data.referenceSourceLabel)}><Icon name="link" size={12} /><span>{t('shell.node.firstFrameSource', { name: renderMessage(data.referenceSourceLabel) })}</span></Button>}
    <footer className="node-footer"><span className="node-output-spec">{version?.snapshot?.aspectRatio || record.aspectRatio} · {version?.snapshot?.duration || record.duration}s</span><Button variant="ghost" className="node-link nodrag" onClick={() => onInspect(record.id, 'versions')}><Icon name="layers" size={13} />{t('shell.node.versionCount', { count: data.versionCount || 0 })}</Button><Button variant="ghost" className="node-generate nodrag" aria-label={t('shell.node.generateNamed', { name: record.title })} title={renderMessage(data.generationUnavailableReason) || (data.generationProvider ? t('shell.node.generateProvider', { provider: providerDisplayName(data.generationProvider, t) }) : t('shell.node.chooseProvider'))} disabled={Boolean(data.generationUnavailableReason) || generating || data.busy || data.referenceBusy} onClick={() => onGenerate(record)}><Icon name="sparkle" size={13} /><span className="sr-only">{t('shell.generate')}</span></Button></footer>
    <Handle id={VISUAL_SOURCE_HANDLE} type="source" position={Position.Right} aria-label={t('shell.node.shotVisualOutput')} title={t('shell.node.visualOnly')} />
  </article>;
});
const AssetNode = memo(function AssetNode({ data, selected }) {
  const { t, renderMessage, formatDate, formatNumber } = useI18n();
  const { record, asset } = data;
  return <article className={`canvas-node asset-node ${selected ? 'is-selected' : ''}`} data-testid={`asset-node-${record.id}`}>
    <Handle id={VISUAL_TARGET_HANDLE} type="target" position={Position.Left} aria-label={t('shell.node.assetVisualInput')} title={t('shell.node.visualOnly')} />
    <header className="node-header"><span className="type-icon"><Icon name={record.type === 'video' ? 'film' : record.type === 'audio' ? 'music' : 'image'} size={16} /></span><span className="node-title">{record.label || asset?.name || t('assets.reference')}</span><span className="tiny-label">{t(record.type === 'video' ? 'assets.video' : record.type === 'audio' ? 'assets.audio' : 'assets.image')}</span></header>
    <div className="asset-node-media"><Media asset={asset} controls={record.type !== 'image'} /></div>
    <footer className="asset-node-footer"><span>{t('assets.reference')}</span><span>{asset?.width && asset?.height ? `${asset.width} × ${asset.height}` : t(record.type === 'video' ? 'assets.video' : record.type === 'audio' ? 'assets.audio' : 'assets.image')}</span></footer>
    {data.canReference && <><Button variant="ghost" className="node-reference-action nodrag" data-testid={`connect-reference-${record.id}`} onClick={() => data.onInspect(record.id)}><Icon name="link" size={13} />{t('shell.node.connectReference')}<Icon name="arrow" size={12} /></Button><Handle id={REFERENCE_SOURCE_HANDLE} type="source" position={Position.Right} className="reference-handle" style={{ top: 66 }} aria-label={t('shell.node.referenceOutput')} title={t('shell.node.referenceOutputHint')} isConnectable={!data.referenceBusy} /><span className="reference-port-label source-label">{t('shell.node.firstFrameOutput')}</span></>}
    <Handle id={VISUAL_SOURCE_HANDLE} type="source" position={Position.Right} aria-label={t('shell.node.assetVisualOutput')} title={t('shell.node.visualOnly')} />
  </article>;
});
const TextNode = memo(function TextNode({ data, selected }) {
  const { t, renderMessage, formatDate, formatNumber } = useI18n();
  return <article className={`canvas-node text-node ${selected ? 'is-selected' : ''}`} data-testid={`text-node-${data.record.id}`}><Handle id={VISUAL_TARGET_HANDLE} type="target" position={Position.Left} aria-label={t('shell.node.noteVisualInput')} title={t('shell.node.visualOnly')} /><header className="node-header"><span className="type-icon"><Icon name="text" size={16} /></span><span className="node-title">{data.record.label || t('projects.default.note')}</span><span className="tiny-label">{t('shell.node.textType')}</span></header><div className="text-node-content">{data.record.text || t('shell.node.notePlaceholder')}</div><Handle id={VISUAL_SOURCE_HANDLE} type="source" position={Position.Right} aria-label={t('shell.node.noteVisualOutput')} title={t('shell.node.visualOnly')} /></article>;
});
export const nodeTypes = { shot: ShotNode, image: AssetNode, video: AssetNode, audio: AssetNode, text: TextNode };
