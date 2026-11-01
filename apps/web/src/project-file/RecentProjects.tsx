import React, { useId } from 'react';
import type { ReactElement } from 'react';
import { Label } from '@mioon/ui/components/label';
import { WorkbenchSelect } from '@mioon/ui/components/workbench-select';
import { WorkbenchAlert, WorkbenchButton, WorkbenchEmptyState, WorkbenchTabs } from '@mioon/ui/components/workbench-controls';
import { WorkbenchIcon } from '@mioon/ui/components/workbench-icons';
import type { RecentProject } from '../../../../packages/contracts/src/project-registry.ts';
import { useI18n } from '../i18n/I18nProvider.tsx';
import Icon from '../icons.tsx';
import { aspectLabel, clockTime, displayPath, folderOf, lastSeenLabel } from './format.ts';
import { ProjectFileIcon } from './project-file-icons.tsx';
import type { ProjectAvailabilityView, ViewState } from './types.ts';
import { useProjectFileDisplay } from './use-display.ts';
import './project-file-common.css';
import './project-file-home.css';

export interface RecentProjectItem {
  readonly project: RecentProject;
  readonly availability: ProjectAvailabilityView;
  /** Built by the server from `summary.cover`; null shows the placeholder. */
  readonly coverUrl: string | null;
}
/** Results waiting in the inbox for one project (`ProjectInboxItem`s grouped by project). */
export interface InboxEntry {
  readonly projectId: string;
  readonly projectName: string;
  readonly count: number;
  readonly availability: ProjectAvailabilityView;
}
export type RecentProjectsSort = 'recent' | 'updated' | 'name';
export type RecentProjectsLayout = 'grid' | 'list';
export interface RecentProjectsViewProps {
  /** Shown in the given order; the caller sorts by `sort`. */
  readonly state: ViewState<readonly RecentProjectItem[]>;
  readonly sort: RecentProjectsSort;
  readonly onSortChange: (sort: RecentProjectsSort) => void;
  readonly view: RecentProjectsLayout;
  readonly onViewChange: (view: RecentProjectsLayout) => void;
  readonly now: Date;
  readonly homeDirectory?: string | null;
  readonly inbox?: readonly InboxEntry[];
  readonly onOpen: (projectId: string) => void;
  readonly onLocate: (projectId: string) => void;
  readonly onRetry: () => void;
  readonly onCreate?: () => void;
  readonly onOpenFile?: () => void;
}
const SORTS: readonly RecentProjectsSort[] = ['recent', 'updated', 'name'];

