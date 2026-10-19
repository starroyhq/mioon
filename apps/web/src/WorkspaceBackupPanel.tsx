declare module '*.md?raw' { const content: string; export default content; }
import { useI18n } from './i18n/I18nProvider.tsx';
import React, { useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@mioon/ui/components/button';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@mioon/ui/components/collapsible';
import { useWorkspaceVisibility } from './workspace-visibility.tsx';
import { createWorkspaceBackupController, WORKSPACE_BACKUP_COUNTS, WORKSPACE_BACKUP_UNRESOLVED, WORKSPACE_BACKUP_CREATE_COMMAND, WORKSPACE_BACKUP_VERIFY_COMMAND, WORKSPACE_BACKUP_ISSUES, workspaceBackupError, workspaceBackupCount, workspaceBackupBytes } from './workspace-backup-ui.ts';
import backupGuideHans from '../../../docs/WORKSPACE-BACKUP-GUIDE.zh-CN.md?raw';
import backupGuideHant from '../../../docs/WORKSPACE-BACKUP-GUIDE.zh-Hant.md?raw';
import backupGuideEn from '../../../docs/WORKSPACE-BACKUP-GUIDE.en.md?raw';
import backupGuideJa from '../../../docs/WORKSPACE-BACKUP-GUIDE.ja.md?raw';
const backupGuides = { 'zh-Hans': backupGuideHans, 'zh-Hant': backupGuideHant, en: backupGuideEn, ja: backupGuideJa };
import './workspace-backup.css';

export function WorkspaceBackupDetails({ state, controller }) {
  const { t, locale, formatDate, formatNumber, renderMessage } = useI18n();
  const [guideOpen, setGuideOpen] = useState(false);
  const report = state?.report;
  const unresolved = report ? WORKSPACE_BACKUP_UNRESOLVED.filter(([key]) => report.unresolved[key] !== 0) : [];
  return <div className="workspace-backup-details" data-testid="workspace-backup-details">
    <p>{t('recovery.backup.scope')}</p>
    <p>{t('recovery.backup.media')}</p>
    <p>{t('recovery.backup.privacy')}</p>
    <p className="workspace-backup-warning">{t('recovery.backup.readOnly')}</p>
    <Button variant="outline" type="button" size="sm" data-testid="workspace-backup-inspect" disabled={!state?.connected || !state?.visible || state?.phase === 'checking'} onClick={() => controller.inspect(state?.scope ?? null, state?.version ?? -1)}>{state?.phase === 'checking' ? t('recovery.backup.checking') : report ? t('recovery.backup.refresh') : t('recovery.backup.check')}</Button>
    <p role="status" aria-live="polite" data-testid="workspace-backup-status">{!state?.connected ? t('recovery.backup.disconnected') : state?.phase === 'checking' ? t('recovery.backup.reading') : state?.phase === 'stale' ? t('recovery.backup.stale') : state?.phase === 'error' ? t('recovery.backup.failed') : state?.phase === 'incomplete' ? t('recovery.backup.incomplete') : report ? t('recovery.backup.complete') : t('recovery.backup.idle')}</p>
    {state?.error && <p className="workspace-backup-warning" role="alert">{workspaceBackupError({ code: state.errorCode }, locale)}</p>}
    {report && <section aria-label={t('recovery.backup.report')} data-testid="workspace-backup-report">
      <h3>{t('recovery.backup.schema', { version: workspaceBackupCount(report.databaseSchemaVersion, locale) })}</h3>
      <dl className="workspace-backup-counts">{WORKSPACE_BACKUP_COUNTS.map(([key, label]) => <div key={key}><dt>{t(key === 'exports' ? 'export.workspace.history' : `recovery.backup.count.${key}`)}</dt><dd data-testid={`workspace-backup-count-${key}`}>{workspaceBackupCount(report.counts[key], locale)}</dd></div>)}</dl>
      <h3>{t('recovery.backup.unresolved')}</h3>
      {unresolved.length ? <dl className="workspace-backup-counts">{unresolved.map(([key, label]) => <div key={key}><dt>{t(`recovery.backup.count.${key}`)}</dt><dd>{workspaceBackupCount(report.unresolved[key], locale)}</dd></div>)}</dl> : <p>{t('recovery.backup.noneUnresolved')}</p>}
      <p>{t('recovery.backup.retention')}</p>
      {report.issues.length > 0 && <ul className="workspace-backup-issues">{report.issues.map(code => <li key={code}>{t(`recovery.backup.issue.${code}`)}</li>)}</ul>}
      <h3>{t('recovery.backup.limits')}</h3>
      <p>{t('recovery.backup.capacityDetails', { database: workspaceBackupBytes(report.limits.databaseBytes, locale), files: workspaceBackupCount(report.limits.fileCount, locale), file: workspaceBackupBytes(report.limits.fileBytes, locale), total: workspaceBackupBytes(report.limits.totalBytes, locale) })}</p>
    </section>}
    <section aria-label={t('recovery.backup.steps')} className="workspace-backup-instructions">
      <h3>{t('recovery.backup.terminal')}</h3>
      <ol><li>{t('recovery.backup.close')}</li><li>{t('recovery.backup.run')}</li></ol>
      <pre data-testid="workspace-backup-create-command"><code>{WORKSPACE_BACKUP_CREATE_COMMAND}</code></pre>
      <p>{t('recovery.backup.verify')}</p>
      <pre data-testid="workspace-backup-verify-command"><code>{WORKSPACE_BACKUP_VERIFY_COMMAND}</code></pre>
      <p>{t('recovery.backup.restoreWarning')}</p>
      <Collapsible open={guideOpen} onOpenChange={setGuideOpen} className="workspace-backup-guide">
        <a href="#workspace-backup-guide-text" aria-expanded={guideOpen} aria-controls="workspace-backup-guide-text" data-testid="workspace-backup-guide" onClick={event => { event.preventDefault(); setGuideOpen(value => !value); }}>{guideOpen ? t('recovery.backup.closeGuide') : t('recovery.backup.openGuide')}</a>
        <CollapsibleContent inert={!guideOpen || !state?.visible} aria-hidden={!guideOpen || undefined}><pre id="workspace-backup-guide-text" className="workspace-backup-guide-text">{backupGuides[locale]}</pre></CollapsibleContent>
      </Collapsible>
    </section>
  </div>;
}

export default function WorkspaceBackupPanel({ scope, getScope, connected, read, onUnauthorized }) {
  const { t, locale, formatDate, formatNumber, renderMessage } = useI18n();
  const visible = useWorkspaceVisibility(), [expanded, setExpanded] = useState(false), [state, setState] = useState(null);
  const callbacks = useRef(null), controller = useRef(null);
  callbacks.current = { scope, getScope, connected, visible: visible && expanded, read, onUnauthorized };
  if (!controller.current) controller.current = createWorkspaceBackupController({
    read: (input, options) => callbacks.current.read(input, options), onChange: setState,
    getContext: () => ({ scope: callbacks.current.getScope?.() ?? callbacks.current.scope, connected: callbacks.current.connected, visible: callbacks.current.visible }),
    onUnauthorized: () => callbacks.current.onUnauthorized?.(),
  });
  useLayoutEffect(() => { controller.current.connect(); return () => controller.current.dispose(); }, []);
  useLayoutEffect(() => { controller.current.setContext({ scope, connected, visible: visible && expanded }); }, [scope, connected, visible, expanded]);
  const current = state?.scope === scope ? state : null;
  return <Collapsible open={expanded} onOpenChange={setExpanded} className="workspace-backup-panel" data-testid="workspace-backup-panel" render={<section aria-label={t('recovery.backup.title')} />}>
    <CollapsibleTrigger className="workspace-backup-trigger" render={<Button variant="ghost" type="button" disabled={!visible} data-testid="workspace-backup-toggle" />}><span><strong>{t('recovery.backup.title')}</strong><small>{t('recovery.backup.subtitle')}</small></span><span aria-hidden="true">{expanded ? '−' : '+'}</span></CollapsibleTrigger>
    <CollapsibleContent keepMounted className="workspace-backup-content" inert={!visible || !expanded} aria-hidden={!visible || !expanded || undefined}><WorkspaceBackupDetails state={current} controller={controller.current} /></CollapsibleContent>
  </Collapsible>;
}
