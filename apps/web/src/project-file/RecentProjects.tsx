import React, { useId, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Label } from '@mioon/ui/components/label';
import { WorkbenchSelect } from '@mioon/ui/components/workbench-select';
import { WorkbenchAlert, WorkbenchButton, WorkbenchEmptyState, WorkbenchTabs } from '@mioon/ui/components/workbench-controls';
import { Trash2, WorkbenchIcon } from '@mioon/ui/components/workbench-icons';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@mioon/ui/components/dropdown-menu';
import type { RecentProject } from '../../../../packages/contracts/src/project-registry.ts';
import { useI18n } from '../i18n/I18nProvider.tsx';
import Icon from '../icons.tsx';
import { aspectLabel, clockTime, displayPath, folderOf, lastSeenLabel } from './format.ts';
import { ProjectFileIcon } from './project-file-icons.tsx';
import type { HostPlatform, ProjectAvailabilityView, ViewState } from './types.ts';
import { useProjectFileDisplay } from './use-display.ts';
import { orderedRecentProjects, visibleWaitingProjects } from './recent-project-view.ts';
import type { RecentProjectsSort, WaitingProject } from './recent-project-view.ts';
export type { RecentProjectsSort, WaitingProject } from './recent-project-view.ts';
import './project-file-common.css';
import './project-file-home.css';

export interface RecentProjectItem {
  readonly project: RecentProject;
  readonly availability: ProjectAvailabilityView;
  /** Built by the server from `summary.cover`; null shows the placeholder. */
  readonly coverUrl: string | null;
}
export interface RecentProjectActions {
  readonly onOpen: (projectId: string) => void;
  readonly onLocate?: (projectId: string) => void;
  readonly onCopy?: (projectId: string) => void;
  readonly onReveal?: (projectId: string) => void;
  readonly onTrash?: (projectId: string) => void;
  readonly onForget?: (projectId: string) => void;
}
export type RecentProjectsLayout = 'grid' | 'list';
export interface RecentProjectsViewProps extends RecentProjectActions {
  readonly state: ViewState<readonly RecentProjectItem[]>;
  readonly sort: RecentProjectsSort;
  readonly onSortChange: (sort: RecentProjectsSort) => void;
  readonly view: RecentProjectsLayout;
  readonly onViewChange: (view: RecentProjectsLayout) => void;
  readonly now: Date;
  readonly nativeLayout?: boolean;
  readonly emptyContent?: ReactNode;
  readonly homeDirectory?: string | null;
  readonly query?: string;
  readonly busy?: boolean;
  readonly platform?: HostPlatform;
  /** Explicit host window ownership. Availability `open` can also be a task. */
  readonly openedProjectIds?: readonly string[];
  readonly waiting?: ViewState<readonly WaitingProject[]>;
  readonly onRetryWaiting?: () => void;
  readonly onAccessHelp?: (projectId: string) => void;
  readonly onRetry: () => void;
  readonly onCreate?: () => void;
  readonly onOpenFile?: () => void;
}
const SORTS: readonly RecentProjectsSort[] = ['recent', 'updated', 'name'];

/** Home page body: authoritative registrations and tasks waiting for
 * unavailable projects. The owner supplies only capabilities that really exist. */
