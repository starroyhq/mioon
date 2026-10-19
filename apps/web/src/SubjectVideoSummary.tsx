import { useI18n } from './i18n/I18nProvider.tsx';
import React from 'react';
import { assetUrl } from './api.ts';
import { subjectKindDescriptor } from './subject-state.ts';
import { subjectVideoSourceDescriptor } from './subject-video.ts';
import './subject-video-controls.css';

export interface SubjectAssetView {id?: string; projectId?: string; name?: string; sha256?: string}
export interface SubjectVersionView {
  id: string; subjectId: string; assetId: string; projectId: string; sha256: string; number: number;
  width: number; height: number; mimeType: string; provenance?: Record<string, unknown> | null;
}
export interface SubjectReferenceView {subjectName: string; subjectKind: string; subjectVersionId: string; subjectVersion: SubjectVersionView}
export interface LatestSubjectView {id?: string; headVersionId?: string | null; headVersion?: {number: number} | null}
export default function SubjectVideoSummary({ reference, assets = [], latestSubject, compact = false }: {
  reference?: SubjectReferenceView | null; assets?: SubjectAssetView[]; latestSubject?: LatestSubjectView | null; compact?: boolean;
}) {
  const { t, renderMessage } = useI18n();
  if (!reference) return null;
  const version = reference.subjectVersion;
  const asset = assets.find(item => item.id === version?.assetId && item.projectId === version?.projectId && item.sha256 === version?.sha256);
  const newer = latestSubject && latestSubject.id === version.subjectId && latestSubject.headVersionId !== version.id ? latestSubject.headVersion : null;
  return <section className={`subject-video-summary ${compact ? 'compact' : ''}`} data-testid="subject-video-summary" aria-label={t('subjects.summary.label')}>
    <div className="subject-video-preview">{asset ? <img src={assetUrl(asset)} alt={t('subjects.summary.alt', { name: reference.subjectName, number: version.number })} /> : <span className="subject-image-missing">{t('subjects.summary.imageUnavailable')}</span>}<div><strong>{reference.subjectName || t('subjects.summary.nameMissing')}</strong><span>{t('subjects.summary.kindVersion', { kind: renderMessage(subjectKindDescriptor(reference.subjectKind)), number: version?.number ?? t('subjects.summary.pendingNumber') })}</span><span>{renderMessage(subjectVideoSourceDescriptor(version as never))}</span></div></div>
    {newer && <p className="subject-helper" data-testid="subject-video-newer-version">{t('subjects.summary.newer', { number: version.number, latest: newer.number })}</p>}
    <details className="subject-video-identity"><summary>{t('subjects.summary.details')}</summary><dl><dt>{t('subjects.summary.versionId')}</dt><dd>{reference.subjectVersionId}</dd><dt>{t('subjects.summary.assetId')}</dt><dd>{version?.assetId}</dd><dt>SHA-256</dt><dd>{version?.sha256 || t('subjects.summary.hashMissing')}</dd><dt>{t('subjects.summary.image')}</dt><dd>{asset?.name || t('subjects.summary.imageNameMissing')} · {version?.width} × {version?.height} · {version?.mimeType}</dd>{Boolean(version?.provenance) && <><dt>{t('subjects.summary.provenance')}</dt><dd><pre>{JSON.stringify(version.provenance, null, 2)}</pre></dd></>}</dl></details>
  </section>;
}
