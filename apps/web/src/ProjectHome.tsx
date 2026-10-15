import { message as msg } from '../../../packages/i18n/src/index.ts';
import type { DisplayMessage } from '../../../packages/i18n/src/index.ts';
import { useI18n } from './i18n/I18nProvider.tsx';
import React, { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Button } from '@mioon/ui/components/button';
import { Input } from '@mioon/ui/components/input';
import { Label } from '@mioon/ui/components/label';
import { Textarea } from '@mioon/ui/components/textarea';

export interface ProjectHomeProject {
  id: string;
  name: string;
  description?: string;
  updatedAt: string;
}

export interface ProjectHomeCreateState {
  readonly dirty: boolean;
  readonly busy: boolean;
  readonly version: number;
}

export interface ProjectHomeProps {
  projects: readonly ProjectHomeProject[];
  phase: 'home' | 'opening' | 'error';
  openingName?: string;
  error?: string | DisplayMessage;
  notice?: string | DisplayMessage;
  busy: boolean;
  listBusy: boolean;
  listError?: string | DisplayMessage;
  page: 'projects' | 'settings';
  onPage: (page: 'projects' | 'settings') => void;
  onOpen: (id: string) => void;
  onRetry: () => void;
  onRefresh: () => void;
  onCreate: (name: string, description: string) => Promise<boolean>;
  settings: ReactNode;
  status?: ReactNode;
  createDisabledReason?: string;
  onCreateStateChange?: (state: ProjectHomeCreateState) => void;
  canMutateEntry?: () => boolean;
  createIntentVersion?: number;
}