export function RecentProjectsView(props: RecentProjectsViewProps): ReactElement {
  const { t, formatNumber, locale } = useI18n();
  const id = useId();
  const current = useRef(props); current.current = props;
  const { state, view } = props;
  const registered = state.kind === 'ready' ? state.value : [];
  const items = orderedRecentProjects(registered, props.query ?? '', props.sort, locale);
  const latest = orderedRecentProjects(registered, '', 'recent', locale).find(item => item.project.lastOpenedAt !== null);
  const waiting = props.waiting?.kind === 'ready' ? props.waiting.value : [];
  const waitingById = new Map(waiting.map(entry => [entry.projectId, entry]));
  const customEmpty = props.nativeLayout && state.kind === 'ready' && registered.length === 0 && props.emptyContent != null;
  const layouts: readonly RecentProjectsLayout[] = props.nativeLayout ? ['list', 'grid'] : ['grid', 'list'];
  return <section className="pf-home" data-native-layout={props.nativeLayout || undefined} data-state={state.kind} data-testid="pf-recent-projects" aria-labelledby={customEmpty ? undefined : `${id}-title`}>
    {!customEmpty && <header className="pf-home-heading">
      <h1 id={`${id}-title`}>{t('projectFile.home.title')}</h1>
      {registered.length > 0 && <span className="pf-count">{formatNumber(registered.length)}</span>}
      {registered.length > 0 && <div className="pf-home-toolbar">
        <Label htmlFor={`${id}-sort`} className="pf-home-sort-label">{t('redesign.projects.sort')}</Label>
        <WorkbenchSelect id={`${id}-sort`} className="pf-home-sort" value={props.sort} disabled={props.busy} onChange={event => { const next = SORTS.find(sort => sort === event.target.value); if (next && !current.current.busy) current.current.onSortChange(next); }}>
          <option value="recent">{t('redesign.projects.recent')}</option><option value="updated">{t('redesign.projects.updated')}</option><option value="name">{t('redesign.projects.name')}</option>
        </WorkbenchSelect>
        <WorkbenchTabs value={view} label={t('projectFile.home.layout')} onValueChange={value => { if (!current.current.busy && (value === 'grid' || value === 'list')) current.current.onViewChange(value); }} options={layouts.map(value => {
          const label = t(`redesign.projects.${value}`);
          return {value, disabled: props.busy, testId: `pf-home-view-${value}`,
            label: <span title={label} aria-label={label}>{value === 'list' ? <WorkbenchIcon name="list" size={14} /> : <Icon name="grid" size={14} />}</span>};
        })} />
      </div>}
    </header>}
    {props.waiting?.kind === 'ready' && <ProjectWaitingNotice entries={waiting} busy={props.busy} onOpen={props.onOpen} onLocate={props.onLocate} onReveal={props.onReveal} onAccessHelp={props.onAccessHelp} platform={props.platform} />}
    {props.waiting?.kind === 'error' && <WorkbenchAlert tone="warning" data-testid="pf-waiting-error" actions={props.waiting.retryable && props.onRetryWaiting ? <WorkbenchButton size="compact" disabled={props.busy} onClick={() => { if (!current.current.busy) current.current.onRetryWaiting?.(); }}>{t('projectFile.common.retry')}</WorkbenchButton> : undefined}>{t('projectFile.home.waitingUnavailable')}</WorkbenchAlert>}
    {state.kind === 'loading' && <div className="pf-home-grid" data-layout={view} role="status" data-testid="pf-home-loading">
      <span className="pf-visually-hidden">{t('projectFile.home.loading')}</span>
      {[0, 1, 2, 3].map(index => <div key={index} className="pf-card pf-card-skeleton" aria-hidden="true"><span className="pf-card-cover" /><span className="pf-skeleton-line" /><span className="pf-skeleton-line pf-skeleton-short" /></div>)}
    </div>}
    {state.kind === 'error' && <WorkbenchAlert tone="danger" className="pf-home-error" data-testid="pf-home-error" icon={<WorkbenchIcon name="warning" size={16} />}
      actions={state.retryable ? <WorkbenchButton size="compact" disabled={props.busy} data-testid="pf-home-retry" onClick={() => { if (!current.current.busy) current.current.onRetry(); }}>{t('projectFile.common.retry')}</WorkbenchButton> : undefined}>
      <strong>{t('projectFile.home.error')}</strong> {t('projectFile.home.errorBody')}
    </WorkbenchAlert>}
    {customEmpty && <div data-testid="pf-home-empty">{props.emptyContent}</div>}
    {!customEmpty && state.kind === 'ready' && registered.length === 0 && <WorkbenchEmptyState className="pf-home-empty" data-testid="pf-home-empty" icon={<Icon name="folder" size={20} />}
      title={t('projectFile.home.emptyTitle')} description={t('projectFile.home.emptyBody')}
      actions={(props.onOpenFile || props.onCreate) && <>
        {props.onOpenFile && <WorkbenchButton disabled={props.busy} data-testid="pf-home-open-file" onClick={() => { if (!current.current.busy) current.current.onOpenFile?.(); }}><Icon name="folder" size={14} />{t('projectFile.home.open')}</WorkbenchButton>}
        {props.onCreate && <WorkbenchButton disabled={props.busy} variant="primary" data-testid="pf-home-create" onClick={() => { if (!current.current.busy) current.current.onCreate?.(); }}><WorkbenchIcon name="plus" size={14} />{t('projectFile.home.create')}</WorkbenchButton>}
      </>} />}
    {state.kind === 'ready' && registered.length > 0 && items.length === 0 && <WorkbenchEmptyState className="pf-home-empty" data-testid="pf-home-no-matches" icon={<Icon name="search" size={20} />} title={t('projectFile.home.noMatches')} />}
    {items.length > 0 && <ul className="pf-home-grid" data-layout={view} data-testid="pf-home-list">
      {items.map(item => <li key={item.project.projectId}><RecentProjectCard {...props} item={item} latest={item === latest} layout={view} waitingProject={waitingById.get(item.project.projectId)} waitingKnown={props.waiting?.kind === 'ready'} openedInWindow={props.openedProjectIds?.includes(item.project.projectId) === true} /></li>)}
    </ul>}
  </section>;
}

