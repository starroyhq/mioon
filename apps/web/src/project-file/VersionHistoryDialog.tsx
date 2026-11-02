import React from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Dialog } from '@mioon/ui/components/dialog';
import { WorkbenchAlert, WorkbenchBadge, WorkbenchButton, WorkbenchDialogContent } from '@mioon/ui/components/workbench-controls';
import { Clapperboard, Film, Image, Info, Layers, RotateCcw, Sparkles, User } from '@mioon/ui/components/workbench-icons';
import type { ProjectVersionSummary } from '../../../../packages/contracts/src/project-versions.ts';
import type { MessageDescriptor } from '../../../../packages/i18n/src/index.ts';
import { useI18n } from '../i18n/I18nProvider.tsx';
import { dayBucket, sameYear } from './format.ts';
import { ProjectFileIcon } from './project-file-icons.tsx';
import type { ViewState } from './types.ts';
import { useProjectFileDisplay } from './use-display.ts';
import './project-file-common.css';
import './project-file-versions.css';

/** A version as the screens show it. The contract has neither the Mio round
 * nor the conversation; V1 or U2 adds them (see the PR). */
export interface ProjectVersionItem {
  readonly summary: ProjectVersionSummary;
  /** The Mio round a mio-turn version was saved before, counted within its conversation. */
  readonly mioTurn?: number;
  readonly conversationTitle?: string;
}
export type VersionComparisonArea = 'timeline' | 'shots' | 'subtitles' | 'assets' | 'subjects';
/** One area of "compared with current"; each detail is a sentence of the comparison. */
export interface VersionComparisonGroup {
  readonly area: VersionComparisonArea;
  readonly details: readonly MessageDescriptor[];
}
/** `selected` value of the current, unsaved content. */
export const CURRENT_VERSION = 'current';
export interface VersionHistoryDialogProps {
  readonly open: boolean;
  readonly projectName: string;
  readonly now: Date;
  /** Newest first. */
  readonly versions: ViewState<readonly ProjectVersionItem[]>;
  /** A version ID or CURRENT_VERSION. */
  readonly selected: string;
  readonly onSelect: (id: string) => void;
  /** The selected version compared with the current content. */
  readonly comparison: ViewState<readonly VersionComparisonGroup[]>;
  /** How many automatic versions are kept (V1). */
  readonly retention: { readonly recent: number; readonly days: number };
  readonly onSaveVersion?: () => void;
  readonly onCompare?: () => void;
  readonly onRestore: () => void;
  readonly onRetry: () => void;
  readonly onRetryComparison: () => void;
  readonly onClose: () => void;
}
type Translate = ReturnType<typeof useI18n>['t'];

/** The name a version goes by in the list, the detail and the restore confirmation. */
export function versionTitle(t: Translate, item: ProjectVersionItem, now: Date): string {
  const { summary } = item;
  switch (summary.trigger) {
    case 'manual': return summary.name ?? t('projectFile.versions.manualUnnamed');
    case 'mio-turn': return item.mioTurn === undefined ? t('projectFile.versions.mioTurnUnknown') : t('projectFile.versions.mioTurn', { turn: item.mioTurn });
    case 'daily-open': {
      const day = dayBucket(summary.createdAt, now);
      return t(day === 'today' ? 'projectFile.versions.dailyOpenToday' : day === 'yesterday' ? 'projectFile.versions.dailyOpenYesterday' : 'projectFile.versions.dailyOpen');
    }
    case 'restore': return t('projectFile.versions.beforeRestore');
    case 'bulk-change': return t('projectFile.versions.beforeBulkChange');
  }
}
const TRIGGER_ICONS: Readonly<Record<ProjectVersionSummary['trigger'], ReactElement>> = {
  manual: <ProjectFileIcon name="bookmark" />, 'mio-turn': <Sparkles size={16} aria-hidden="true" />, 'daily-open': <ProjectFileIcon name="calendar" />,
  restore: <RotateCcw size={16} aria-hidden="true" />, 'bulk-change': <Layers size={16} aria-hidden="true" />,
};
const AREA_ICONS: Readonly<Record<VersionComparisonArea, ReactElement>> = {
  timeline: <Film size={16} aria-hidden="true" />, shots: <Clapperboard size={16} aria-hidden="true" />, subtitles: <ProjectFileIcon name="captions" />,
  assets: <Image size={16} aria-hidden="true" />, subjects: <User size={16} aria-hidden="true" />,
};
/** Areas are named like the objects of Mio's change cards. */
const AREA_KINDS = { timeline: 'timeline', shots: 'shot', subtitles: 'timeline_subtitle', assets: 'asset', subjects: 'subject' } as const satisfies Record<VersionComparisonArea, string>;

