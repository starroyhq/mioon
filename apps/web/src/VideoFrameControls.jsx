import React from 'react';
import { Button } from '@mioon/ui/components/button';
import Icon from './icons.jsx';
import { assetUrl } from './api.js';
import { generationReferencePreview } from './generation-settings.js';
import './video-frame-controls.css';

const roleLabel = role => ({ first_frame: '首帧参考图', last_frame: '尾帧参考图' }[role] || `参考角色：${role}`);

// Display the complete manifest, including unresolved historical identities.
// A job's frozen manifest is never expanded from the current shot selection.
export function VideoFrameSummary({ shot, assets = [], frozen = false, compact = false }) {
  const references = generationReferencePreview(shot || {}, assets, { frozen });
  if (!references.length) return <p className="input-hint" data-testid="video-frame-summary-empty">未选择首帧或尾帧参考图。</p>;
  return <div className={`video-frame-summary ${compact ? 'compact' : ''}`} data-testid="video-frame-summary" aria-label="完整生成参考图">
    {references.map((reference, index) => <div className="video-frame-summary-item" key={`${reference.role}:${reference.assetId}:${index}`} data-testid={`video-frame-summary-${reference.role}`}>
      {reference.asset ? <img src={assetUrl(reference.asset)} alt={`${roleLabel(reference.role)}：${reference.name || '未命名图片'}`} /> : <span className="video-frame-thumbnail-missing">原图暂不可用</span>}
      <div><strong>{roleLabel(reference.role)}</strong><span className="video-frame-name">{reference.name || '未命名素材'}</span>
        <details className="video-frame-identity"><summary>素材标识与校验值</summary><dl><dt>素材 ID</dt><dd>{reference.assetId}</dd><dt>SHA-256</dt><dd>{reference.sha256 || '未提供校验值'}</dd></dl></details>
      </div>
    </div>)}
  </div>;
}

export default function VideoFrameControls({ draft, assets, disabled, onChoose, onClear }) {
  const selected = assets.find(asset => asset.id === draft.lastFrameAssetId);
  return <section className="video-last-frame" aria-label="尾帧参考图" data-testid="video-last-frame-controls">
    <div className="field-label"><span>尾帧参考图</span><span className="optional">可选 · 已选 {draft.lastFrameAssetId ? 1 : 0}</span></div>
    <p className="input-hint">首尾帧组合仅接入 Ark 与 Mock。须同时有一张首帧；同一素材不能兼作首尾帧（当前应用限制）。更换服务商不会清除已保存的尾帧。</p>
    <div className="reference-grid">{assets.map(asset => <Button variant="ghost" size="sm" key={asset.id} title={asset.name} className={`reference-choice ${draft.lastFrameAssetId === asset.id ? 'selected' : ''}`} data-testid={`last-frame-choice-${asset.id}`} aria-label={`尾帧参考图 ${asset.name}`} aria-pressed={draft.lastFrameAssetId === asset.id} disabled={disabled} onClick={() => onChoose(asset.id)}><img src={assetUrl(asset)} alt={asset.name} />{draft.lastFrameAssetId === asset.id && <span><Icon name="check" size={11} /></span>}</Button>)}</div>
    {!assets.length && <p className="reference-empty">先在左侧导入一张图片作为尾帧。</p>}
    {draft.lastFrameAssetId && <><p className="input-hint" data-testid="selected-last-frame-label">已选尾帧：{selected?.name || '素材不存在，请重新选择'}</p><Button variant="ghost" size="sm" className="text-button" data-testid="clear-last-frame" disabled={disabled} onClick={onClear}>清除尾帧参考图</Button></>}
  </section>;
}
