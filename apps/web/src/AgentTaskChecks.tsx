import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { WorkbenchButton as Button } from '@mioon/ui/components/workbench-controls';
import { WorkbenchTooltip } from '@mioon/ui/components/workbench-tooltip';
import type { AgentTaskChange, AgentTaskSnapshot } from '../../../packages/contracts/src/agent-tasks-v2.ts';
import type { AgentTaskCheck } from '../../../packages/contracts/src/agent-task-checks-v2.ts';
import { useI18n } from './i18n/I18nProvider.tsx';
import { createAgentTaskChecksView, visibleAgentTaskChecks } from './agent-task-checks-state.ts';
import type { AgentTaskChecksViewState } from './agent-task-checks-state.ts';
import { taskCheckExplanation, taskCheckLocation, taskCheckMetadata, taskCheckTargetTitle } from './agent-task-presentation.ts';
import type { TaskDisplayLookup } from './agent-task-presentation.ts';
import Icon from './icons.tsx';

interface Props {
  scope: string;
  snapshot: AgentTaskSnapshot;
  latest: boolean;
  visible: boolean;
  attached?: boolean;
  readOnly: boolean;
  targetName?: TaskDisplayLookup;
  onLocate?: (change: AgentTaskChange) => unknown;
  onOpenRequests?: (selectedId?: string) => unknown;
}
const initial: AgentTaskChecksViewState = { report: null, loading: false, preflighting: false, error: false, justChecked: false };

function CheckRow({ item, preflighting, snapshot, readOnly, visible, targetName, onLocate, onOpenRequests }: Pick<Props, 'snapshot' | 'readOnly' | 'visible' | 'targetName' | 'onLocate' | 'onOpenRequests'> & { item: AgentTaskCheck; preflighting: boolean }) {
  const { t, locale } = useI18n();
  const checking = preflighting && item.type === 'timeline_preflight';
  const status = checking ? 'pending' : item.status;
  const working = checking || status === 'pending' && (item.reason?.code === 'TASK_PENDING' || item.progress !== undefined);
  const name = taskCheckTargetTitle(item, locale, targetName), metadata = taskCheckMetadata(item, locale);
  const explanation = checking ? t('agent.checks.preflightRunning') : taskCheckExplanation(item, locale);
  const location = taskCheckLocation(item, snapshot, readOnly);
  const canLocate = location && ('change' in location ? onLocate : onOpenRequests);
  const locate = () => {
    if (!visible || !location) return;
    if ('change' in location) onLocate?.(location.change); else onOpenRequests?.(location.request);
  };
  return <div className="mio-check-row" data-testid="agent-task-check" data-check-id={item.id} data-status={status}>
    <span className="mio-check-icon" data-tone={status === 'passed' ? 'success' : status === 'failed' ? 'danger' : 'neutral'} role="img" aria-label={t(`agent.checks.status.${status}`)}>
      {working ? <span className="wb-spinner" aria-hidden="true" /> : status === 'failed' ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="m9 9 6 6m0-6-6 6" /></svg> : <Icon name={status === 'passed' ? 'check' : 'clock'} />}
    </span>
    <div className="mio-check-copy">
      <p className="mio-check-name">{t(`agent.checks.type.${item.type}`)}</p>
      <p className="mio-check-target">{[name, ...metadata].join(' · ')}</p>
      {explanation && <p className="mio-check-reason">{explanation}</p>}
    </div>
    {canLocate && <WorkbenchTooltip content={t('agent.checks.locate', { name })}><Button variant="icon" className="mio-check-locate" aria-label={t('agent.checks.locate', { name })} disabled={!visible} onClick={locate}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" aria-hidden="true"><circle cx="12" cy="12" r="7" /><path d="M12 2v4m0 12v4M2 12h4m12 0h4" /></svg>
    </Button></WorkbenchTooltip>}
  </div>;
}