/** Version history (12-08): versions by day on the left, the selected one compared with current on the right. */
export function VersionHistoryDialog(props: VersionHistoryDialogProps): ReactElement {
  const { t, formatDate, renderMessage } = useI18n();
  const display = useProjectFileDisplay();
  const { versions, comparison, now } = props;
  const list = versions.kind === 'ready' ? versions.value : [];
  const chosen = list.find(item => item.summary.id === props.selected) ?? null;
  const isCurrent = chosen === null;
  // Days in local time; "current" heads today's group.
  const days: { key: string; label: string; items: (ProjectVersionItem | null)[] }[] = [{ key: 'today', label: t('projectFile.versions.today'), items: [null] }];
  for (const item of list) {
    const { createdAt } = item.summary, bucket = dayBucket(createdAt, now), date = new Date(createdAt);
    const key = bucket === 'earlier' ? `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}` : bucket;
    let day = days.find(entry => entry.key === key);
    if (!day) days.push(day = { key, items: [], label: bucket === 'yesterday' ? t('projectFile.versions.yesterday')
      : formatDate(createdAt, sameYear(createdAt, now) ? { month: 'long', day: 'numeric' } : { year: 'numeric', month: 'long', day: 'numeric' }) });
    day.items.push(item);
  }
  const row = (item: ProjectVersionItem | null) => {
    const id = item?.summary.id ?? CURRENT_VERSION, selected = item === chosen;
    return <li key={id}><WorkbenchButton variant="ghost" className="pf-version-row" aria-current={selected || undefined} data-selected={selected || undefined} data-testid={`pf-version-${id}`}
      data-trigger={item?.summary.trigger ?? CURRENT_VERSION} onClick={() => props.onSelect(id)}>
      <span className="pf-version-icon">{item ? TRIGGER_ICONS[item.summary.trigger] : <ProjectFileIcon name="circleDot" />}</span>
      <span className="pf-version-text">
        <span className="pf-version-title">{item ? versionTitle(t, item, now) : t('projectFile.versions.current')}</span>
        <span className="pf-version-meta">{item ? <><span>{display.clock(item.summary.createdAt)}</span>{item.summary.trigger !== 'manual' && <span>{t('projectFile.versions.auto')}</span>}</> : <span>{t('projectFile.versions.currentDetail')}</span>}</span>
      </span>
      {item?.summary.trigger === 'manual' && <WorkbenchBadge className="pf-version-manual" data-testid="pf-version-manual">{t('projectFile.versions.manual')}</WorkbenchBadge>}
    </WorkbenchButton></li>;
  };
  let compared: ReactNode = null;
  if (!isCurrent) {
    if (comparison.kind === 'loading') compared = <div className="pf-inline-state" role="status" data-testid="pf-version-comparing"><span className="wb-spinner" aria-hidden="true" />{t('projectFile.versions.comparing')}</div>;
    else if (comparison.kind === 'error') compared = <WorkbenchAlert tone="danger" data-testid="pf-version-compare-error"
      actions={comparison.retryable ? <WorkbenchButton size="compact" data-testid="pf-version-compare-retry" onClick={props.onRetryComparison}>{t('projectFile.common.retry')}</WorkbenchButton> : undefined}>{t('projectFile.versions.compareError')}</WorkbenchAlert>;
    else if (comparison.value.length === 0) compared = <p className="pf-help" data-testid="pf-version-no-difference">{t('projectFile.versions.noDifference')}</p>;
    else compared = <ul className="pf-rows pf-version-diff" data-testid="pf-version-diff">{comparison.value.map(group => <li key={group.area}>
      <span className="pf-row-icon">{AREA_ICONS[group.area]}</span>
      <span className="pf-row-main"><span className="pf-row-title">{t(`agent.display.target.${AREA_KINDS[group.area]}`)}</span>
        <span className="pf-row-detail">{group.details.map(detail => renderMessage(detail)).join(t('projectFile.common.listSeparator'))}</span></span>
    </li>)}</ul>;
  }
  let body: ReactNode;
  if (versions.kind === 'loading') body = <div className="pf-state" role="status" data-testid="pf-versions-loading"><span className="wb-spinner" aria-hidden="true" />{t('projectFile.versions.loading')}</div>;
  else if (versions.kind === 'error') body = <div className="pf-state" role="alert" data-testid="pf-versions-error"><strong>{t('projectFile.versions.error')}</strong>
    {versions.retryable && <WorkbenchButton data-testid="pf-versions-retry" onClick={props.onRetry}>{t('projectFile.common.retry')}</WorkbenchButton>}</div>;
  else body = <div className="pf-versions-body">
    <nav className="pf-versions-list" aria-label={t('projectFile.versions.title')}>
      {days.map(day => <section key={day.key} className="pf-versions-day"><h3>{day.label}</h3><ul>{day.items.map(row)}</ul></section>)}
      {list.length === 0 && <div className="pf-versions-empty" data-testid="pf-versions-empty"><strong>{t('projectFile.versions.emptyTitle')}</strong><p>{t('projectFile.versions.emptyBody')}</p></div>}
    </nav>
    <section className="pf-version-detail" data-testid="pf-version-detail">
      <h3 className="pf-version-detail-title">{chosen ? versionTitle(t, chosen, now) : t('projectFile.versions.current')}</h3>
      <p className="pf-version-detail-meta">{chosen ? <>
        <span>{display.when(chosen.summary.createdAt, now, true)}</span><span>{t(`projectFile.versions.source.${chosen.summary.trigger}`)}</span>
        {chosen.conversationTitle && <span>{t('projectFile.versions.conversation', { title: chosen.conversationTitle })}</span>}
      </> : <span>{t('projectFile.versions.currentDetail')}</span>}</p>
      {isCurrent ? <p className="pf-help">{t('projectFile.versions.currentHint')}</p> : <>
        <h4 className="pf-version-compare-title">{t('projectFile.versions.compareTitle')}</h4>
        {compared}
        <p className="pf-version-note"><Info size={14} aria-hidden="true" />{t('projectFile.versions.restoreNote')}</p>
      </>}
      <div className="pf-version-actions">
        {props.onCompare && <WorkbenchButton data-testid="pf-version-compare" disabled={isCurrent} onClick={props.onCompare}>{t('projectFile.versions.compareCurrent')}</WorkbenchButton>}
        <WorkbenchButton variant="primary" data-testid="pf-version-restore" disabled={isCurrent} onClick={props.onRestore}><RotateCcw size={14} aria-hidden="true" />{t('projectFile.versions.restoreAction')}</WorkbenchButton>
      </div>
    </section>
  </div>;
  return <Dialog open={props.open} onOpenChange={next => { if (!next) props.onClose(); }}>
    <WorkbenchDialogContent title={t('projectFile.versions.title')} description={t('projectFile.versions.subtitle', { name: props.projectName })} size="large"
      className="pf-dialog pf-versions-dialog" data-testid="pf-versions-dialog" footer={<p className="pf-footer-note" data-testid="pf-versions-retention">{t('projectFile.versions.retention', props.retention)}</p>}>
      {props.onSaveVersion && <WorkbenchButton className="pf-versions-save" data-testid="pf-versions-save" onClick={props.onSaveVersion}><ProjectFileIcon name="bookmarkPlus" size={14} />{t('projectFile.menu.saveVersion')}</WorkbenchButton>}
      {body}
    </WorkbenchDialogContent>
  </Dialog>;
}