/** Home page body (12-01): recent projects, missing project cards and the inbox notice. */
export function RecentProjectsView(props: RecentProjectsViewProps): ReactElement {
  const { t, formatNumber } = useI18n();
  const id = useId();
  const { state, view } = props;
  const items = state.kind === 'ready' ? state.value : [];
  const latest = items.reduce<RecentProjectItem | null>((best, item) => item.project.lastOpenedAt && (!best?.project.lastOpenedAt || item.project.lastOpenedAt > best.project.lastOpenedAt) ? item : best, null);
  return <section className="pf-home" data-state={state.kind} data-testid="pf-recent-projects" aria-labelledby={`${id}-title`}>
    <header className="pf-home-heading">
      <h1 id={`${id}-title`}>{t('projectFile.home.title')}</h1>
      {items.length > 0 && <span className="pf-count">{formatNumber(items.length)}</span>}
      {items.length > 0 && <div className="pf-home-toolbar">
        <Label htmlFor={`${id}-sort`} className="pf-home-sort-label">{t('redesign.projects.sort')}</Label>
        <WorkbenchSelect id={`${id}-sort`} className="pf-home-sort" value={props.sort} onChange={event => { const next = SORTS.find(sort => sort === event.target.value); if (next) props.onSortChange(next); }}>
          <option value="recent">{t('redesign.projects.recent')}</option><option value="updated">{t('redesign.projects.updated')}</option><option value="name">{t('redesign.projects.name')}</option>
        </WorkbenchSelect>
        <WorkbenchTabs value={view} label={t('projectFile.home.layout')} onValueChange={value => { if (value === 'grid' || value === 'list') props.onViewChange(value); }} options={[
          { value: 'grid', label: <span title={t('redesign.projects.grid')} aria-label={t('redesign.projects.grid')}><Icon name="grid" size={14} /></span>, testId: 'pf-home-view-grid' },
          { value: 'list', label: <span title={t('redesign.projects.list')} aria-label={t('redesign.projects.list')}><WorkbenchIcon name="list" size={14} /></span>, testId: 'pf-home-view-list' },
        ]} />
      </div>}
    </header>
    {props.inbox && <ProjectInboxNotice entries={props.inbox} onLocate={props.onLocate} />}
    {state.kind === 'loading' && <div className="pf-home-grid" data-layout={view} role="status" data-testid="pf-home-loading">
      <span className="pf-visually-hidden">{t('projectFile.home.loading')}</span>
      {[0, 1, 2, 3].map(index => <div key={index} className="pf-card pf-card-skeleton" aria-hidden="true"><span className="pf-card-cover" /><span className="pf-skeleton-line" /><span className="pf-skeleton-line pf-skeleton-short" /></div>)}
    </div>}
    {state.kind === 'error' && <WorkbenchAlert tone="danger" className="pf-home-error" data-testid="pf-home-error" icon={<WorkbenchIcon name="warning" size={16} />}
      actions={state.retryable ? <WorkbenchButton size="compact" data-testid="pf-home-retry" onClick={props.onRetry}>{t('projectFile.common.retry')}</WorkbenchButton> : undefined}>
      <strong>{t('projectFile.home.error')}</strong> {t('projectFile.home.errorBody')}
    </WorkbenchAlert>}
    {state.kind === 'ready' && items.length === 0 && <WorkbenchEmptyState className="pf-home-empty" data-testid="pf-home-empty" icon={<Icon name="folder" size={20} />}
      title={t('projectFile.home.emptyTitle')} description={t('projectFile.home.emptyBody')}
      actions={(props.onOpenFile || props.onCreate) && <>
        {props.onOpenFile && <WorkbenchButton data-testid="pf-home-open-file" onClick={props.onOpenFile}><Icon name="folder" size={14} />{t('projectFile.home.open')}</WorkbenchButton>}
        {props.onCreate && <WorkbenchButton variant="primary" data-testid="pf-home-create" onClick={props.onCreate}><WorkbenchIcon name="plus" size={14} />{t('projectFile.home.create')}</WorkbenchButton>}
      </>} />}
    {items.length > 0 && <ul className="pf-home-grid" data-layout={view} data-testid="pf-home-list">
      {items.map(item => <li key={item.project.projectId}><RecentProjectCard item={item} latest={item === latest} sort={props.sort} layout={view} now={props.now} homeDirectory={props.homeDirectory} onOpen={props.onOpen} onLocate={props.onLocate} /></li>)}
    </ul>}
  </section>;
}

