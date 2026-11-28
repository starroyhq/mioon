/** GE-b: the editing-side generation panel for one format-5 shot created from
 * the timeline. It reuses the RI-b read-only generation-input projection: the
 * panel shows the inputs, it never edits reference lines (those stay on board). */
import React, {useEffect, useState} from 'react';
import {Button} from '@mioon/ui/components/button';
import {Textarea} from '@mioon/ui/components/textarea';
import {ArrowUpRight} from '@mioon/ui/components/workbench-icons';
import {WorkbenchSelect} from '../WorkspaceControls.tsx';
import Icon from '../icons.tsx';
import ShotDialogue from '../ShotDialogue.tsx';
import {useI18n} from '../i18n/I18nProvider.tsx';
import {generationModeKeys, referenceRoleKey, unsupportedReasonKey} from '../board-ui/inputs.ts';
import {canRetryGenerationFailure, formatBoardGenerationFailure, jobServiceDisplayName, providerDisplayName} from '../creation-i18n.ts';
import {resolveBoardGenerationSelection} from '../generation-service-choices.ts';
import type {GenerationProvider} from '../generation-settings.ts';
import GenerationServiceMenu from '../board-ui/GenerationServiceMenu.tsx';
import type {SequenceGenerationInputView} from '../../../../packages/contracts/src/sequence-inspection.ts';
import type {MessageKey} from '../../../../packages/i18n/src/index.ts';
import './generate-in-editing-panel.css';

type Row = Record<string, unknown>;
export interface GenerateInEditingPanelProps {
  readonly shot: Row;
  readonly shotLabel?: string;
  readonly inputs: SequenceGenerationInputView | null;
  readonly subjectNames: Record<string, string>;
  readonly cueCount: number;
  readonly job?: Row | null;
  readonly jobs?: readonly Row[];
  readonly versions?: readonly Row[];
  readonly busy: boolean;
  readonly generateBlocked?: boolean;
  readonly resizable?: boolean;
  readonly onSavePrompt: (prompt: string) => unknown;
  readonly onCancelJob?: (job: Row) => unknown;
  readonly onRetryJob?: (job: Row) => unknown;
  readonly onOpenTaskCenter?: (jobId: string) => unknown;
  readonly onResize: (duration: number) => unknown;
  readonly providers: readonly GenerationProvider[];
  readonly generationOptions: Readonly<Record<string, unknown>>;
  readonly onGenerationOptionsChange: (options: Record<string, unknown>) => unknown;
  readonly onOpenGenerationSettings?: (() => void) | undefined;
  readonly onGenerate: () => unknown;
  readonly onRevealOnBoard: () => unknown;
  readonly rpc: (operation: string, input: unknown) => Promise<unknown>;
  readonly onDialogueApplied: () => unknown;
}
const roleLabel = (role: string, t: ReturnType<typeof useI18n>['t']): string =>
  t(referenceRoleKey(role as never) as MessageKey);

