import React from 'react';
import { assetUrl } from './api.js';
import { subjectKindLabel } from './subject-state.js';
import { subjectVideoSourceLabel } from './subject-video.js';
import './subject-video-controls.css';

export default function SubjectVideoSummary({ reference, assets = [], latestSubject, compact = false }) {
  if (!reference) return null;
  const version = reference.subjectVersion;
  const asset = assets.find(item => item.id === version?.assetId && item.projectId === version?.projectId && item.sha256 === version?.sha256);
  const newer = latestSubject?.id === version?.subjectId && latestSubject.headVersionId !== version?.id ? latestSubject.headVersion : null;
  return <section className={`subject-video-summary ${compact ? 'compact' : ''}`} data-testid="subject-video-summary" aria-label="本次生成的固定主体图片">
    <div className="subject-video-preview">{asset ? <img src={assetUrl(asset)} alt={`${reference.subjectName} 固定 V${version.number}`} /> : <span className="subject-image-missing">固定版本原图暂不可用</span>}<div><strong>{reference.subjectName || '主体名称未提供'}</strong><span>{subjectKindLabel(reference.subjectKind)} · 固定 V{version?.number ?? '待核对'}</span><span>{subjectVideoSourceLabel(version)}</span></div></div>
    {newer && <p className="subject-helper" data-testid="subject-video-newer-version">本次仍固定 V{version.number}；主体库当前为 V{newer.number}。需要换图时请明确选择新版本。</p>}
    <details className="subject-video-identity"><summary>固定版本、素材与来源详情</summary><dl><dt>主体版本 ID</dt><dd>{reference.subjectVersionId}</dd><dt>素材 ID</dt><dd>{version?.assetId}</dd><dt>SHA-256</dt><dd>{version?.sha256 || '未提供校验值'}</dd><dt>图片</dt><dd>{asset?.name || '名称未加载'} · {version?.width} × {version?.height} · {version?.mimeType}</dd>{version?.provenance && <><dt>完整来源记录</dt><dd><pre>{JSON.stringify(version.provenance, null, 2)}</pre></dd></>}</dl></details>
  </section>;
}