export interface RecentProjectCardProps extends RecentProjectActions {
  readonly item: RecentProjectItem;
  /** The most recently opened project gets the "Last opened" tag. */
  readonly latest: boolean;
  readonly sort: RecentProjectsSort;
  readonly layout: RecentProjectsLayout;
  readonly now: Date;
  readonly nativeLayout?: boolean;
  readonly homeDirectory?: string | null;
  readonly busy?: boolean;
  readonly platform?: HostPlatform;
  readonly waitingProject?: WaitingProject;
  readonly waitingKnown?: boolean;
  readonly openedInWindow?: boolean;
}
export function RecentProjectCard(props: RecentProjectCardProps): ReactElement {
  const { item, latest, sort, layout, now, homeDirectory, onLocate, waitingProject, nativeLayout, busy = false } = props;
  const { t } = useI18n();
  const display = useProjectFileDisplay();
  const current = useRef(props); current.current = props;
  const { project, availability, coverUrl } = item, summary = project.summary;
  const missing = availability.state === 'missing';
  const nativeList = nativeLayout && layout === 'list';
  const nativeGrid = nativeLayout && layout === 'grid';
  const when = sort === 'updated' ? summary?.updatedAt ?? project.lastOpenedAt : project.lastOpenedAt ?? summary?.updatedAt;
  const date = when && <span>{display.when(when, now)}</span>;
  const aspect = summary && <span className="pf-card-aspect">{aspectLabel(summary.width, summary.height)}</span>;
  const duration = summary && <span className="pf-card-duration">{clockTime(summary.durationFrames, summary.fps)}</span>;
  const folder = <span>{displayPath(folderOf(project.projectFile), homeDirectory)}</span>;
  const meta = missing
    ? <><span className="pf-card-status">{t('projectFile.home.missing')}</span>{!nativeGrid && <span>{t('projectFile.home.lastSeen', { place: lastSeenLabel(project.projectFile, homeDirectory) })}</span>}</>
    : availability.state === 'locked' ? <>{folder}<span className="pf-card-status" data-tone="warning">{t('projectFile.home.locked')}</span></>
      : availability.state === 'invalid' ? <><span className="pf-card-status" data-tone={availability.reason === 'read-only' ? 'warning' : 'danger'}>{t(availability.reason === 'read-only' ? 'projectFile.home.readOnly' : 'projectFile.home.invalid')}</span>{folder}</>
        : nativeGrid ? <>{date}{aspect}</> : <>{folder}{!nativeList && date}</>;
  const metaTone = missing ? 'danger' : availability.state === 'invalid' && availability.reason === 'read-only' ? 'warning' : undefined;
  const locate = missing && onLocate && <WorkbenchButton variant="ghost" size="compact" disabled={busy} className="pf-card-locate" data-testid={`pf-card-locate-${project.projectId}`} onClick={() => { if (!current.current.busy && current.current.item.project.projectId === project.projectId) current.current.onLocate?.(project.projectId); }}>{t('projectFile.home.locate')}</WorkbenchButton>;
  const waiting = waitingProject && <div className="pf-card-waiting" data-testid={`pf-card-waiting-${project.projectId}`}>{t('projectFile.home.waitingCard', {count: waitingProject.taskCount})}</div>;
  const metadata = <div className="pf-card-meta" data-tone={metaTone}>{meta}</div>;
  const title = <>
    <span className="pf-card-name">{project.name}</span>
    {latest && layout === 'list' && <span className="pf-card-tag" data-inline><span className="pf-dot" aria-hidden="true" />{t('projectFile.home.recentlyOpened')}</span>}
  </>;
  return <article className="pf-card" data-availability={availability.state} data-layout={layout} data-testid={`pf-card-${project.projectId}`}>
    <WorkbenchButton variant="ghost" className="pf-card-open" disabled={busy} data-testid={`pf-card-open-${project.projectId}`} aria-label={t('projectFile.home.openNamed', { name: project.name })} onClick={() => { if (!current.current.busy && current.current.item.project.projectId === project.projectId) current.current.onOpen(project.projectId); }}>
      <span className="pf-card-cover">
        <ProjectCover key={coverUrl} coverUrl={coverUrl} projectId={project.projectId} />
        {latest && layout === 'grid' && <span className="pf-card-tag"><span className="pf-dot" aria-hidden="true" />{t('projectFile.home.recentlyOpened')}</span>}
        {!nativeList && duration}
      </span>
      {nativeList && <span className="pf-card-body">
        <span className="pf-card-title">{title}</span>
        <span className="pf-card-meta" data-tone={metaTone}>{meta}</span>
      </span>}
    </WorkbenchButton>
    <RecentProjectMenu {...props} />
    {nativeList ? <div className="pf-card-list-details">
      {missing ? waiting : (summary || when) && <div className="pf-card-list-info">{aspect}{duration}{date}</div>}
      {missing ? locate : waiting}
    </div> : <div className="pf-card-body">
      <div className="pf-card-title">{title}{!nativeGrid && (missing ? locate : aspect)}</div>
      {nativeGrid ? <div className="pf-card-grid-meta">{metadata}{locate}</div> : metadata}
      {waiting}
    </div>}
  </article>;
}

