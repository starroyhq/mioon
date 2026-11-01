import React from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Dialog } from '@mioon/ui/components/dialog';
import { Textarea } from '@mioon/ui/components/textarea';
import { WorkbenchAlert, WorkbenchBadge, WorkbenchButton, WorkbenchDialogContent } from '@mioon/ui/components/workbench-controls';
import { Check } from '@mioon/ui/components/workbench-icons';
import { PROJECT_RULES_FILE } from '../../../../packages/contracts/src/project-file.ts';
import { useI18n } from '../i18n/I18nProvider.tsx';
import Icon from '../icons.tsx';
import { displayPath } from './format.ts';
import type { ActionState, ViewState } from './types.ts';
import './project-file-common.css';
import './project-file-rules.css';

const encoder = new TextEncoder();
/** UTF-8 bytes, as the size limit counts them. */
export const rulesBytes = (text: string): number => encoder.encode(text).byteLength;
/** Same characters as project notes refuse (projectNotesValid): controls other
 * than tab, line feed and carriage return, and lone surrogates. */
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\ud800-\udfff]/u;
export function rulesProblem(text: string, maxBytes: number): 'tooLong' | 'invalid' | null {
  if (rulesBytes(text) > maxBytes) return 'tooLong';
  return CONTROL.test(text) ? 'invalid' : null;
}

export interface ProjectRulesDialogProps {
  readonly open: boolean;
  /** AGENTS.md as read; `exists` is false while the project has none. */
  readonly state: ViewState<{ readonly text: string; readonly exists: boolean }>;
  readonly draft: string;
  readonly onDraftChange: (text: string) => void;
  /** Size limit in bytes (R2). */
  readonly maxBytes: number;
  /** untrusted: changed outside Mioon since it was last enabled here, so not sent to Mio. */
  readonly trust: 'trusted' | 'untrusted';
  /** Path of AGENTS.md. */
  readonly path: string;
  readonly homeDirectory?: string | null;
  readonly save: ActionState<'save' | 'enable'>;
  /** The file changed elsewhere since it was read. */
  readonly conflict: boolean;
  readonly onSave: () => void;
  /** Enables the file; with a changed draft the caller saves it first. */
  readonly onEnable: () => void;
  readonly onLoadLatest: () => void;
  readonly onRetry: () => void;
  readonly onClose: () => void;
}

