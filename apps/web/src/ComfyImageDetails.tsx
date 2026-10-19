import { translate } from '../../../packages/i18n/src/index.ts';
import { useI18n } from './i18n/I18nProvider.tsx';
import { creationParameter } from './creation-i18n.ts';
import React from 'react';

/** The exact server-frozen workflow is visible before private UI approval. */
export function ComfyImageReviewDetails({ review }) {
  const { t, renderMessage, formatDate, formatNumber } = useI18n();
  const execution = review.execution;
  return <div className="image-generation-comfy-details" data-testid="image-comfy-review-details">
    <div className="image-generation-review-details"><span>{review.configuration.profileId} · ComfyUI v0.39.0</span><span>{t('image.comfy.details.executionParameters', { seed: creationParameter(execution.seed) })}</span><span>{t('image.comfy.details.fixedNodes')}</span><span className="image-generation-id">{t('image.comfy.details.remoteTaskIdentity', { promptId: creationParameter(execution.promptId) })}</span><span className="image-generation-id">{t('image.comfy.details.workflowHash', { graphHash: creationParameter(execution.graphHash) })}</span></div>
    <details><summary>{t('image.comfy.details.frozenWorkflow')}</summary><pre className="image-generation-frozen-graph" data-testid="image-comfy-review-graph">{JSON.stringify(execution.graph, null, 2)}</pre></details>
    <p className="image-generation-charge">{t('image.comfy.details.approvalDisclosure')}</p>
  </div>;
}

export function ComfyImageTaskDetails({ task, review, remoteState }) {
  const { t, renderMessage, formatDate, formatNumber } = useI18n();
  return <div className="image-generation-comfy-details" data-testid="image-comfy-task-details">
    <div className="image-generation-review-details"><span>{task.model}</span>{review ? <><span>{review.destination}</span><span>{t('image.comfy.details.originalConfiguration', { settingsRevision: creationParameter(review.settingsRevision), profileId: creationParameter(review.configuration.profileId) })}</span><span className="image-generation-id">{t('image.comfy.details.remoteTaskIdentity', { promptId: creationParameter(review.execution.promptId) })}</span><span className="image-generation-id">{t('image.comfy.details.frozenWorkflowHash', { graphHash: creationParameter(review.execution.graphHash) })}</span></> : <span>{t('image.comfy.details.originalReviewNotLoaded')}</span>}</div>
    <p>{t('image.comfy.details.remoteIdentityStatus', { value: creationParameter(remoteStatusLabel(remoteState?.remote, t)) })}</p>
    <p data-testid="image-comfy-graph-status">{t('image.comfy.details.completeWorkflowStatus', { value: creationParameter(remoteState?.remote?.contentVerified === true ? t('image.comfy.details.workflowVerified') : t('image.comfy.details.workflowUnverified')) })}</p>
    {remoteState?.observation && <p data-testid="image-comfy-observation-status">{{ queued: t('image.comfy.details.observationQueued'), running: t('image.comfy.details.observing'), finished: t('image.comfy.details.observationComplete'), interrupted: t('image.comfy.details.observationInterrupted') }[remoteState.observation.state]}{remoteState.observation.errorCode ? t('image.comfy.details.noVerifiableResult') : ''}</p>}
    <p>{t('image.comfy.details.observationScope')}</p>
  </div>;
}

export function remoteStatusLabel(remote, t = (key, params) => translate('zh-Hans', key, params)) {
  return ({ prepared: t('image.comfy.details.identitySaved'), submitted: t('image.comfy.details.dispatchBoundary'), submission_unknown: t('image.comfy.details.dispatchUnknown'), queued: t('image.comfy.details.sameTaskQueued'), running: t('image.comfy.details.sameTaskRunning'), completed: t('image.comfy.details.completedTaskFound'), failed: t('image.comfy.details.failedTaskFound'), unavailable: t('image.comfy.details.noEvidence') }[remote?.state] || t('image.comfy.details.unverified'));
}