export default function AgentTaskChecks({ scope, snapshot, latest, visible, attached = true, readOnly, targetName, onLocate, onOpenRequests }: Props) {
  const { t, locale } = useI18n(), contentId = useId();
  const [state, setState] = useState(initial), [inView, setInView] = useState(false), [documentVisible, setDocumentVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  const [expanded, setExpanded] = useState<boolean | undefined>();
  const root = useRef<HTMLElement | null>(null), view = useRef<ReturnType<typeof createAgentTaskChecksView> | null>(null);
  const { run } = snapshot, eligible = run.status === 'completed' && !run.diagnostic;
  useEffect(() => {
    const changed = () => setDocumentVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', changed); changed();
    return () => document.removeEventListener('visibilitychange', changed);
  }, []);
  useEffect(() => {
    const element = root.current;
    if (!element || !eligible || !visible) { setInView(false); return; }
    // Only intersecting rounds read. A hidden dock/history overlay is handled
    // separately, so opening a long conversation cannot fan out across history.
    const observer = new IntersectionObserver(entries => setInView(entries.some(entry => entry.isIntersecting)), { root: element.closest('.mio-log') });
    observer.observe(element);
    return () => observer.disconnect();
  }, [eligible, visible, run.id]);
  useLayoutEffect(() => {
    setState(initial); setExpanded(undefined);
    const current = createAgentTaskChecksView({ scope, projectId: run.projectId, onChange: setState });
    view.current = current;
    return () => { current.dispose(); if (view.current === current) view.current = null; };
  }, [scope, run.projectId, run.id]);
  const active = eligible && visible && inView && documentVisible;
  useEffect(() => { view.current?.update({ runId: run.id, runRevision: run.revision, completed: eligible, attached, latest, backgroundPending: snapshot.backgroundPending === true, visible: active }); }, [run.id, run.revision, eligible, attached, latest, snapshot.backgroundPending, active]);
  const groups = visibleAgentTaskChecks(state.report, state.preflighting), items = groups.flatMap(group => group.items);
  const failed = items.filter(item => item.status === 'failed' && !(state.preflighting && item.type === 'timeline_preflight')).length;
  const pending = items.filter(item => item.status === 'pending' || state.preflighting && item.type === 'timeline_preflight').length;
  const open = expanded ?? (failed > 0 || pending > 0);
  const count = failed || pending, summary = failed ? t('agent.checks.summary.failed', { count }) : pending ? t('agent.checks.summary.pending', { count }) : items.length ? t('agent.checks.summary.allPassed') : '';
  const heading = items.length ? t('agent.checks.titleCount', { count: items.length }) : t('agent.checks.title');
  const showContent = items.length > 0 || state.preflighting || state.error;
  if (!eligible) return null;
  // Keep the same observed element across loading/empty/result transitions.
  // An empty completed round contributes no visible heading or placeholder.
  return <section ref={root} className={showContent ? 'mio-checks' : 'mio-checks-sentinel'} data-testid={showContent ? 'agent-task-checks' : 'agent-task-checks-sentinel'} aria-hidden={showContent ? undefined : true} aria-label={showContent ? t('agent.checks.title') : undefined}>
    {showContent && <>
    <header className="mio-check-head">
      <Button variant="ghost" className="mio-check-toggle" aria-label={`${t(open ? 'agent.checks.collapse' : 'agent.checks.expand')} · ${heading}${summary ? ` · ${summary}` : ''}`} aria-expanded={open} aria-controls={contentId} onClick={() => setExpanded(!open)}>
        <Icon name={open ? 'down' : 'arrow'} />
        <span className="mio-check-heading">{heading}</span>
        {summary && <><span className="mio-check-separator" aria-hidden="true"> · </span><span className="mio-check-summary" data-tone={failed ? 'danger' : pending ? 'pending' : undefined} data-testid="agent-task-check-summary">{summary}</span></>}
        {state.justChecked && <span className="mio-check-fresh" role="status">{t('agent.checks.justChecked')}</span>}
      </Button>
      <WorkbenchTooltip content={t('agent.checks.recheckTooltip')}><Button variant="icon" className="mio-check-refresh" aria-label={t('agent.checks.recheck')} loading={state.preflighting} disabled={!active} onClick={() => { void view.current?.recheck(); }}>
        {!state.preflighting && <Icon name="refresh" />}
      </Button></WorkbenchTooltip>
    </header>
    {state.error && <p className="mio-error" role="alert">{t('agent.checks.readFailed')}</p>}
    <div id={contentId} hidden={!open}>
      {groups.map(group => <section key={group.id} className="mio-check-group" data-check-group={group.id}>
        <h5>{t(`agent.checks.group.${group.id}`)}</h5>
        {group.items.map(item => <CheckRow key={item.id} item={item} preflighting={state.preflighting} snapshot={snapshot} readOnly={readOnly} visible={active} targetName={targetName} onLocate={onLocate} onOpenRequests={onOpenRequests} />)}
      </section>)}
    </div>
    </>}
  </section>;
}