/** A failed cached image never triggers an open or a second content request. */
export function ProjectCover({coverUrl, projectId}: {readonly coverUrl: string | null; readonly projectId: string}): ReactElement {
  const [failed, setFailed] = useState(false);
  return coverUrl && !failed ? <img src={coverUrl} alt="" loading="lazy" onError={() => setFailed(true)} />
    : <span className="pf-card-placeholder" data-testid={`pf-card-placeholder-${projectId}`}><Icon name="film" size={28} /></span>;
}

interface RecentProjectMenuProps extends RecentProjectActions {
  readonly item: RecentProjectItem;
  readonly busy?: boolean;
  readonly platform?: HostPlatform;
  readonly openedInWindow?: boolean;
  readonly waitingProject?: WaitingProject;
  readonly waitingKnown?: boolean;
  readonly open?: boolean;
}
export function RecentProjectMenu(props: RecentProjectMenuProps): ReactElement | null {
  const {t} = useI18n(), {project, availability} = props.item;
  const missing = availability.state === 'missing', blocked = props.busy === true;
  const current = useRef(props); current.current = props;
  const invoke = (name: keyof RecentProjectActions) => () => {
    const next = current.current;
    if (next.busy || next.item.project.projectId !== project.projectId) return;
    if ((name === 'onCopy' || name === 'onTrash') && (next.openedInWindow || next.item.availability.state === 'missing')) return;
    if (name === 'onForget' && (next.item.availability.state !== 'missing' || !next.waitingKnown || next.waitingProject)) return;
    if (name === 'onLocate' && next.item.availability.state !== 'missing') return;
    next[name]?.(project.projectId);
  };
  const needsClose = props.openedInWindow === true;
  const forgetDisabled = !props.waitingKnown || Boolean(props.waitingProject);
  const forgetHelp = props.waitingProject ? t('projectFile.home.menu.waitingHelp') : !props.waitingKnown ? t('projectFile.home.waitingUnavailable') : undefined;
  if (missing && !props.onLocate && !props.onForget) return null;
  return <DropdownMenu open={props.open}><DropdownMenuTrigger render={<WorkbenchButton variant="icon" className="pf-card-menu-trigger" data-testid={`pf-card-menu-${project.projectId}`} disabled={blocked} aria-label={t('projectFile.home.menu.label', {name: project.name})} />}><WorkbenchIcon name="more" size={16} /></DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="pf-card-menu">
      {!missing && <DropdownMenuItem data-testid={`pf-menu-open-${project.projectId}`} disabled={blocked} onClick={invoke('onOpen')}><Icon name="folder" size={16} />{t('projectFile.home.menu.open')}</DropdownMenuItem>}
      {missing && props.onLocate && <DropdownMenuItem data-testid={`pf-menu-locate-${project.projectId}`} disabled={blocked} onClick={invoke('onLocate')}><ProjectFileIcon name="folderSearch" />{t('projectFile.home.locate')}</DropdownMenuItem>}
      {!missing && props.onCopy && <DropdownMenuItem data-testid={`pf-menu-copy-${project.projectId}`} disabled={blocked || needsClose} title={needsClose ? t('projectFile.home.menu.closeHelp') : undefined} onClick={invoke('onCopy')}><ProjectFileIcon name="copy" />{t('projectFile.home.menu.copy')}</DropdownMenuItem>}
      {!missing && props.onReveal && <DropdownMenuItem data-testid={`pf-menu-reveal-${project.projectId}`} disabled={blocked} onClick={invoke('onReveal')}><Icon name="folder" size={16} />{t(props.platform === 'mac' ? 'projectFile.home.menu.revealMac' : 'projectFile.home.menu.reveal')}</DropdownMenuItem>}
      {!missing && props.onTrash && <><DropdownMenuSeparator /><DropdownMenuItem variant="destructive" data-testid={`pf-menu-trash-${project.projectId}`} disabled={blocked || needsClose} title={needsClose ? t('projectFile.home.menu.closeHelp') : undefined} onClick={invoke('onTrash')}><Trash2 size={16} />{t('projectFile.home.menu.trash')}</DropdownMenuItem></>}
      {missing && props.onForget && <DropdownMenuItem data-testid={`pf-menu-forget-${project.projectId}`} disabled={blocked || forgetDisabled} title={forgetHelp} onClick={invoke('onForget')}><Icon name="minus" size={16} />{t('projectFile.home.menu.forget')}</DropdownMenuItem>}
    </DropdownMenuContent>
  </DropdownMenu>;
}

