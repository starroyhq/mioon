import { message as msg } from '../../../packages/i18n/src/index.ts';
import type { DisplayMessage } from '../../../packages/i18n/src/index.ts';
import { useI18n } from './i18n/I18nProvider.tsx';
import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type {MenuHelpControl} from './desktop-menu-client.ts';
import { Button } from '@mioon/ui/components/button';
import { Input } from '@mioon/ui/components/input';
import { Label } from '@mioon/ui/components/label';
import { ChevronRight, Clapperboard, FolderOpen, Info, WorkbenchIcon } from '@mioon/ui/components/workbench-icons';
import { Dialog } from '@mioon/ui/components/dialog';
import { WorkbenchButton, WorkbenchDialogContent } from '@mioon/ui/components/workbench-controls';
import type { ProjectSummary } from '../../../packages/contracts/src/project-home.ts';
import { Textarea } from '@mioon/ui/components/textarea';
import {hasOpenWorkbenchModal} from './workbench-modal-state.ts';
import {PendingProjectOpenStatus, type PendingProjectOpen} from './project-file/RecentProjects.tsx';
import './launcher-home.css';

export interface ProjectHomeProject {
  id: string;
  name: string;
  description?: string;
  updatedAt: string;
  revision?: number;
  cover?: ProjectSummary['cover'];
  shotCount?: number;
  durationFrames?: number;
  fps?: number;
  width?: number;
  height?: number;
  lastOpenedAt?: string | null;
}

export interface ProjectHomeCreateState {
  readonly dirty: boolean;
  readonly busy: boolean;
  readonly version: number;
}

type LauncherPage = 'projects' | 'examples' | 'help';

export interface ProjectHomeProps {
  onRegisterMenuHelp?: (control: MenuHelpControl) => () => void;
  onMenuHelpStateChange?: () => void;
  projects: readonly ProjectHomeProject[];
  phase: 'home' | 'opening' | 'error';
  openingName?: string;
  deferOpeningFeedback?: boolean;
  pendingOpen?: PendingProjectOpen;
  error?: string | DisplayMessage;
  notice?: string | DisplayMessage;
  busy: boolean;
  active?: boolean;
  listBusy: boolean;
  listError?: string | DisplayMessage;
  page: 'projects' | 'settings';
  onPage: (page: 'projects' | 'settings') => void;
  onOpen: (id: string) => void;
  onRetry: () => void;
  onRefresh: () => void;
  onCreate: (name: string, description: string, timelinePresetId?: string) => Promise<boolean>;
  /** A native entry owns its retained create dialog and departure guard. */
  onRequestCreate?: () => void;
  /** A native entry opens its owned .mioon file picker. */
  onOpenFile?: () => void;
  /** Supplied only when a trusted template destination/instantiate port exists. */
  onStartExample?: () => void | Promise<boolean>;
  /** Feedback only: a blocked click must not dispatch the example operation. */
  onStartExampleBlocked?: () => void;
  query?: string;
  onQuery?: (value: string) => void;
  toolbar?: ReactNode;
  /** A verified catalog supplies its own loading and error views and admits the
   * launcher's empty content only when the directory is known to be empty. */
  renderCatalog?: (emptyContent?: ReactNode, pendingOpen?: PendingProjectOpen) => ReactNode;
  launcher?: {readonly version?: string; readonly service: 'ready' | 'connecting' | 'unavailable'; readonly empty: boolean};
  projectMenu?: (project: ProjectHomeProject) => ReactNode;
  totalProjects?: number;
  settings: ReactNode;
  status?: ReactNode;
  help?: ReactNode;
  createDisabledReason?: string;
  onCreateStateChange?: (state: ProjectHomeCreateState) => void;
  canMutateEntry?: () => boolean;
  createIntentVersion?: number;
  /** Opens the .mioon file picker; the parent owns the file and the import flow. */
  onImport?: () => void;
  /** Projects imported during this session, shown with a "just imported" tag. */
  justImported?: readonly string[];
}

function ProjectSymbol({ size = 20 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3V7Z" />
    <path d="M8 12h8M8 15h5" />
  </svg>;
}

function HelpSymbol() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M9.5 9a2.5 2.5 0 1 1 4.1 1.9c-1 .7-1.6 1.1-1.6 2.6M12 17h.01" /></svg>;
}