/** Project rules (12-12): AGENTS.md in the project folder, edited like the project notes. */
export function ProjectRulesDialog(props: ProjectRulesDialogProps): ReactElement {
  const { t } = useI18n();
  const { state, draft, maxBytes, save } = props;
  const ready = state.kind === 'ready' ? state.value : null;
  const saving = save.kind === 'working';
  const dirty = ready !== null && draft !== ready.text;
  const problem = rulesProblem(draft, maxBytes), bytes = rulesBytes(draft);
  const untrusted = ready?.exists === true && props.trust === 'untrusted';
  const file = { file: PROJECT_RULES_FILE };
  let body: ReactNode;
  if (state.kind === 'loading') body = <div className="pf-state" role="status" data-testid="pf-rules-loading"><span className="wb-spinner" aria-hidden="true" />{t('projectFile.rules.loading')}</div>;
  else if (state.kind === 'error') body = <div className="pf-state" role="alert" data-testid="pf-rules-error"><strong>{t('projectFile.rules.error', file)}</strong>
    {state.retryable && <WorkbenchButton data-testid="pf-rules-retry" onClick={props.onRetry}>{t('projectFile.common.retry')}</WorkbenchButton>}</div>;
  else body = <>
    <Textarea className="pf-rules-text" data-testid="pf-rules-text" aria-label={t('projectFile.rules.title')} aria-describedby="pf-rules-count" value={draft} readOnly={saving}
      placeholder={t('projectFile.rules.placeholder')} aria-invalid={problem !== null || undefined} spellCheck={false} onChange={event => { if (!saving) props.onDraftChange(event.target.value); }} />
    <p id="pf-rules-count" className="pf-rules-count" data-testid="pf-rules-count" data-over={problem === 'tooLong' || undefined}>{t('projectFile.rules.bytes', { bytes, limit: maxBytes })}</p>
    {problem && <p className="pf-rules-problem" role="alert" data-testid="pf-rules-problem">{t(problem === 'tooLong' ? 'projectFile.rules.tooLong' : 'projectFile.rules.invalid', { limit: maxBytes })}</p>}
    {props.conflict && <WorkbenchAlert tone="warning" data-testid="pf-rules-conflict"
      actions={<WorkbenchButton size="compact" data-testid="pf-rules-load-latest" disabled={saving} onClick={props.onLoadLatest}>{t('projectFile.rules.loadLatest')}</WorkbenchButton>}>{t('projectFile.rules.conflict', file)}</WorkbenchAlert>}
    {save.kind === 'error' && <WorkbenchAlert tone="danger" data-testid="pf-rules-save-error">{t(save.action === 'enable' ? 'projectFile.rules.enableFailed' : 'projectFile.rules.saveFailed')}</WorkbenchAlert>}
  </>;
  const status = ready === null ? null : !ready.exists
    ? <span className="pf-rules-status-note" data-testid="pf-rules-new">{t('projectFile.rules.newFile', file)}</span>
    : <WorkbenchBadge tone={untrusted ? 'warning' : 'success'} data-testid="pf-rules-status">{t(untrusted ? 'projectFile.rules.notEnabled' : 'projectFile.rules.enabled')}</WorkbenchBadge>;
  const primary = untrusted
    ? <WorkbenchButton variant="primary" data-testid="pf-rules-enable" loading={saving && save.action === 'enable'} disabled={saving || problem !== null} onClick={props.onEnable}>{t(dirty ? 'projectFile.rules.saveAndEnable' : 'projectFile.rules.enable')}</WorkbenchButton>
    : <WorkbenchButton variant="primary" data-testid="pf-rules-save" loading={saving && save.action === 'save'} disabled={ready === null || saving || !dirty || problem !== null} onClick={props.onSave}>{t('projectFile.rules.save')}</WorkbenchButton>;
  return <Dialog open={props.open} onOpenChange={next => { if (!next && !saving) props.onClose(); }}>
    <WorkbenchDialogContent title={t('projectFile.rules.title')} description={t('projectFile.rules.description', file)} className="pf-dialog pf-rules-dialog" data-testid="pf-rules-dialog" showCloseButton={!saving}
      footer={<>
        <div className="pf-footer-note pf-rules-file">
          <span className="pf-rules-path"><Icon name="note" size={14} /><span className="pf-mono" data-testid="pf-rules-path">{displayPath(props.path, props.homeDirectory)}</span>{status}</span>
          {untrusted && <span className="pf-rules-status-note" data-testid="pf-rules-untrusted">{t('projectFile.rules.untrustedNote')}</span>}
        </div>
        <WorkbenchButton data-testid="pf-rules-discard" disabled={saving} onClick={props.onClose}>{t('projectFile.rules.discard')}</WorkbenchButton>
        {primary}
      </>}>
      {body}
    </WorkbenchDialogContent>
  </Dialog>;
}

export interface ProjectRulesNoticeProps {
  readonly enable: ActionState<'enable'>;
  /** Opens the rules to review them before enabling. */
  readonly onReview: () => void;
  readonly onLater: () => void;
}
/** In the Mio panel when AGENTS.md is not enabled (12-13). */
export function ProjectRulesNotice({ enable, onReview, onLater }: ProjectRulesNoticeProps): ReactElement {
  const { t } = useI18n();
  const working = enable.kind === 'working';
  return <section className="pf-rules-notice" data-testid="pf-rules-notice" aria-label={t('projectFile.rules.title')}>
    <Icon name="note" size={16} className="pf-rules-notice-icon" />
    <div className="pf-rules-notice-body">
      <p>{t('projectFile.rules.notice', { file: PROJECT_RULES_FILE })}</p>
      {enable.kind === 'error' && <p className="pf-rules-notice-error" role="alert" data-testid="pf-rules-notice-error">{t('projectFile.rules.enableFailed')}</p>}
      <div className="pf-rules-notice-actions">
        <WorkbenchButton size="compact" data-testid="pf-rules-review" loading={working} onClick={onReview}>{t('projectFile.rules.review')}</WorkbenchButton>
        <WorkbenchButton size="compact" data-testid="pf-rules-later" disabled={working} onClick={onLater}>{t('projectFile.rules.later')}</WorkbenchButton>
      </div>
    </div>
  </section>;
}

