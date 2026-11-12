import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Dialog } from '@mioon/ui/components/dialog';
import { WorkbenchButton, WorkbenchDialogContent } from '@mioon/ui/components/workbench-controls';
import Icon from './icons.tsx';
import { useI18n } from './i18n/I18nProvider.tsx';
import { createAgentConnectionTestSession } from './agent-connection-test.ts';
import type { AgentConnectionTestState } from './agent-connection-test.ts';
import type { AgentSettingsBinding } from '../../../packages/contracts/src/agent-connection-settings.ts';
import type { AgentTaskConnectionTest } from '../../../packages/contracts/src/agent-tasks-v2.ts';
import type { AgentConfiguration } from './agent-settings.ts';
import { agentTaskErrorKey } from './agent-task-errors.ts';

type ConnectionTestSession = ReturnType<typeof createAgentConnectionTestSession>;
const startErrors: Readonly<Record<string, 'mio.settings.test.noProject' | 'mio.settings.test.busy' | 'mio.settings.test.changed'>> = {
  AGENT_CONNECTION_TEST_NO_PROJECT: 'mio.settings.test.noProject', AGENT_TASK_BUSY: 'mio.settings.test.busy', AGENT_TASK_SETTINGS_CHANGED: 'mio.settings.test.changed',
};
function connectionTestFailureKey(errorCode: string | null, httpStatus?: number) {
  switch (httpStatus) {
    case 401: return 'mio.settings.test.reason.invalidKey';
    case 403: return 'mio.settings.test.reason.permissionDenied';
    case 404: return 'mio.settings.test.reason.notFound';
    case 429: return 'mio.settings.test.reason.rateLimited';
  }
  if (httpStatus !== undefined && httpStatus >= 500 && httpStatus <= 599) return 'mio.settings.test.reason.serverError';
  switch (errorCode) {
    case 'AGENT_CHAT_CONNECT_FAILED': return 'mio.settings.test.reason.connectionFailed';
    case 'AGENT_CHAT_TIMEOUT': return 'mio.settings.test.reason.timeout';
    case 'AGENT_CHAT_NETWORK_DENIED': return 'mio.settings.test.reason.networkDenied';
    default: return agentTaskErrorKey(errorCode);
  }
}

/** "测试连接" (5.16): a text diagnostic run against the saved connection. An unauthorized destination first gets the
 * same confirmation as a first send (5.7); the result shown is the application's newest completed diagnostic summary. */
