/** GE-b: the editing-side generation panel for one format-5 shot created from
 * the timeline. It reuses the RI-b read-only generation-input projection: the
 * panel shows the inputs, it never edits reference lines (those stay on board). */
import React, {useEffect, useState} from 'react';
import {Button} from '@mioon/ui/components/button';
import {Textarea} from '@mioon/ui/components/textarea';
import {WorkbenchSelect} from '../WorkspaceControls.tsx';
import Icon from '../icons.tsx';
import ShotDialogue from '../ShotDialogue.tsx';
import {useI18n} from '../i18n/I18nProvider.tsx';
import {generationModeKeys, referenceRoleKey, unsupportedReasonKey} from '../board-ui/inputs.ts';
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
  readonly jobStatus?: string | null;
  readonly busy: boolean;
  readonly blockedReason?: string | null;
  readonly onSavePrompt: (prompt: string) => unknown;
  readonly onResize: (duration: number) => unknown;
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
  useEffect(() => {setDraft(String(shot.prompt ?? '')); setDuration(Number(shot.duration) || 4);},
    [shot.id, shot.revision]);
  const dirty = draft !== String(shot.prompt ?? '');
  const entries = inputs?.entries ?? [];
  return <div className="generate-in-editing-panel" data-testid="editing-generate-panel">
    <header className="generate-in-editing-heading">
      <strong data-testid="editing-generate-shot-title">{props.shotLabel ? `${props.shotLabel} · ` : ''}{String(shot.title ?? '')}</strong>
      <Button type="button" variant="ghost" size="sm" className="text-button" data-testid="editing-generate-reveal"
        onClick={() => props.onRevealOnBoard()}><Icon name="board" size={13} />{t('editUi.shot.reveal')}</Button>
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
            value={String(duration)} disabled={props.busy}
            onChange={event => {const next = Number(event.target.value); setDuration(next); void props.onResize(next);}}>
            {Array.from({length: 20}, (_, index) => index + 1).map(seconds =>
              <option key={seconds} value={seconds}>{t('boardUi.inspector.durationSeconds', {seconds})}</option>)}
          </WorkbenchSelect>
        </div>
        <div className="generate-in-editing-service" data-testid="editing-generate-service" data-mode={inputs.mode}>
          <Icon name="sparkle" size={12} />
          {inputs.service
            ? <span>{inputs.service.modelName} · {t(generationModeKeys[inputs.mode] as MessageKey)}{inputs.usedCount > 0 ? ` · ${t('boardUi.inputs.used', {count: inputs.usedCount})}` : ''}</span>
            : <span>{t('boardUi.inputs.serviceMissing')}</span>}
        </div>
      </> : <p className="generate-in-editing-empty" data-testid="editing-generate-inputs-loading">{t('boardUi.inputs.loading')}</p>}
    </section>
    <section className="generate-in-editing-dialogue">
      <ShotDialogue shot={shot as never} subjectNames={props.subjectNames} projectId={String(shot.projectId ?? '')}
        cueCount={props.cueCount} dialogueStatus={inputs?.dialogue ?? null} disabled={props.busy}
        rpc={props.rpc} onApplied={() => props.onDialogueApplied()} />
    </section>
    {props.blockedReason && <p className="generate-in-editing-note" role="status">{props.blockedReason}</p>}
    <footer className="generate-in-editing-footer">
      <Button type="button" size="sm" className="button generate-button full" data-testid="editing-generate-submit"
        disabled={props.busy || !inputs?.service} onClick={() => void props.onGenerate()}>
        <Icon name="sparkle" size={16} />{t('boardUi.inspector.generate')}
      </Button>
    </footer>
  </div>;
}
