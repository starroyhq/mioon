import React, { useLayoutEffect, useRef, useState } from 'react';
import { Dialog } from '@mioon/ui/components/dialog';
import { WorkbenchButton, WorkbenchDialogContent } from '@mioon/ui/components/workbench-controls';
import Icon from './icons.tsx';
import { useI18n } from './i18n/I18nProvider.tsx';
import { agentConnectionTestMatches, createAgentConnectionTestSession } from './agent-connection-test.ts';
import type { AgentConnectionTestState } from './agent-connection-test.ts';
import type { AgentConfiguration } from './agent-settings.ts';
import { agentTaskErrorKey } from './agent-task-errors.ts';

type ConnectionTestSession = ReturnType<typeof createAgentConnectionTestSession>;
const running = new Set(['accepted', 'running', 'paused', 'awaiting_approval', 'interrupted']);
const startErrors: Readonly<Record<string, 'mio.settings.test.noProject' | 'mio.settings.test.busy' | 'mio.settings.test.changed'>> = {
  AGENT_CONNECTION_TEST_NO_PROJECT: 'mio.settings.test.noProject', AGENT_TASK_BUSY: 'mio.settings.test.busy', AGENT_TASK_SETTINGS_CHANGED: 'mio.settings.test.changed',
};

/** "测试连接" (5.16): a text diagnostic run against the saved connection. An unauthorized destination first gets the
 * same confirmation as a first send (5.7); the result shown is the newest stored test of this exact connection. */
export default function AgentConnectionTest({ visible, configuration, settingsRevision, blocked, projectId = null }: { visible: boolean; configuration: AgentConfiguration; settingsRevision: number; blocked: boolean; projectId?: string | null }) {
  const { t, formatDate, locale } = useI18n();
  const [state, setState] = useState<AgentConnectionTestState>({ phase: 'loading', latest: null, review: null, error: null });
  const session = useRef<ConnectionTestSession | null>(null), confirmButton = useRef<HTMLButtonElement | null>(null), runButton = useRef<HTMLButtonElement | null>(null);
  useLayoutEffect(() => {
    const current = createAgentConnectionTestSession({ onChange: next => { if (session.current === current) setState(next); } });
    session.current = current; void current.load();
    return () => { current.dispose(); if (session.current === current) session.current = null; };
  }, []);
  const { phase, latest, review, error } = state;
  const matches = agentConnectionTestMatches(latest, configuration);
  const time = latest ? formatDate(latest.updatedAt, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
  const testing = phase === 'starting' || phase === 'testing' || phase === 'authorizing' || matches && Boolean(latest && running.has(latest.status));
  const line = testing ? t('mio.settings.test.running')
    : error ? (Object.hasOwn(startErrors, error) ? t(startErrors[error]!) : t('mio.settings.test.error', { reason: t(agentTaskErrorKey(error)) }))
    : !matches || !latest ? t('mio.settings.test.none')
    : latest.status === 'completed' ? t('mio.settings.test.passed', { time })
    : latest.status === 'failed' ? t('mio.settings.test.failed', { time, reason: t(agentTaskErrorKey(latest.failureCode)) })
    : t('mio.settings.test.stopped', { time });
  const tone = testing ? '' : error || matches && latest?.status !== 'completed' && latest ? 'is-warning' : matches && latest?.status === 'completed' ? 'is-success' : '';
  return <div className="mio-settings-test" data-testid="agent-connection-test" data-phase={phase}>
    <WorkbenchButton ref={runButton} type="button" data-testid="agent-connection-test-run" loading={testing} disabled={!visible || blocked || phase !== 'idle'}
      onClick={() => { if (visible && !blocked) void session.current?.start({ settingsRevision, currentProjectId: projectId, locale }); }}><Icon name="sparkle" size={14} />{t('mio.settings.test.run')}</WorkbenchButton>
    <span className={`mio-settings-test-result ${tone}`} role="status" data-testid="agent-connection-test-result">{blocked && !testing ? t('mio.settings.test.saveFirst') : line}</span>
    <Dialog open={Boolean(review) && visible} onOpenChange={open => { if (!open && phase === 'review') session.current?.cancel(); }}><WorkbenchDialogContent title={t('agent.panel.authorizationTitle', { model: review?.model ?? '' })} description={t('agent.panel.authorizationIntro')} className="mio-authorization" initialFocus={confirmButton} finalFocus={runButton} data-testid="agent-connection-test-authorization" footer={<><p className="mio-secondary">{t('agent.panel.authorizationRevoke')}</p><WorkbenchButton type="button" disabled={phase !== 'review'} onClick={() => { session.current?.cancel(); }}>{t('common.cancel')}</WorkbenchButton><WorkbenchButton type="button" variant="primary" ref={confirmButton} data-testid="agent-connection-test-confirm" loading={phase === 'authorizing'} disabled={phase !== 'review'} onClick={() => { void session.current?.confirm(); }}>{t('mio.settings.test.confirm')}</WorkbenchButton></>}>
      <section><h4>{t('agent.panel.authorizationScope')}</h4><p>{t('agent.panel.authorizationContent')}</p><p className="mio-secondary">{t('agent.panel.authorizationExcluded')}</p><p className="mio-secondary">{t('mio.settings.test.dialogNote')}</p></section><section><h4>{t('agent.panel.authorizationDestination')}</h4><p className="mio-endpoint">{review?.destination}</p><p>{t('agent.panel.model')} · {review?.model}</p></section><section><h4>{t('agent.panel.authorizationFeeTitle')}</h4><p>{t('agent.panel.authorizationFee')}</p></section>
    </WorkbenchDialogContent></Dialog>
  </div>;
}
