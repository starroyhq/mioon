import { translate } from '../../../packages/i18n/src/index.ts';
import type { MessageArguments, MessageKey } from '../../../packages/i18n/src/index.ts';
import { useI18n } from './i18n/I18nProvider.tsx';
import { creationParameter } from './creation-i18n.ts';
import React from 'react';
import type { ReactElement } from 'react';

type Translator = <K extends MessageKey>(key: K, ...args: MessageArguments<K>) => string;
export interface ComfyExecutionView { seed?: unknown; promptId?: unknown; graphHash?: unknown; graph?: unknown; [key: string]: unknown }
export interface ComfyReviewView {
  execution: ComfyExecutionView;
  configuration: { profileId?: unknown; [key: string]: unknown };
  destination?: unknown;
  settingsRevision: number;
  [key: string]: unknown;
}
export interface ComfyRemoteView { state?: unknown; contentVerified?: unknown; errorCode?: string | null; [key: string]: unknown }
export interface ComfyObservationView { state: string; errorCode?: string | null; [key: string]: unknown }
export interface ComfyRemoteStateView { remote?: ComfyRemoteView | null; observation?: ComfyObservationView | null; [key: string]: unknown }
export interface ComfyTaskView { model?: string; [key: string]: unknown }

const observationStatusLabels: Record<string, string> = { queued: 'image.comfy.details.observationQueued', running: 'image.comfy.details.observing', finished: 'image.comfy.details.observationComplete', interrupted: 'image.comfy.details.observationInterrupted' };

/** The exact server-frozen workflow is visible before private UI approval. */
export function ComfyImageReviewDetails({ review }: { review: ComfyReviewView }): ReactElement {
  const { t } = useI18n();
  const execution = review.execution;
  return <div className="image-generation-comfy-details" data-testid="image-comfy-review-details">
    <div className="image-generation-review-details" data-text-selectable><span>{String(review.configuration.profileId)} · ComfyUI v0.39.0</span><span>{t('image.comfy.details.executionParameters', { seed: creationParameter(execution.seed) })}</span><span>{t('image.comfy.details.fixedNodes')}</span><span className="image-generation-id">{t('image.comfy.details.remoteTaskIdentity', { promptId: creationParameter(execution.promptId) })}</span><span className="image-generation-id">{t('image.comfy.details.workflowHash', { graphHash: creationParameter(execution.graphHash) })}</span></div>
    <details><summary>{t('image.comfy.details.frozenWorkflow')}</summary><pre className="image-generation-frozen-graph" data-text-selectable data-testid="image-comfy-review-graph">{JSON.stringify(execution.graph, null, 2)}</pre></details>
    <p className="image-generation-charge" data-text-selectable>{t('image.comfy.details.approvalDisclosure')}</p>
  </div>;
}

export function ComfyImageTaskDetails({ task, review, remoteState }: { task: ComfyTaskView; review?: ComfyReviewView | null; remoteState?: ComfyRemoteStateView | null }): ReactElement {
  const { t } = useI18n();
  const observationState = remoteState?.observation?.state;
  const observationLabel = typeof observationState === 'string' && Object.hasOwn(observationStatusLabels, observationState) ? t(observationStatusLabels[observationState] as MessageKey) : undefined;
  return <div className="image-generation-comfy-details" data-testid="image-comfy-task-details">
    <div className="image-generation-review-details" data-text-selectable><span>{task.model}</span>{review ? <><span>{review.destination as string}</span><span>{t('image.comfy.details.originalConfiguration', { settingsRevision: creationParameter(review.settingsRevision), profileId: creationParameter(review.configuration.profileId) })}</span><span className="image-generation-id">{t('image.comfy.details.remoteTaskIdentity', { promptId: creationParameter(review.execution.promptId) })}</span><span className="image-generation-id">{t('image.comfy.details.frozenWorkflowHash', { graphHash: creationParameter(review.execution.graphHash) })}</span></> : <span>{t('image.comfy.details.originalReviewNotLoaded')}</span>}</div>
    <p data-text-selectable>{t('image.comfy.details.remoteIdentityStatus', { value: creationParameter(remoteStatusLabel(remoteState?.remote, t)) })}</p>
    <p data-text-selectable data-testid="image-comfy-graph-status">{t('image.comfy.details.completeWorkflowStatus', { value: creationParameter(remoteState?.remote?.contentVerified === true ? t('image.comfy.details.workflowVerified') : t('image.comfy.details.workflowUnverified')) })}</p>
    {remoteState?.observation && <p data-text-selectable data-testid="image-comfy-observation-status">{observationLabel ?? ''}{remoteState.observation.errorCode ? t('image.comfy.details.noVerifiableResult') : ''}</p>}
    <p data-text-selectable>{t('image.comfy.details.observationScope')}</p>
  </div>;
}

const remoteStatusBuilders: Record<string, (t: Translator) => string> = {
  prepared: t => t('image.comfy.details.identitySaved'),
  submitted: t => t('image.comfy.details.dispatchBoundary'),
  submission_unknown: t => t('image.comfy.details.dispatchUnknown'),
  queued: t => t('image.comfy.details.sameTaskQueued'),
  running: t => t('image.comfy.details.sameTaskRunning'),
  completed: t => t('image.comfy.details.completedTaskFound'),
  failed: t => t('image.comfy.details.failedTaskFound'),
  unavailable: t => t('image.comfy.details.noEvidence'),
};
export function remoteStatusLabel(remote: { state?: unknown } | null | undefined, t: Translator = (key, ...args) => translate('zh-Hans', key, ...args)): string {
  const state = remote?.state;
  return typeof state === 'string' && Object.hasOwn(remoteStatusBuilders, state) ? remoteStatusBuilders[state](t) : t('image.comfy.details.unverified');
}