export default function AgentConnectionTest({ visible, configuration, settingsRevision, settingsBinding, blocked, projectId = null, onLatestChange }: { visible: boolean; configuration: AgentConfiguration; settingsRevision: number; settingsBinding?: AgentSettingsBinding; blocked: boolean; projectId?: string | null; onLatestChange?: (latest: AgentTaskConnectionTest | null) => void }) {
  const { t, formatDate, locale } = useI18n();
  const interaction = useMemo(() => ({visible, blocked, settingsRevision, projectId, locale}), [visible, blocked, settingsRevision, projectId, locale, settingsBinding?.serviceKey, settingsBinding?.entryRevision, settingsBinding?.selectionRevision]);
  const interactionRef = useRef<typeof interaction | null>(interaction);
  useLayoutEffect(() => { interactionRef.current = interaction; }, [interaction]);
  const usable = () => interactionRef.current === interaction && visible && !document.hidden;
  const [state, setState] = useState<AgentConnectionTestState>({ phase: 'loading', latest: null, review: null, error: null });
  const session = useRef<ConnectionTestSession | null>(null), confirmButton = useRef<HTMLButtonElement | null>(null), runButton = useRef<HTMLButtonElement | null>(null);
  useLayoutEffect(() => {
    const current = createAgentConnectionTestSession({ onChange: next => { if (session.current === current) setState(next); } });
    session.current = current; void current.load();
    return () => { interactionRef.current = null; current.dispose(); if (session.current === current) session.current = null; };
  }, []);
  const { phase, latest, review, error } = state;
  useLayoutEffect(() => { onLatestChange?.(latest); }, [latest, onLatestChange]);
  const time = latest ? formatDate(latest.completedAt, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
  const current = Boolean(latest && settingsBinding && latest.settingsRevision === settingsRevision && latest.settingsBinding?.serviceKey === settingsBinding.serviceKey && latest.settingsBinding?.entryRevision === settingsBinding.entryRevision && latest.settingsBinding?.selectionRevision === settingsBinding.selectionRevision && latest.protocol === configuration.protocol && latest.model === configuration.model);
  const testing = phase === 'starting' || phase === 'testing' || phase === 'authorizing';
  const diagnostic = latest?.status === 'failed' ? latest.diagnostic : undefined;
  const line = testing ? t('mio.settings.test.running')
    : error ? (Object.hasOwn(startErrors, error) ? t(startErrors[error]!) : t('mio.settings.test.error', { reason: t(connectionTestFailureKey(error)) }))
    : !latest ? t('mio.settings.test.none')
    : latest.status === 'completed' ? t('mio.settings.test.passed', { time })
    : latest.status === 'failed' ? t('mio.settings.test.failed', { time, reason: t(connectionTestFailureKey(latest.errorCode, diagnostic?.status)) })
    : t('mio.settings.test.stopped', { time });
  const tone = testing ? '' : error || latest && latest.status !== 'completed' ? 'is-warning' : latest?.status === 'completed' ? 'is-success' : '';
  return <div className="mio-settings-test" data-testid="agent-connection-test" data-phase={phase}>
    <WorkbenchButton ref={runButton} type="button" data-testid="agent-connection-test-run" loading={testing} disabled={!visible || blocked || phase !== 'idle'}
      onClick={() => { if (usable() && !blocked) void session.current?.start({ settingsRevision, currentProjectId: projectId, locale }); }}><Icon name="sparkle" size={14} />{t('mio.settings.test.run')}</WorkbenchButton>
    <span className={`mio-settings-test-result ${tone}`} role="status" data-text-selectable data-testid="agent-connection-test-result">
      {blocked && !testing ? t('mio.settings.test.saveFirst') : <>
        {!testing && !error && latest && <>{t('mio.settings.test.latest', {protocol:latest.protocol,model:latest.model})} · {!current && <>{t('agent.settings.x6.historical')} </>}</>}
        {line}
        {!testing && !error && diagnostic && <>
          {' · '}{t('mio.settings.test.httpStatus', {status: diagnostic.status})}
          {diagnostic.providerType && <> · {t('mio.settings.test.providerType', {type: diagnostic.providerType})}</>}
          {diagnostic.providerCode !== undefined && <> · {t('mio.settings.test.providerCode', {code: String(diagnostic.providerCode)})}</>}
        </>}
      </>}
    </span>
    <Dialog open={Boolean(review) && visible} onOpenChange={open => { if (!open && phase === 'review' && usable()) session.current?.cancel(); }}><WorkbenchDialogContent title={t('agent.panel.authorizationTitle', { model: review?.model ?? '' })} description={t('agent.panel.authorizationIntro')} className="mio-authorization" initialFocus={confirmButton} finalFocus={runButton} data-testid="agent-connection-test-authorization" footer={<><p className="mio-secondary">{t('agent.panel.authorizationRevoke')}</p><WorkbenchButton type="button" disabled={phase !== 'review'} onClick={() => { if (usable()) session.current?.cancel(); }}>{t('common.cancel')}</WorkbenchButton><WorkbenchButton type="button" variant="primary" ref={confirmButton} data-testid="agent-connection-test-confirm" loading={phase === 'authorizing'} disabled={phase !== 'review'} onClick={() => { if (usable()) void session.current?.confirm(); }}>{t('mio.settings.test.confirm')}</WorkbenchButton></>}>
      <section><h4>{t('agent.panel.authorizationScope')}</h4><p>{t('agent.panel.authorizationContent')}</p><p className="mio-secondary">{t('agent.panel.authorizationExcluded')}</p><p className="mio-secondary">{t('mio.settings.test.dialogNote')}</p></section><section><h4>{t('agent.panel.authorizationDestination')}</h4><p className="mio-endpoint">{review?.destination}</p><p>{t('agent.panel.model')} · {review?.model}</p></section><section><h4>{t('agent.panel.authorizationFeeTitle')}</h4><p>{t('agent.panel.authorizationFee')}</p></section>
    </WorkbenchDialogContent></Dialog>
  </div>;
}