export interface RecentProjectCardProps {
  readonly item: RecentProjectItem;
  /** The most recently opened project gets the "Last opened" tag. */
  readonly latest: boolean;
  readonly sort: RecentProjectsSort;
  readonly layout: RecentProjectsLayout;
  readonly now: Date;
  readonly homeDirectory?: string | null;
  readonly onOpen: (projectId: string) => void;
  readonly onLocate: (projectId: string) => void;
}
export function RecentProjectCard({ item, latest, sort, layout, now, homeDirectory, onOpen, onLocate }: RecentProjectCardProps): ReactElement {
  const { t } = useI18n();
  const display = useProjectFileDisplay();
  const { project, availability, coverUrl } = item, summary = project.summary;
  const missing = availability.state === 'missing';
  const when = sort === 'updated' ? summary?.updatedAt ?? project.lastOpenedAt : project.lastOpenedAt ?? summary?.updatedAt;
  const folder = <span>{displayPath(folderOf(project.projectFile), homeDirectory)}</span>;
  const meta = missing
    ? <><span>{t('projectFile.home.missing')}</span><span>{t('projectFile.home.lastSeen', { place: lastSeenLabel(project.projectFile, homeDirectory) })}</span></>
    : availability.state === 'locked' ? <>{folder}<span className="pf-card-status" data-tone="warning">{t('projectFile.home.locked')}</span></>
      : availability.state === 'invalid' ? <>{folder}<span className="pf-card-status" data-tone={availability.reason === 'read-only' ? 'warning' : 'danger'}>{t(availability.reason === 'read-only' ? 'projectFile.home.readOnly' : 'projectFile.home.invalid')}</span></>
        : <>{folder}{when && <span>{display.when(when, now)}</span>}</>;
  return <article className="pf-card" data-availability={availability.state} data-layout={layout} data-testid={`pf-card-${project.projectId}`}>
    <WorkbenchButton variant="ghost" className="pf-card-open" data-testid={`pf-card-open-${project.projectId}`} aria-label={t('projectFile.home.openNamed', { name: project.name })} onClick={() => onOpen(project.projectId)}>
      <span className="pf-card-cover">
        {coverUrl ? <img src={coverUrl} alt="" loading="lazy" /> : <span className="pf-card-placeholder"><Icon name="film" size={28} /></span>}
        {latest && layout === 'grid' && <span className="pf-card-tag"><span className="pf-dot" aria-hidden="true" />{t('projectFile.home.recentlyOpened')}</span>}
        {summary && <span className="pf-card-duration">{clockTime(summary.durationFrames, summary.fps)}</span>}
      </span>
    </WorkbenchButton>
    <div className="pf-card-body">
      <div className="pf-card-title">
        <span className="pf-card-name">{project.name}</span>
        {latest && layout === 'list' && <span className="pf-card-tag" data-inline><span className="pf-dot" aria-hidden="true" />{t('projectFile.home.recentlyOpened')}</span>}
        {missing
          ? <WorkbenchButton variant="ghost" size="compact" className="pf-card-locate" data-testid={`pf-card-locate-${project.projectId}`} onClick={() => onLocate(project.projectId)}>{t('projectFile.home.locate')}</WorkbenchButton>
          : summary && <span className="pf-card-aspect">{aspectLabel(summary.width, summary.height)}</span>}
      </div>
      <div className="pf-card-meta" data-tone={missing ? 'danger' : undefined}>{meta}</div>
    </div>
  </article>;
}

/** Inbox notice above the cards (12-01). One line per project, at most three. */
export function ProjectInboxNotice({ entries, onLocate }: { readonly entries: readonly InboxEntry[]; readonly onLocate: (projectId: string) => void }): ReactElement | null {
  const { t } = useI18n();
  if (entries.length === 0) return null;
  const shown = entries.slice(0, 3), more = entries.length - shown.length;
  return <section className="pf-inbox" aria-label={t('projectFile.home.inboxLabel')} data-testid="pf-inbox">
    <ul>{shown.map(entry => <li key={entry.projectId}>
      <ProjectFileIcon name="inbox" size={16} className="pf-inbox-icon" />
      <span className="pf-inbox-text">{t(entry.availability.state === 'missing' ? 'projectFile.home.inboxMissing' : 'projectFile.home.inboxWaiting', { count: entry.count, name: entry.projectName })}</span>
      {entry.availability.state === 'missing' && <WorkbenchButton size="compact" className="pf-inbox-locate" data-testid={`pf-inbox-locate-${entry.projectId}`} onClick={() => onLocate(entry.projectId)}><ProjectFileIcon name="folderSearch" size={14} />{t('projectFile.home.locateProject')}</WorkbenchButton>}
    </li>)}</ul>
    {more > 0 && <p className="pf-inbox-more">{t('projectFile.home.inboxMore', { count: more })}</p>}
  </section>;
}