function FormatSymbol({ format }: { format: string }) {
  const width = format === 'portrait_1080' ? 22 : format === 'square_1080' ? 32 : 44;
  const height = format === 'landscape_1080' ? 24 : format === 'square_1080' ? 32 : 40;
  return <svg className="project-home-format-icon" width="48" height="44" viewBox="0 0 48 44" fill="none" aria-hidden="true"><rect x={(48 - width) / 2} y={(44 - height) / 2} width={width} height={height} rx="3" stroke="currentColor" strokeWidth="1.5" /></svg>;
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
export default function ProjectHome({ projects, phase, openingName, deferOpeningFeedback, pendingOpen, error, notice, busy, listBusy, listError,
  page, onPage, onOpen, onRetry, onRefresh, onCreate, onRequestCreate, onOpenFile, onStartExample, onStartExampleBlocked, settings, status, help, active = true, createDisabledReason = '', onCreateStateChange, canMutateEntry, createIntentVersion = 0, onImport, justImported = [], query = '', onQuery, toolbar, renderCatalog, launcher, projectMenu, totalProjects = projects.length, onRegisterMenuHelp, onMenuHelpStateChange }: ProjectHomeProps) {
  const { t, renderMessage, formatDate, formatNumber } = useI18n();
  const prefix = useId();
  const searchInput=useRef<HTMLInputElement>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [launcherPage, setLauncherPage] = useState<LauncherPage>('projects');
  const helpScope = useMemo(() => ({ active, page, open: helpOpen, launcherPage }), [active, page, helpOpen, launcherPage]);
  const helpAuthority = useRef<typeof helpScope | null>(helpScope);
  helpAuthority.current = helpScope;
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [timelinePresetId, setTimelinePresetId] = useState('portrait_1080');
  const [formError, setFormError] = useState<string | DisplayMessage>('');
  const [submitting, setSubmitting] = useState(false);
  const submissionPending = useRef(false);
  const current = useRef({ active, page, phase, busy, listBusy, createOpen, helpOpen, launcherPage, createDisabledReason, canMutateEntry, onRequestCreate, onOpenFile, onStartExample, onStartExampleBlocked, onRefresh });
  current.current = { active, page, phase, busy, listBusy, createOpen, helpOpen, launcherPage, createDisabledReason, canMutateEntry, onRequestCreate, onOpenFile, onStartExample, onStartExampleBlocked, onRefresh };
  const createMetadata = useRef({ name: '', description: '', preset: 'portrait_1080', busy: false, version: 0, callback: onCreateStateChange });
  const publishCreate = (patch: Partial<{ name: string; description: string; preset: string; busy: boolean }> = {}) => {
    Object.assign(createMetadata.current, patch);
    const state = createMetadata.current;
    onCreateStateChange?.(Object.freeze({ dirty: Boolean(state.name || state.description || state.preset !== 'portrait_1080'), busy: state.busy, version: ++state.version }));
  };
  if (createMetadata.current.version === 0 || createMetadata.current.callback !== onCreateStateChange) {
    createMetadata.current.callback = onCreateStateChange;
    publishCreate({ name, description, preset: timelinePresetId, busy: submissionPending.current });
  }
  const locked = busy || submitting || phase === 'opening';
  const empty = !totalProjects && !listBusy && !listError;
  const canAct = () => current.current.canMutateEntry?.() !== false && current.current.page === 'projects' && !current.current.busy && !submissionPending.current && current.current.phase !== 'opening';
  const canRefresh = () => current.current.active && current.current.page === 'projects' && current.current.phase !== 'opening' && !current.current.listBusy && !current.current.busy && !submissionPending.current;
  useEffect(()=>{if(typeof window==='undefined')return;const shortcut=(event:KeyboardEvent)=>{const state=current.current;if((event.metaKey||event.ctrlKey)&&!event.altKey&&event.key.toLowerCase()==='f'&&state.active&&state.page==='projects'&&state.launcherPage==='projects'&&!state.createOpen&&!state.helpOpen&&!state.busy&&state.phase!=='opening'&&onQuery&&totalProjects>0&&searchInput.current){event.preventDefault();searchInput.current.focus();searchInput.current.select();}};window.addEventListener('keydown',shortcut);return()=>window.removeEventListener('keydown',shortcut);},[onQuery,totalProjects]);
  const changeHelp = (open: boolean) => { helpAuthority.current = null; current.current.helpOpen = open; setHelpOpen(open); };
  useEffect(() => {
    let mounted = true;
    const control: MenuHelpControl = {available: () => {
      const state = current.current, form = createMetadata.current;
      return mounted && state.active && state.page === 'projects' && !state.busy && !submissionPending.current && state.phase !== 'opening' && !state.createOpen && !state.helpOpen &&
        !form.name && !form.description && form.preset === 'portrait_1080' && state.canMutateEntry?.() !== false;
    }, open: () => { if (!control.available()) return false; changeHelp(true); onMenuHelpStateChange?.(); return true; }};
    const release = onRegisterMenuHelp?.(control);
    return () => {mounted = false; release?.();};
  }, [onRegisterMenuHelp]);
  useEffect(() => { onMenuHelpStateChange?.(); }, [active, page, phase, busy, listBusy, createOpen, helpOpen, name, description, timelinePresetId, submitting, onMenuHelpStateChange]);

  useEffect(() => { helpAuthority.current = helpScope; return () => { helpAuthority.current = null; }; }, [helpScope]);
  useEffect(() => { if (!active || page !== 'projects') changeHelp(false); }, [active, page]);

  function requestCreate(toggle = false): void {
    if (!canAct() || !current.current.active || current.current.createDisabledReason) return;
    if (current.current.onRequestCreate) {current.current.onRequestCreate(); return;}
    publishCreate(); setCreateOpen(value => toggle ? !value : true);
  }
  const startExample = (): void => {
    if (canAct() && current.current.active) void current.current.onStartExample?.();
    else current.current.onStartExampleBlocked?.();
  };
  const launcherNavigationLocked = locked || !active || createOpen || helpOpen || page !== 'projects';
  const canNavigateLauncher = (): boolean => {
    const state = current.current;
    return state.active && state.page === 'projects' && state.phase !== 'opening' && !state.busy &&
      !submissionPending.current && !state.createOpen && !state.helpOpen &&
      (typeof document === 'undefined' || !hasOpenWorkbenchModal(document));
  };
  function navigateLauncher(destination: LauncherPage): void {
    if (!canNavigateLauncher() || current.current.launcherPage === destination) return;
    helpAuthority.current = null;
    current.current.launcherPage = destination;
    setLauncherPage(destination);
  }
  function openLauncherFile(): void {
    if (current.current.launcherPage === 'projects' && canNavigateLauncher() && canAct()) current.current.onOpenFile?.();
  }
  function createLauncherProject(): void {
    if (current.current.launcherPage === 'projects' && canNavigateLauncher()) requestCreate();
  }
  function startLauncherExample(source: 'projects' | 'examples'): void {
    if (current.current.launcherPage === source && canNavigateLauncher()) startExample();
  }
  useEffect(() => { if (createIntentVersion > 0) requestCreate(); }, [createIntentVersion]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canAct() || !current.current.createOpen || current.current.createDisabledReason) return;
    const trimmedName = name.trim(), trimmedDescription = description.trim();
    if (!trimmedName) { setFormError(msg('projects.nameRequired')); return; }
    if (trimmedName.length > 150 || trimmedDescription.length > 500) {
      setFormError(msg('redesign.projects.inputLimits'));
      return;
    }
    // This local latch closes the gap before the parent's busy prop rerenders.
    submissionPending.current = true;
    publishCreate({ busy: true });
    setSubmitting(true);
    setFormError('');
    try {
      const accepted = await onCreate(trimmedName, trimmedDescription, timelinePresetId);
      if (accepted === true) { publishCreate({ name: '', description: '', preset: 'portrait_1080' }); setName(''); setDescription(''); setTimelinePresetId('portrait_1080'); setCreateOpen(false); }
      else setFormError(msg('projects.createRetained'));
    } catch {
      setFormError(msg('projects.createUnknown'));
    } finally {
      submissionPending.current = false;
      publishCreate({ busy: false });
      setSubmitting(false);
    }
  }

  const renderSearch = (inLauncher: boolean) => {
    const label = t('redesign.projects.search');
    return <div className={inLauncher ? 'launcher-home-search' : 'project-home-search-field'}>
      <WorkbenchIcon name="search" size={15} />
      <Input ref={searchInput} className={inLauncher ? 'launcher-home-search-input' : 'project-home-search'} data-testid="project-home-search"
        aria-label={label} value={query} placeholder={label} disabled={locked || inLauncher && !active}
        onChange={event => { if (canAct() && (!inLauncher || current.current.launcherPage === 'projects')) onQuery?.(event.target.value); }} />
      <kbd aria-hidden="true">{t('redesign.projects.searchShortcut')}</kbd>
    </div>;
  };
  const renderHelp = (surface: 'page' | 'dialog') => <>
    <p>{t('projects.workspaceFootnote')}</p>
    {help && <div className="project-home-status">{help}</div>}
    <WorkbenchButton type="button" data-testid={surface === 'dialog' ? 'project-home-refresh' : 'launcher-help-refresh'} disabled={listBusy || locked} onClick={() => {
      if (helpAuthority.current !== helpScope || !canRefresh()) return;
      if (surface === 'dialog' ? helpScope.open && current.current.helpOpen : helpScope.launcherPage === 'help' && canNavigateLauncher()) current.current.onRefresh();
    }}>{listBusy ? t('projects.refreshing') : t('projects.refreshList')}</WorkbenchButton>
  </>;
  const launcherEmpty = launcher ? <div className="launcher-home-empty" data-testid="launcher-empty">
    <h1>{t('launcher.empty.title')}</h1>
    <p>{t('launcher.empty.description')}</p>
    <WorkbenchButton type="button" variant="primary" className="launcher-home-create-tile" data-testid="project-home-create-toggle"
      aria-label={t('projects.createNew')} aria-describedby={`${prefix}-launcher-create-hint`}
      disabled={launcherNavigationLocked || Boolean(createDisabledReason)} onClick={createLauncherProject}>
      <span className="launcher-home-create-title"><span><WorkbenchIcon name="plus" size={23} /></span>{t('projects.createNew')}</span>
      <span className="launcher-home-create-description" id={`${prefix}-launcher-create-hint`}>{t('launcher.empty.createHint')}</span>
    </WorkbenchButton>
    {(onStartExample || onOpenFile) && <div className="launcher-home-empty-actions">
      {onStartExample && <WorkbenchButton type="button" className="launcher-home-action-tile" data-testid="project-home-example"
        aria-label={t('projectHomeNative.example')} aria-describedby={`${prefix}-launcher-example-hint`}
        disabled={launcherNavigationLocked} onClick={() => startLauncherExample('projects')}>
        <span className="launcher-home-action-icon"><Clapperboard size={22} aria-hidden="true" /></span>
        <span className="launcher-home-action-copy"><strong>{t('projectHomeNative.example')}</strong><span id={`${prefix}-launcher-example-hint`}>{t('projectHomeNative.example.description')}</span></span>
        <ChevronRight size={15} aria-hidden="true" />
      </WorkbenchButton>}
      {onOpenFile && <WorkbenchButton type="button" className="launcher-home-action-tile" data-testid="project-home-open-file"
        aria-label={t('launcher.openFile')} aria-describedby={`${prefix}-launcher-open-hint`}
        disabled={launcherNavigationLocked} onClick={openLauncherFile}>
        <span className="launcher-home-action-icon"><FolderOpen size={22} aria-hidden="true" /></span>
        <span className="launcher-home-action-copy"><strong>{t('launcher.openFile')}</strong><span id={`${prefix}-launcher-open-hint`}>{t('launcher.empty.openHint')}</span></span>
        <ChevronRight size={15} aria-hidden="true" />
      </WorkbenchButton>}
    </div>}
  </div> : undefined;
  const catalogVisible = page === 'projects' && (!launcher || launcherPage === 'projects');
  const catalogContent = renderCatalog?.(launcherEmpty, catalogVisible ? pendingOpen : undefined);
  const launcherLinks = launcher ? [
    {id: 'projects', label: t('launcher.projects'), icon: FolderOpen},
    {id: 'examples', label: t('launcher.examples'), icon: Clapperboard},
    {id: 'help', label: t('launcher.help'), icon: Info},
  ] as const : [];

  return <div className={launcher ? 'project-home launcher-home' : 'project-home'} data-testid="project-home" data-phase={phase} data-page={page}>
    {launcher && <aside className="launcher-home-sidebar" data-testid="launcher-sidebar">
      <div className="launcher-home-titlebar" aria-hidden="true" />
      <div className="launcher-home-brand">
        <img src="/favicon.png" width={32} height={32} alt="" />
        <span className="launcher-home-brand-copy"><strong>Mioon</strong>
          {launcher.version && <span className="launcher-home-version" data-testid="launcher-version">{launcher.version}</span>}
        </span>
      </div>
      <nav aria-label={t('projects.entry')} className="launcher-home-nav">
        {launcherLinks.map(({id, label, icon: Icon}) => <WorkbenchButton key={id} type="button" variant="ghost" className="launcher-home-nav-button"
          data-testid={`launcher-nav-${id}`} aria-label={label} title={label} aria-current={launcherPage === id ? 'page' : undefined}
          disabled={launcherNavigationLocked} onClick={() => navigateLauncher(id)}>
          <Icon size={17} aria-hidden="true" /><span>{label}</span>
        </WorkbenchButton>)}
      </nav>
      <div className="launcher-home-sidebar-footer">
        <div className="launcher-home-service" data-testid="launcher-service" data-service={launcher.service} role="status"
          title={t(`launcher.service.${launcher.service}`)}>
          <span className="launcher-home-service-dot" aria-hidden="true" />
          <span className="launcher-home-service-label">{t(`launcher.service.${launcher.service}`)}</span>
        </div>
        <WorkbenchButton type="button" variant="ghost" className="launcher-home-nav-button" data-testid="project-home-page-settings"
          aria-label={t('settings.title')} title={t('settings.title')} disabled={launcherNavigationLocked}
          onClick={() => { if (canNavigateLauncher()) onPage('settings'); }}>
          <WorkbenchIcon name="settings" size={17} /><span>{t('settings.title')}</span>
        </WorkbenchButton>
      </div>
    </aside>}
    {!launcher && <header className="project-home-header" data-text-selectable={false}>
      <div className="project-home-brand" aria-label="Mioon">Mioon</div>
      {onQuery && totalProjects > 0 && renderSearch(false)}
      <div className="project-home-header-spacer" />
      <Button type="button" variant="ghost" data-testid="project-home-page-projects" className="sr-only" onClick={() => { if (page !== 'projects') onPage('projects'); }}>{t('projects.list')}</Button>
      <WorkbenchButton type="button" variant="icon" className="project-home-help-button" data-testid="project-home-help" aria-label={t('redesign.shell.help')} title={t('redesign.shell.help')} disabled={locked || !active || page !== 'projects'} onClick={() => { if (current.current.active && current.current.page === 'projects' && !current.current.busy && !submissionPending.current && current.current.phase !== 'opening') changeHelp(true); }}><HelpSymbol /></WorkbenchButton>
      <Button type="button" variant="ghost" data-testid="project-home-page-settings" className="project-home-settings-button" aria-label={t('settings.title')} title={t('settings.title')} disabled={locked} onClick={() => { if (current.current.phase !== 'opening' && !current.current.busy) onPage('settings'); }}><WorkbenchIcon name="settings" /></Button>
      {totalProjects > 0 && onImport && <WorkbenchButton type="button" data-testid="project-home-import" disabled={locked} onClick={() => { if (canAct()) onImport(); }}><WorkbenchIcon name="upload" />{t('projectPackage.menu.import')}</WorkbenchButton>}
      {totalProjects > 0 && onStartExample && <WorkbenchButton type="button" data-testid="project-home-example" disabled={locked || !active} onClick={startExample}>{t('projectHomeNative.example')}</WorkbenchButton>}
      {totalProjects > 0 && <WorkbenchButton type="button" variant="primary" data-testid="project-home-create-toggle" disabled={locked || Boolean(createDisabledReason)} aria-expanded={createOpen} aria-controls={`${prefix}-create`} onClick={() => requestCreate(true)}><WorkbenchIcon name="plus" />{t('projects.createNew')}</WorkbenchButton>}
    </header>}
    {helpOpen && active && page === 'projects' && <Dialog open onOpenChange={changeHelp}><WorkbenchDialogContent title={t('redesign.shell.help')} className="project-home-help-dialog">
      {renderHelp('dialog')}
    </WorkbenchDialogContent></Dialog>}
    <div className="project-home-layout">
      {launcher && launcherPage === 'projects' && !launcher.empty && <header className="launcher-home-toolbar" data-testid="launcher-toolbar" data-text-selectable={false}>
        {onQuery && renderSearch(true)}
        {onStartExample && <WorkbenchButton type="button" data-testid="project-home-example" disabled={launcherNavigationLocked}
          onClick={() => startLauncherExample('projects')}><Clapperboard size={15} aria-hidden="true" />{t('projectHomeNative.example')}</WorkbenchButton>}
        {onOpenFile && <WorkbenchButton type="button" data-testid="project-home-open-file" disabled={launcherNavigationLocked}
          onClick={openLauncherFile}><FolderOpen size={15} aria-hidden="true" />{t('launcher.open')}</WorkbenchButton>}
        <WorkbenchButton type="button" variant="primary" data-testid="project-home-create-toggle" disabled={launcherNavigationLocked || Boolean(createDisabledReason)}
          onClick={createLauncherProject}><WorkbenchIcon name="plus" />{t('projects.createNew')}</WorkbenchButton>
      </header>}
      <main className="project-home-main" aria-labelledby={launcher && launcherPage !== 'projects' || !catalogContent ? `${prefix}-heading` : undefined}>
        {notice && <div className="project-home-notice" role="status">{renderMessage(notice)}</div>}
        {status && <div className="project-home-notice">{status}</div>}
        {phase === 'opening' && !deferOpeningFeedback && <section className="project-home-feedback" data-phase="opening" role="status" aria-live="polite" aria-busy="true">
          <div><strong>{openingName ? t('projects.openingNamed', { name: openingName }) : t('projects.opening')}</strong><p>{t('projects.loadingView')}</p></div>
        </section>}
        {pendingOpen && (!catalogVisible || !catalogContent) &&
          <PendingProjectOpenStatus pending={pendingOpen} name={projects.find(project => project.id === pendingOpen.projectId)?.name} />}
        {phase === 'error' && <section className="project-home-feedback" data-phase="error" role="alert">
          <div><strong>{openingName ? t('projects.failedNamed', { name: openingName }) : t('projects.openFailed')}</strong><p>{error ? renderMessage(error) : t('projects.openRetryHint')}</p></div>
          {page === 'projects' && <Button type="button" variant="outline" data-testid="project-home-retry" disabled={busy || submitting}
            onClick={() => { if (canAct() && current.current.phase === 'error') onRetry(); }}>{t('projects.retryOpen')}</Button>}
        </section>}
        {page === 'settings' ? <section className="project-home-settings" data-testid="project-home-settings">
          <header className="project-home-heading"><div><div className="project-home-eyebrow">{t('projects.workspace')}</div><h1 id={`${prefix}-heading`}>{t('settings.title')}</h1><p>{t('settings.scope')}</p></div></header>
          <div className="project-home-settings-body">{settings}</div>
        </section> : <>
          {!catalogContent && <header className="project-home-heading"><div><h1 id={`${prefix}-heading`}>{t('redesign.projects.all')} {totalProjects > 0 && <span className="project-home-total">{totalProjects}</span>}</h1></div>{totalProjects > 0 && <div className="project-home-toolbar">{toolbar}</div>}</header>}
          {createDisabledReason && <p className="project-home-notice" role="status" data-testid="project-home-create-disabled">{createDisabledReason}</p>}
          {createOpen && <Dialog open onOpenChange={open => { if (!open && canAct()) setCreateOpen(false); }}><WorkbenchDialogContent title={t('projects.createNew')} size="standard" className="project-home-create-dialog"><form id={`${prefix}-create`} className="project-home-create" data-testid="project-home-create-form" onSubmit={create} aria-labelledby={`${prefix}-create-heading`} aria-busy={busy || submitting}>
            <h2 className="sr-only" id={`${prefix}-create-heading`}>{t('projects.createNew')}</h2>
            <div className="project-home-field"><Label htmlFor={`${prefix}-name`}>{t('projects.name')}</Label>
              <Input id={`${prefix}-name`} data-testid="project-home-name" value={name} maxLength={150} required autoFocus disabled={locked || Boolean(createDisabledReason)}
                placeholder={t('projects.namePlaceholder')} aria-invalid={Boolean(formError) && !name.trim()} aria-describedby={formError ? `${prefix}-form-error` : undefined}
                onChange={event => { if (canAct() && !current.current.createDisabledReason) { publishCreate({ name: event.target.value }); setName(event.target.value); setFormError(''); } }} />
            </div>
            <div className="project-home-field"><Label htmlFor={`${prefix}-description`}>{t('projects.direction')}<span>{t('shell.optional')}</span></Label>
              <div className="project-home-direction"><Textarea id={`${prefix}-description`} data-testid="project-home-description" value={description} rows={2} maxLength={500} disabled={locked || Boolean(createDisabledReason)}
                placeholder={t('projects.directionPlaceholder')} onChange={event => { if (canAct() && !current.current.createDisabledReason) { publishCreate({ description: event.target.value }); setDescription(event.target.value); setFormError(''); } }} /><span className="project-home-direction-count" aria-hidden="true">{description.length} / 500</span></div>
            </div>
            <fieldset className="project-home-presets"><legend>{t('redesign.projects.format')}</legend>{([['portrait_1080', 'portrait', '9:16', '1080×1920'], ['landscape_1080', 'landscape', '16:9', '1920×1080'], ['square_1080', 'square', '1:1', '1080×1080']] as const).map(([value, label, ratio, dimensions]) => <label key={value} data-selected={timelinePresetId === value}><input type="radio" name={`${prefix}-preset`} value={value} checked={timelinePresetId === value} disabled={locked || Boolean(createDisabledReason)} onChange={() => { if (canAct() && !current.current.createDisabledReason) { publishCreate({ preset: value }); setTimelinePresetId(value); } }} /><FormatSymbol format={value} /><span>{t(`redesign.projects.${label}`)}</span><small>{ratio} · {dimensions}</small></label>)}</fieldset>
            <p className="project-home-format-help">{t('redesign.projects.formatHelp')}</p>
            {formError && <p id={`${prefix}-form-error`} className="project-home-form-error" role="alert">{renderMessage(formError)}</p>}
            <div className="project-home-form-actions">
              <WorkbenchButton type="button" size="large" data-testid="project-home-create-cancel" disabled={locked} onClick={() => { if (canAct()) setCreateOpen(false); }}>{t('shell.cancel')}</WorkbenchButton>
              <WorkbenchButton type="submit" variant="primary" size="large" data-testid="project-home-create-submit" disabled={locked || Boolean(createDisabledReason) || !name.trim()}>{busy || submitting ? t('projects.creating') : t('projects.create')}</WorkbenchButton>
            </div>
          </form></WorkbenchDialogContent></Dialog>}
          {launcher && <div className="launcher-home-projects" hidden={launcherPage !== 'projects'} inert={launcherPage !== 'projects'}>{catalogContent}</div>}
          {launcher && launcherPage === 'examples' && <section className="launcher-home-page" data-testid="launcher-examples">
            <h1 id={`${prefix}-heading`}>{t('launcher.examples')}</h1>
            {onStartExample ? <article className="launcher-home-example">
              <span className="launcher-home-action-icon"><Clapperboard size={24} aria-hidden="true" /></span>
              <div><h2>{t('projectHomeNative.example.name')}</h2><p>{t('projectHomeNative.example.description')}</p></div>
              <WorkbenchButton type="button" data-testid="launcher-example-start" disabled={launcherNavigationLocked}
                onClick={() => startLauncherExample('examples')}>{t('projectHomeNative.example')}</WorkbenchButton>
            </article> : <p role="status">{t('launcher.examplesUnavailable')}</p>}
          </section>}
          {launcher && launcherPage === 'help' && <section className="launcher-home-page" data-testid="launcher-help">
            <h1 id={`${prefix}-heading`}>{t('launcher.help')}</h1>
            {renderHelp('page')}
          </section>}
          {!launcher && (catalogContent ?? <section className={`project-home-catalog${empty ? ' project-home-catalog-empty' : ''}`} aria-labelledby={`${prefix}-heading`} aria-busy={listBusy}>
            {listError && <div className="project-home-list-header">
              <Button type="button" variant="ghost" data-testid={helpOpen ? undefined : 'project-home-refresh'} disabled={listBusy || locked || !active}
                onClick={() => { if (canRefresh()) onRefresh(); }}>{listBusy ? t('projects.refreshing') : t('projects.refreshList')}</Button>
            </div>}
            {listError && <p className="project-home-list-error" role="alert">{renderMessage(listError)}</p>}
            {listBusy && !projects.length && <p className="project-home-list-loading" role="status">{t('projects.loadingList')}</p>}
            {empty && <div className="project-home-empty" data-testid="project-home-empty">
              <span className="project-home-empty-symbol"><ProjectSymbol size={28} /></span><h2>{t('projects.emptyTitle')}</h2><p>{t('projects.emptyBody')}</p><WorkbenchButton type="button" variant="primary" size="large" data-testid="project-home-create-toggle" disabled={locked || Boolean(createDisabledReason)} aria-expanded={createOpen} aria-controls={`${prefix}-create`} onClick={() => requestCreate()}><WorkbenchIcon name="plus" />{t('projects.createNew')}</WorkbenchButton>
              {onImport && <WorkbenchButton type="button" variant="ghost" className="project-home-import-link" data-testid="project-home-import-empty" disabled={locked} onClick={() => { if (canAct()) onImport(); }}>{t('projectPackage.home.importLink')}</WorkbenchButton>}
            </div>}
            {projects.length > 0 && <ul className="project-home-list" data-testid="project-home-list">
              {projects.map(project => <li key={project.id}><article className="project-home-card">
                {projectMenu && <div className="project-home-card-menu">{projectMenu(project)}</div>}
                <Button type="button" variant="ghost" className="project-home-card-open" data-testid={`project-home-open-${project.id}`} aria-label={t('projects.openNamed', { name: project.name })} disabled={locked} onClick={() => { if (canAct()) onOpen(project.id); }}>
                  <span className="project-home-cover">{project.cover ? <img src={`/api/project-covers/${project.id}`} alt="" loading="lazy" /> : <ProjectSymbol size={32} />}{justImported.includes(project.id) ? <span className="project-home-just-imported" data-testid={`project-home-just-imported-${project.id}`}>{t('projectPackage.home.justImported')}</span> : project.lastOpenedAt && <span className="project-home-recent">{t('projects.recent')}</span>}{project.durationFrames !== undefined && <span className="project-home-duration">{Math.floor(project.durationFrames / (project.fps || 30) / 60).toString().padStart(2, '0')}:{Math.floor(project.durationFrames / (project.fps || 30) % 60).toString().padStart(2, '0')}</span>}</span>
                  <span className="project-home-card-title">{project.name}<small>{project.width && project.height ? project.width === project.height ? '1:1' : project.width > project.height ? '16:9' : '9:16' : ''}</small></span>
                  <span className="project-home-card-info">{project.shotCount !== undefined && <span>{t('redesign.projects.shots', { count: project.shotCount })} · </span>}<ProjectTime value={project.updatedAt} /></span>
                </Button>
              </article></li>)}
            </ul>}
          </section>)}
          {!launcher && totalProjects === 0 && !listBusy && !listError && onStartExample && <WorkbenchButton type="button" variant="ghost" className="project-home-import-link" data-testid="project-home-example" disabled={locked || !active} onClick={startExample}>{t('projectHomeNative.example')}</WorkbenchButton>}
          {!launcher && !catalogContent && !projects.length && totalProjects > 0 && <p className="project-home-empty" role="status">{t('redesign.projects.noResults')}</p>}
        </>}
      </main>
    </div>
  </div>;
}
