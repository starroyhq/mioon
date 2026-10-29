import React from 'react';
import type { ReactElement } from 'react';
import { WorkbenchButton as Button } from '@mioon/ui/components/workbench-controls';
import { useI18n } from './i18n/I18nProvider.tsx';
import Icon from './icons.tsx';
import { reviewIssueEntries, shotNumberLabel } from './agent-task-reviews.ts';
import type { ReviewIssueEntry } from './agent-task-reviews.ts';
import type { AgentTaskContinuityIssue, AgentTaskStep } from '../../../packages/contracts/src/agent-tasks-v2.ts';

export interface AgentTaskContinuityReportProps {
  step: AgentTaskStep;
  issues: readonly AgentTaskContinuityIssue[];
  /** A shot's 1-based storyboard number; undefined for a shot that is no longer in the project. */
  shotNumber?: (shotId: string) => number | undefined;
  disabled?: boolean;
  onLocate?: (entry: ReviewIssueEntry) => unknown;
}

/**
 * A read-only continuity check (09-09): a host line saying nothing was changed, then one card per reported issue
 * with its category, shots and Mio's note. "定位" selects and shows the issue's first shot; changing anything is
 * the user's decision.
 */
export default function AgentTaskContinuityReport({ step, issues, shotNumber, disabled = false, onLocate }: AgentTaskContinuityReportProps): ReactElement {
  const { t } = useI18n();
  const entries = reviewIssueEntries(step, issues);
  return <section className="mio-review" data-testid="agent-task-review" data-step-id={step.id} aria-label={t('agent.skill.title.continuityCheck')}>
    <p className="mio-review-summary">{issues.length ? t('agent.review.summary', { count: issues.length }) : t('agent.review.none')}</p>
    {issues.map((issue, index) => {
      const entry = entries[index]!, numbers = issue.shotIds.map(id => shotNumber?.(id)), present = issue.shotIds.filter((_, at) => numbers[at] !== undefined);
      const listed = numbers.filter((value): value is number => value !== undefined).map(shotNumberLabel);
      const shots = [listed.length ? t('agent.review.shot', { number: listed.join(' · ') }) : '', present.length < issue.shotIds.length ? t('agent.review.shotMissing') : ''].filter(Boolean).join(' · ');
      return <article key={entry.owner} className="mio-review-issue" data-testid="agent-task-review-issue" data-review-owner={entry.owner} data-category={issue.category}>
        <header>
          <span className="mio-review-category">{t(`agent.review.category.${issue.category}`)}</span>
          <span className="mio-review-shots">{shots}</span>
          <Button variant="ghost" size="compact" className="mio-review-locate" data-testid={`agent-task-review-locate-${index}`} aria-label={`${t('agent.review.locate')} · ${shots}`} disabled={disabled || !present.length || !onLocate} onClick={() => onLocate?.({ ...entry, shotIds: present })}><Icon name="locate" />{t('agent.review.locate')}</Button>
        </header>
        <p>{issue.text}</p>
      </article>;
    })}
  </section>;
}