function ProjectSymbol({ size = 20 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3V7Z" />
    <path d="M8 12h8M8 15h5" />
  </svg>;
}

function ProjectTime({ value }: { value: string }) {
  const { t, renderMessage, formatDate, formatNumber } = useI18n();
  const date = new Date(value);
  return <span className="project-home-date"><span>{t('projects.updatedAt')}</span>{Number.isFinite(date.getTime())
    ? <time dateTime={value}>{formatDate(value, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</time>
    : <span>{t('projects.timeUnknown')}</span>}</span>;
}

/** Presentation only. The parent owns project reads, creation, navigation scope,
 * and whether a successful creation may still be accepted by this page. */
export default function ProjectHome({ projects, phase, openingName, error, notice, busy, listBusy, listError,
  page, onPage, onOpen, onRetry, onRefresh, onCreate, settings, status, createDisabledReason = '', onCreateStateChange, canMutateEntry, createIntentVersion = 0 }: ProjectHomeProps) {
  const { t, renderMessage, formatDate, formatNumber } = useI18n();
  const prefix = useId();
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [formError, setFormError] = useState<string | DisplayMessage>('');
  const [submitting, setSubmitting] = useState(false);
  const submissionPending = useRef(false);
  const current = useRef({ page, phase, busy, listBusy, createOpen, createDisabledReason });
  current.current = { page, phase, busy, listBusy, createOpen, createDisabledReason };
  const createMetadata = useRef({ name: '', description: '', busy: false, version: 0, callback: onCreateStateChange });
  const publishCreate = (patch: Partial<{ name: string; description: string; busy: boolean }> = {}) => {
    Object.assign(createMetadata.current, patch);
    const state = createMetadata.current;
    onCreateStateChange?.(Object.freeze({ dirty: Boolean(state.name || state.description), busy: state.busy, version: ++state.version }));
  };
  if (createMetadata.current.version === 0 || createMetadata.current.callback !== onCreateStateChange) {
    createMetadata.current.callback = onCreateStateChange;
    publishCreate({ name, description, busy: submissionPending.current });
  }
  const locked = busy || submitting || phase === 'opening';
  const empty = !projects.length && !listBusy && !listError;
  const canAct = () => canMutateEntry?.() !== false && current.current.page === 'projects' && !current.current.busy && !submissionPending.current && current.current.phase !== 'opening';

  useEffect(() => { if (createIntentVersion > 0 && canMutateEntry?.() !== false) setCreateOpen(true); }, [createIntentVersion]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canAct() || !current.current.createOpen || current.current.createDisabledReason) return;
    const trimmedName = name.trim(), trimmedDescription = description.trim();
    if (!trimmedName) { setFormError(msg('projects.nameRequired')); return; }
    if (trimmedName.length > 150 || trimmedDescription.length > 2000) {
      setFormError(msg('projects.inputLimits'));
      return;
    }
    // This local latch closes the gap before the parent's busy prop rerenders.
    submissionPending.current = true;
    publishCreate({ busy: true });
    setSubmitting(true);
    setFormError('');
    try {
      const accepted = await onCreate(trimmedName, trimmedDescription);
      if (accepted === true) { publishCreate({ name: '', description: '' }); setName(''); setDescription(''); setCreateOpen(false); }
      else setFormError(msg('projects.createRetained'));
    } catch {
      setFormError(msg('projects.createUnknown'));
    } finally {
      submissionPending.current = false;
      publishCreate({ busy: false });
      setSubmitting(false);
    }
  }

  return <div className="project-home" data-testid="project-home" data-phase={phase} data-page={page}>
    <header className="project-home-header">
      <div className="project-home-brand" aria-label="mioon"><span className="project-home-brand-mark"><ProjectSymbol size={20} /></span><span>mioon.</span></div>
      <span className="project-home-header-label">{t('projects.home')}</span>
      {status && <div className="project-home-status">{status}</div>}
    </header>
    <div className="project-home-layout">
      <nav className="project-home-nav" aria-label={t('projects.entry')}>
        <Button type="button" variant="ghost" data-testid="project-home-page-projects" aria-current={page === 'projects' ? 'page' : undefined}
          onClick={() => { if (page !== 'projects') onPage('projects'); }}>{t('projects.list')}</Button>
        <Button type="button" variant="ghost" data-testid="project-home-page-settings" disabled={phase === 'opening'} aria-current={page === 'settings' ? 'page' : undefined}
          onClick={() => { if (current.current.phase !== 'opening' && page !== 'settings') onPage('settings'); }}>{t('settings.title')}</Button>
      </nav>
      <main className="project-home-main" aria-labelledby={`${prefix}-heading`}>
        {notice && <div className="project-home-notice" role="status">{renderMessage(notice)}</div>}
        {phase === 'opening' && <section className="project-home-feedback" data-phase="opening" role="status" aria-live="polite" aria-busy="true">
          <div><strong>{openingName ? t('projects.openingNamed', { name: openingName }) : t('projects.opening')}</strong><p>{t('projects.loadingView')}</p></div>
        </section>}
        {phase === 'error' && <section className="project-home-feedback" data-phase="error" role="alert">
          <div><strong>{openingName ? t('projects.failedNamed', { name: openingName }) : t('projects.openFailed')}</strong><p>{error ? renderMessage(error) : t('projects.openRetryHint')}</p></div>
          {page === 'projects' && <Button type="button" variant="outline" data-testid="project-home-retry" disabled={busy || submitting}
            onClick={() => { if (canAct() && current.current.phase === 'error') onRetry(); }}>{t('projects.retryOpen')}</Button>}
        </section>}
        {page === 'settings' ? <section className="project-home-settings" data-testid="project-home-settings">
          <header className="project-home-heading"><div><div className="project-home-eyebrow">{t('projects.workspace')}</div><h1 id={`${prefix}-heading`}>{t('settings.title')}</h1><p>{t('settings.scope')}</p></div></header>
          <div className="project-home-settings-body">{settings}</div>
        </section> : <>
          <header className="project-home-heading">
            <div><div className="project-home-eyebrow">{t('projects.workspace')}</div><h1 id={`${prefix}-heading`}>{t('projects.list')}</h1><p>{t('projects.chooseStory')}</p></div>
            <Button type="button" data-testid="project-home-create-toggle" disabled={locked || Boolean(createDisabledReason)} aria-expanded={createOpen} aria-controls={`${prefix}-create`}
              onClick={() => { if (canAct() && !current.current.createDisabledReason) { publishCreate(); setCreateOpen(value => !value); } }}>{empty ? t('projects.createFirst') : t('projects.createNew')}</Button>
          </header>
          {createDisabledReason && <p className="project-home-notice" role="status" data-testid="project-home-create-disabled">{createDisabledReason}</p>}
          {createOpen && <form id={`${prefix}-create`} className="project-home-create" data-testid="project-home-create-form" onSubmit={create} aria-labelledby={`${prefix}-create-heading`} aria-busy={busy || submitting}>
            <h2 id={`${prefix}-create-heading`}>{t('projects.newStory')}</h2>
            <p className="project-home-create-intro">{t('projects.createIntro')}</p>
            <div className="project-home-field"><Label htmlFor={`${prefix}-name`}>{t('projects.name')}</Label>
              <Input id={`${prefix}-name`} data-testid="project-home-name" value={name} maxLength={150} required autoFocus disabled={locked || Boolean(createDisabledReason)}
                placeholder={t('projects.namePlaceholder')} aria-invalid={Boolean(formError) && !name.trim()} aria-describedby={formError ? `${prefix}-form-error` : undefined}
                onChange={event => { if (canAct() && !current.current.createDisabledReason) { publishCreate({ name: event.target.value }); setName(event.target.value); setFormError(''); } }} />
            </div>
            <div className="project-home-field"><Label htmlFor={`${prefix}-description`}>{t('projects.direction')}<span>{t('shell.optional')}</span></Label>
              <Textarea id={`${prefix}-description`} data-testid="project-home-description" value={description} rows={3} maxLength={2000} disabled={locked || Boolean(createDisabledReason)}
                placeholder={t('projects.directionPlaceholder')} onChange={event => { if (canAct() && !current.current.createDisabledReason) { publishCreate({ description: event.target.value }); setDescription(event.target.value); setFormError(''); } }} />
            </div>
            {formError && <p id={`${prefix}-form-error`} className="project-home-form-error" role="alert">{renderMessage(formError)}</p>}
            <div className="project-home-form-actions">
              <Button type="button" variant="ghost" data-testid="project-home-create-cancel" disabled={locked} onClick={() => { if (canAct()) setCreateOpen(false); }}>{t('shell.cancel')}</Button>
              <Button type="submit" data-testid="project-home-create-submit" disabled={locked || Boolean(createDisabledReason) || !name.trim()}>{busy || submitting ? t('projects.creating') : t('projects.createOpen')}</Button>
            </div>
          </form>}
          <section aria-labelledby={`${prefix}-list-heading`} aria-busy={listBusy}>
            <div className="project-home-list-header"><h2 id={`${prefix}-list-heading`}>{projects.length ? t('projects.countSorted', { count: projects.length }) : t('projects.workspaceProjects')}</h2>
              <Button type="button" variant="ghost" data-testid="project-home-refresh" disabled={listBusy || busy || submitting}
                onClick={() => { if (current.current.page === 'projects' && !current.current.listBusy && !current.current.busy && !submissionPending.current) onRefresh(); }}>{listBusy ? t('projects.refreshing') : t('projects.refreshList')}</Button>
            </div>
            {listError && <p className="project-home-list-error" role="alert">{renderMessage(listError)}</p>}
            {listBusy && !projects.length && <p className="project-home-list-loading" role="status">{t('projects.loadingList')}</p>}
            {empty && <div className="project-home-empty" data-testid="project-home-empty">
              <span className="project-home-empty-symbol"><ProjectSymbol size={28} /></span><h2>{t('projects.emptyTitle')}</h2><p>{t('projects.emptyBody')}</p>
            </div>}
            {projects.length > 0 && <ul className="project-home-list" data-testid="project-home-list">
              {projects.map(project => <li key={project.id}><article className="project-home-card">
                <span className="project-home-card-symbol"><ProjectSymbol /></span><h3>{project.name}</h3>
                {project.description && <p className="project-home-description">{project.description}</p>}
                <div className="project-home-card-footer"><ProjectTime value={project.updatedAt} /><Button type="button" variant="outline" data-testid={`project-home-open-${project.id}`} aria-label={t('projects.openNamed', { name: project.name })} disabled={locked}
                  onClick={() => { if (canAct()) onOpen(project.id); }}>{t('projects.open')}</Button></div>
              </article></li>)}
            </ul>}
          </section>
          <p className="project-home-footnote">{t('projects.workspaceFootnote')}</p>
        </>}
      </main>
    </div>
  </div>;
}