/** A change Mio proposes to one section of AGENTS.md. */
export interface ProjectRulesChange {
  /** The heading the lines belong to; null outside any section. */
  readonly section: string | null;
  readonly lines: readonly { readonly kind: 'add' | 'remove'; readonly text: string }[];
}
export type RulesDecision = 'allow' | 'reject';
export type ProjectRulesChangeState =
  | { readonly kind: 'pending' }
  | { readonly kind: 'submitting'; readonly decision: RulesDecision }
  | { readonly kind: 'error'; readonly decision: RulesDecision }
  | { readonly kind: 'allowed' }
  | { readonly kind: 'rejected' };
export interface ProjectRulesChangeCardProps {
  readonly change: ProjectRulesChange;
  readonly state: ProjectRulesChangeState;
  readonly onAllow: () => void;
  readonly onReject: () => void;
}
/** Mio's change to the project rules, in the conversation (12-14). Always asks,
 * whatever the confirmation settings; once decided it only shows the outcome. */
export function ProjectRulesChangeCard({ change, state, onAllow, onReject }: ProjectRulesChangeCardProps): ReactElement {
  const { t } = useI18n();
  const decided = state.kind === 'allowed' || state.kind === 'rejected';
  const submitting = state.kind === 'submitting';
  const added = change.lines.filter(line => line.kind === 'add').length, removed = change.lines.length - added;
  const counts = [...added > 0 ? [t('projectFile.rules.change.added', { count: added })] : [], ...removed > 0 ? [t('projectFile.rules.change.removed', { count: removed })] : []]
    .join(t('projectFile.common.listSeparator'));
  return <section className="pf-rules-card" data-state={state.kind} data-testid="pf-rules-card" aria-label={t('projectFile.rules.change.title')}>
    <header className="pf-rules-card-heading">
      <Icon name="note" size={16} />
      <h3>{t('projectFile.rules.change.title')}</h3>
      <WorkbenchBadge tone={state.kind === 'allowed' ? 'success' : state.kind === 'rejected' ? 'neutral' : 'warning'} data-testid="pf-rules-card-status">
        {t(state.kind === 'allowed' ? 'projectFile.rules.change.allowed' : state.kind === 'rejected' ? 'projectFile.rules.change.rejected' : 'projectFile.rules.change.needsConfirm')}
      </WorkbenchBadge>
    </header>
    <div className="pf-rules-diff" data-testid="pf-rules-diff">
      <p className="pf-rules-diff-heading">
        <span>{PROJECT_RULES_FILE}</span>
        <span data-testid="pf-rules-diff-counts">{change.section === null ? counts : t('projectFile.rules.change.sectionCounts', { section: change.section, counts })}</span>
      </p>
      <ul>{change.lines.map((line, index) => <li key={index} data-kind={line.kind}><span className="pf-rules-diff-sign" aria-hidden="true">{line.kind === 'add' ? '+' : '-'}</span>{line.text}</li>)}</ul>
    </div>
    <p className="pf-rules-card-note"><Icon name="shield" size={14} />{t('projectFile.rules.change.note')}</p>
    {state.kind === 'error' && <WorkbenchAlert tone="danger" data-testid="pf-rules-card-error">{t('projectFile.rules.change.failed')}</WorkbenchAlert>}
    {decided
      ? <p className="pf-rules-card-result" data-testid="pf-rules-card-result">{t(state.kind === 'allowed' ? 'projectFile.rules.change.allowedResult' : 'projectFile.rules.change.rejectedResult', { file: PROJECT_RULES_FILE })}</p>
      : <div className="pf-rules-card-actions">
        <WorkbenchButton data-testid="pf-rules-reject" loading={submitting && state.decision === 'reject'} disabled={submitting} onClick={onReject}>{t('projectFile.rules.change.reject')}</WorkbenchButton>
        <WorkbenchButton variant="primary" data-testid="pf-rules-allow" loading={submitting && state.decision === 'allow'} disabled={submitting} onClick={onAllow}>
          {!(submitting && state.decision === 'allow') && <Check size={14} aria-hidden="true" />}{t('projectFile.rules.change.allow')}
        </WorkbenchButton>
      </div>}
  </section>;
}