interface ProjectWaitingNoticeProps extends Pick<RecentProjectActions, 'onOpen' | 'onLocate' | 'onReveal'> {
  readonly entries: readonly WaitingProject[];
  readonly platform?: HostPlatform;
  readonly busy?: boolean;
  readonly onAccessHelp?: (projectId: string) => void;
}
export function ProjectWaitingNotice(props: ProjectWaitingNoticeProps): ReactElement | null {
  const {entries, onOpen, onLocate, onReveal, onAccessHelp, platform = 'web', busy = false} = props;
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const current = useRef(props); current.current = props;
  if (entries.length === 0) return null;
  const {shown, remaining} = visibleWaitingProjects(entries, expanded);
  return <section className="pf-waiting" aria-label={t('projectFile.home.waitingLabel')} data-testid="pf-waiting">
    <ul className="pf-inbox">{shown.map(entry => {
      const missing = entry.reason === 'missing' || entry.reason === 'missing-volume';
      const action = missing ? onLocate : entry.reason === 'read-only' ? onReveal : entry.reason === 'access-denied' ? onAccessHelp : onOpen;
      const label = missing ? t('projectFile.home.locateProject') : entry.reason === 'read-only' ? t(platform === 'mac' ? 'projectFile.home.menu.revealMac' : 'projectFile.home.menu.reveal') : entry.reason === 'access-denied' ? t('projectFile.home.waitingHelp') : t(entry.reason === 'locked' ? 'projectFile.home.waitingOpen' : 'projectFile.home.waitingReason');
      const text = entry.reason === 'missing-volume' ? t('projectFile.home.waitingVolume', {count: entry.taskCount, name: entry.projectName, volume: entry.volumeName ?? ''})
        : t(entry.reason === 'missing' ? 'projectFile.home.waitingMissing' : entry.reason === 'read-only' ? 'projectFile.home.waitingReadOnly' : entry.reason === 'locked' ? 'projectFile.home.waitingLocked' : entry.reason === 'access-denied' ? 'projectFile.home.waitingAccess' : 'projectFile.home.waitingOther', {count: entry.taskCount, name: entry.projectName});
      return <li key={entry.projectId} data-testid={`pf-waiting-${entry.projectId}`}>
      <ProjectFileIcon name="inbox" size={16} className="pf-inbox-icon" />
      <span className="pf-inbox-text">{text}</span>
      {action && <WorkbenchButton size="compact" disabled={busy} className="pf-inbox-locate" data-testid={`pf-waiting-action-${entry.projectId}`} onClick={() => {
        const next = current.current, project = next.entries.find(item => item.projectId === entry.projectId);
        if (next.busy || !project || project.reason !== entry.reason) return;
        const run = missing ? next.onLocate : project.reason === 'read-only' ? next.onReveal : project.reason === 'access-denied' ? next.onAccessHelp : next.onOpen;
        run?.(project.projectId);
      }}>{label}</WorkbenchButton>}
    </li>;})}
      {remaining > 0 && <li data-testid="pf-waiting-more"><ProjectFileIcon name="inbox" size={16} className="pf-inbox-icon" /><span className="pf-inbox-text">{t('projectFile.home.waitingMore', {count: remaining})}</span><WorkbenchButton size="compact" disabled={busy} data-testid="pf-waiting-show-all" onClick={() => { if (!current.current.busy) setExpanded(true); }}><Icon name="down" size={14} />{t('projectFile.home.waitingShowAll')}</WorkbenchButton></li>}
    </ul>
    <p className="pf-waiting-retention">{t('projectFile.home.waitingRetention')}</p>
  </section>;
}