export default function GenerateInEditingPanel(props: GenerateInEditingPanelProps): React.ReactElement {
  const {t, renderMessage} = useI18n();
  const {shot, inputs} = props;
  const [draft, setDraft] = useState(String(shot.prompt ?? ''));
  const [duration, setDuration] = useState(Number(shot.duration) || 4);
  const [jobAction, setJobAction] = useState<string | null>(null);
  const [serviceMenu, setServiceMenu] = useState(false);
  useEffect(() => {setDraft(String(shot.prompt ?? '')); setDuration(Number(shot.duration) || 4);},
    [shot.id, shot.revision]);
  const dirty = draft !== String(shot.prompt ?? '');
  const entries = inputs?.entries ?? [];
  const latestJob = props.job ?? null;
  const activeJob = latestJob && ['queued', 'submitting', 'running', 'downloading'].includes(String(latestJob.status)) ? latestJob : null;
  const failedJob = latestJob?.status === 'failed' ? latestJob : null;
  const unknownJob = latestJob?.status === 'submission_unknown' ? latestJob : null;
  const jobServiceName = latestJob ? jobServiceDisplayName(latestJob, t, props.providers) : '';
  const historyJobs = props.jobs ?? (latestJob ? [latestJob] : []);
  const selection = resolveBoardGenerationSelection(
    props.providers,
    props.generationOptions as Parameters<typeof resolveBoardGenerationSelection>[1],
    shot as never,
    {shotId: String(shot.id ?? ''), jobs: historyJobs, versions: props.versions},
  );
  const selectedProvider = selection.provider;
  const serviceLabel = selectedProvider ? providerDisplayName(selectedProvider, t) : '';
  const serviceChoice = (provider: GenerationProvider, model?: Record<string, unknown>): Record<string, unknown> => ({
    providerId: provider.id,
    ...(provider.connectionId ? {connectionId: provider.connectionId,
      configurationRevision: provider.configurationRevision} : {}),
    ...(model ? {model: String(model.modelId ?? model.id ?? ''),
      modelEntryId: String(model.modelEntryId ?? model.id ?? '')} : {})});
  const cancelJob = async (job: Row): Promise<void> => {
    if (!props.onCancelJob || jobAction !== null) return;
    setJobAction(`cancel:${String(job.id)}`);
    try { await props.onCancelJob(job); } finally { setJobAction(null); }
  };
  const retryJob = async (job: Row): Promise<void> => {
    if (!props.onRetryJob || jobAction !== null) return;
    setJobAction(`retry:${String(job.id)}`);
    try { await props.onRetryJob(job); } finally { setJobAction(null); }
  };
  return <div className="generate-in-editing-panel" data-testid="editing-generate-panel">
    <header className="generate-in-editing-heading">
      <strong data-testid="editing-generate-shot-title">{props.shotLabel ? `${props.shotLabel} · ` : ''}{String(shot.title ?? '')}</strong>
      <Button type="button" variant="ghost" size="sm" className="text-button" data-testid="editing-generate-reveal"
        onClick={() => props.onRevealOnBoard()}><Icon name="board" size={13} /><span>{t('editUi.shot.reveal')}</span><ArrowUpRight size={13} aria-hidden="true" /></Button>
    </header>
    <section className="generate-in-editing-field">
      <label htmlFor="editing-generate-prompt">{t('boardUi.inspector.description')}</label>
      <Textarea id="editing-generate-prompt" data-testid="editing-generate-prompt" rows={4} maxLength={5000}
        value={draft} disabled={props.busy} onChange={event => setDraft(event.target.value)}
        placeholder={t('boardUi.inspector.descriptionPlaceholder')} />
      {dirty && <div className="generate-in-editing-save"><Button type="button" size="sm" data-testid="editing-generate-save"
        disabled={props.busy} onClick={() => void props.onSavePrompt(draft)}>{t('boardUi.inspector.saveShot')}</Button></div>}
    </section>
    <section className="generate-in-editing-inputs" data-testid="editing-generate-inputs">
      <h4>{t('boardUi.inputs.title')}</h4>
      {inputs ? <>
        {entries.length === 0
          ? <p className="generate-in-editing-empty" data-testid="editing-generate-inputs-empty">{t('boardUi.inputs.empty')}</p>
          : <ul className="generate-in-editing-input-list">{entries.map(entry => <li key={`${entry.source}:${entry.edgeId ?? entry.bindingId ?? entry.role}`}
              data-testid={`editing-generate-input-${entry.role}`} data-status={entry.status}>
              <span className="generate-in-editing-role">{roleLabel(entry.role, t)}</span>
              <span className="generate-in-editing-label">{entry.label}
                {entry.primary && <span className="generate-in-editing-primary">{t('boardUi.inputs.primary')}</span>}</span>
              {entry.status === 'unsupported' && <span className="generate-in-editing-unsupported">
                {renderMessage(unsupportedReasonKey(entry.reason) as never)}</span>}
            </li>)}</ul>}
        <div className="generate-in-editing-duration">
          <label htmlFor="editing-generate-duration">{t('boardUi.inspector.duration')}</label>
          <WorkbenchSelect id="editing-generate-duration" data-testid="editing-generate-duration"
            value={String(duration)} disabled={props.busy || props.resizable === false}
            onChange={event => {const next = Number(event.target.value); setDuration(next); void props.onResize(next);}}>
            {Array.from({length: 20}, (_, index) => index + 1).map(seconds =>
              <option key={seconds} value={seconds}>{t('boardUi.inspector.durationSeconds', {seconds})}</option>)}
          </WorkbenchSelect>
        </div>
        <div className="generate-in-editing-service" data-testid="editing-generate-service" data-mode={inputs.mode}
          data-service={selectedProvider ? 'selected' : 'missing'}>
          <button type="button" className="generate-in-editing-service-button" aria-haspopup="menu"
            aria-expanded={serviceMenu} disabled={props.busy}
            onClick={() => setServiceMenu(open => !open)}>
            <Icon name="sparkle" size={12} />
            {selectedProvider
              ? <span>{serviceLabel} · {t(generationModeKeys[inputs.mode] as MessageKey)}{inputs.usedCount > 0 ? ` · ${t('boardUi.inputs.used', {count: inputs.usedCount})}` : ''}</span>
              : <span>{t('boardUi.inputs.serviceMissing')}</span>}
          </button>
          {serviceMenu && <GenerationServiceMenu providers={props.providers} disabled={props.busy}
            menuClassName="generate-in-editing-service-menu" menuTestId="editing-generate-service-menu"
            itemTestIdPrefix="editing-generate-service"
            onChoose={choice => {setServiceMenu(false);
              void props.onGenerationOptionsChange(serviceChoice(choice.provider, choice.model));}}
            onOpenSettings={() => {setServiceMenu(false); props.onOpenGenerationSettings?.();}}/>}
        </div>
      </> : <p className="generate-in-editing-empty" data-testid="editing-generate-inputs-loading">{t('boardUi.inputs.loading')}</p>}
    </section>
    <section className="generate-in-editing-dialogue">
      <ShotDialogue shot={shot as never} subjectNames={props.subjectNames} projectId={String(shot.projectId ?? '')}
        cueCount={props.cueCount} dialogueStatus={inputs?.dialogue ?? null} disabled={props.busy}
        rpc={props.rpc} onApplied={() => props.onDialogueApplied()} />
    </section>
    <footer className="generate-in-editing-footer">
      {activeJob ? <section className="generate-in-editing-progress" data-testid="editing-generate-progress">
        <div className="generate-in-editing-progress-row">
          <span className="spinner" aria-hidden="true"/>
          <span className="generate-in-editing-progress-label">{t('redesign.board.generating')} · {jobServiceName}</span>
          <strong className="generate-in-editing-progress-percent">{Math.round(Number(activeJob.progress) || 0)}%</strong>
          {props.onCancelJob && <Button type="button" size="sm" className="generate-in-editing-cancel" data-testid="editing-generate-cancel"
            disabled={props.busy || jobAction !== null} onClick={() => { void cancelJob(activeJob); }}>{t('redesign.board.cancelGeneration')}</Button>}
        </div>
        <div className="generate-in-editing-progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100}
          aria-valuenow={Math.round(Number(activeJob.progress) || 0)}><span style={{width: `${Math.max(2, Math.min(100, Math.round(Number(activeJob.progress) || 0)))}%`}}/></div>
      </section> : <>
        {failedJob && <section className="generate-in-editing-failure" data-testid="editing-generate-failure" role="alert">
          <span className="generate-in-editing-failure-label" data-text-selectable>{formatBoardGenerationFailure(
            failedJob.error, jobServiceDisplayName(failedJob, t, props.providers), t, renderMessage)}</span>
          {props.onRetryJob && canRetryGenerationFailure(failedJob.error) && <Button type="button" size="sm" className="generate-in-editing-retry" data-testid="editing-generate-retry"
            disabled={props.busy || jobAction !== null} onClick={() => { void retryJob(failedJob); }}>
            <Icon name="refresh" size={12}/>{t('redesign.board.retry')}</Button>}
        </section>}
        {unknownJob && <button type="button" className="generate-in-editing-unknown" data-testid="editing-generate-unknown"
          disabled={props.busy} onClick={() => props.onOpenTaskCenter?.(String(unknownJob.id))}>
          {t('redesign.board.unknownOutcome')}
        </button>}
        <Button type="button" size="sm" className="button generate-button full" data-testid="editing-generate-submit"
          disabled={props.busy || props.generateBlocked || !selectedProvider} onClick={() => void props.onGenerate()}>
          <Icon name="sparkle" size={16} />{t('boardUi.inspector.generate')}
        </Button>
      </>}
    </footer>
  </div>;
}
