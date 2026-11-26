import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Dialog } from '@mioon/ui/components/dialog';
import {
  WorkbenchAlert,
  WorkbenchBadge,
  WorkbenchButton,
  WorkbenchDialogContent,
} from '@mioon/ui/components/workbench-controls';
import {
  Check,
  Copy,
  Download,
  FolderOpen,
  RefreshCw,
} from '@mioon/ui/components/workbench-icons';
import {
  WorkbenchPopover,
  WorkbenchPopoverContent,
  WorkbenchPopoverTrigger,
} from '@mioon/ui/components/workbench-popover';
import type {
  ExternalAgent,
  ExternalAgentsBridge,
  ExternalAgentsView,
} from '../../../packages/contracts/src/external-agents.ts';
import type { DisplayMessage } from '../../../packages/i18n/src/index.ts';
import { useI18n } from './i18n/I18nProvider.tsx';
import Icon from './icons.tsx';
import { WorkbenchTooltip } from './WorkspaceControls.tsx';
import {
  externalAgentSkillBadge,
  externalAgentsErrorMessage,
  externalAgentsReasonMessage,
  orderedExternalAgentSkills,
  readExternalAgentsBridge,
  readExternalAgentsErrorCode,
} from './external-agents-client.ts';
import './external-agents-settings.css';

export interface ExternalAgentsSettingsProps {
  readonly active: boolean;
  readonly bridge?: ExternalAgentsBridge | null;
  readonly initialView?: ExternalAgentsView | null;
  readonly copyText?: (text: string) => Promise<void>;
  readonly copyResetMs?: number;
}

interface CopyIconButtonProps {
  readonly id: string;
  readonly copied: boolean;
  readonly label: string;
  readonly copiedLabel: string;
  readonly disabled?: boolean;
  readonly testId: string;
  readonly onCopy: () => void;
}

function CopyIconButton({
  id,
  copied,
  label,
  copiedLabel,
  disabled = false,
  testId,
  onCopy,
}: CopyIconButtonProps) {
  return <span className="external-agents-copy-wrap">
    {copied && <span className="external-agents-copied-bubble" role="status" data-testid={`external-agents-copied-${id}`}>
      {copiedLabel}
    </span>}
    <WorkbenchButton
      type="button"
      variant="icon"
      size="compact"
      className="external-agents-copy-button"
      data-testid={testId}
      data-copied={copied ? 'true' : undefined}
      aria-label={copied ? copiedLabel : label}
      disabled={disabled}
      onClick={onCopy}
    >
      {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
    </WorkbenchButton>
  </span>;
}

const defaultCopyText = async (text: string): Promise<void> => {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
    throw new Error('Clipboard unavailable');
  }
  await navigator.clipboard.writeText(text);
};

export default function ExternalAgentsSettings({
  active,
  bridge: providedBridge,
  initialView = null,
  copyText = defaultCopyText,
  copyResetMs = 2000,
}: ExternalAgentsSettingsProps) {
  const { t, renderMessage } = useI18n();
  const [defaultBridge] = useState<ExternalAgentsBridge | null>(() => readExternalAgentsBridge());
  const bridge = providedBridge === undefined ? defaultBridge : providedBridge;
  const copyTextRef = useRef(copyText);
  copyTextRef.current = copyText;
  const [view, setView] = useState<ExternalAgentsView | null>(initialView);
  const [loading, setLoading] = useState(initialView === null && Boolean(bridge));
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<DisplayMessage | null>(null);
  const [pathPopoverOpen, setPathPopoverOpen] = useState(false);
  const [pendingOverwrite, setPendingOverwrite] = useState<ExternalAgent | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const mounted = useRef(true);
  const seq = useRef(0);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copySeq = useRef(0);

  const clearCopyState = useCallback(() => {
    if (copyTimer.current !== null) {
      clearTimeout(copyTimer.current);
      copyTimer.current = null;
    }
    copySeq.current += 1;
    setCopiedId(null);
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      seq.current += 1;
      if (copyTimer.current !== null) {
        clearTimeout(copyTimer.current);
        copyTimer.current = null;
      }
    };
  }, []);

  const loadView = useCallback(async () => {
    if (!bridge) return;
    const ticket = ++seq.current;
    setLoading(true);
    setErrorMessage(null);
    try {
      const next = await bridge.read();
      if (!mounted.current || seq.current !== ticket) return;
      setView(next);
      if (next.cli.state !== 'installed' || next.cli.onPath !== 'no') setPathPopoverOpen(false);
    } catch (error) {
      if (!mounted.current || seq.current !== ticket) return;
      setErrorMessage(externalAgentsErrorMessage(error));
    } finally {
      if (mounted.current && seq.current === ticket) setLoading(false);
    }
  }, [bridge]);

  useEffect(() => {
    if (!active) {
      setPathPopoverOpen(false);
      setPendingOverwrite(null);
      clearCopyState();
      return;
    }
    if (bridge) void loadView();
  }, [active, bridge, clearCopyState, loadView]);

  const runMutation = useCallback(async (
    actionId: string,
    request: (activeBridge: ExternalAgentsBridge) => Promise<ExternalAgentsView>,
    onError?: (error: unknown) => boolean,
  ): Promise<boolean> => {
    if (!bridge || busyAction !== null) return false;
    const ticket = ++seq.current;
    setBusyAction(actionId);
    setErrorMessage(null);
    try {
      const next = await request(bridge);
      if (!mounted.current || seq.current !== ticket) return false;
      setView(next);
      if (next.cli.state !== 'installed' || next.cli.onPath !== 'no') setPathPopoverOpen(false);
      return true;
    } catch (error) {
      if (!mounted.current || seq.current !== ticket) return false;
      if (onError?.(error)) return false;
      setErrorMessage(externalAgentsErrorMessage(error));
      return false;
    } finally {
      if (mounted.current && seq.current === ticket) setBusyAction(null);
    }
  }, [bridge, busyAction]);

  const handleCopy = useCallback((id: string, text: string) => {
    const ticket = ++copySeq.current;
    void copyTextRef.current(text).then(() => {
      if (!mounted.current || copySeq.current !== ticket) return;
      if (copyTimer.current !== null) clearTimeout(copyTimer.current);
      setCopiedId(id);
      copyTimer.current = setTimeout(() => {
        if (!mounted.current || copySeq.current !== ticket) return;
        copyTimer.current = null;
        setCopiedId(null);
      }, copyResetMs);
    }, () => {});
  }, [copyResetMs]);

  const handleUpdateSkill = useCallback((agent: ExternalAgent) => {
    void runMutation(
      `update-skill:${agent}`,
      activeBridge => activeBridge.updateSkill(agent, false),
      error => {
        if (readExternalAgentsErrorCode(error) === 'SKILL_MODIFIED') {
          setPendingOverwrite(agent);
          return true;
        }
        return false;
      },
    );
  }, [runMutation]);

  const confirmOverwriteSkill = useCallback(async (agent: ExternalAgent) => {
    const succeeded = await runMutation(
      `overwrite-skill:${agent}`,
      activeBridge => activeBridge.updateSkill(agent, true),
    );
    if (mounted.current) setPendingOverwrite(null);
    return succeeded;
  }, [runMutation]);

  if (!bridge && !view) return null;

  const busy = busyAction !== null;
  const agentLabel = (agent: ExternalAgent) => t(agent === 'claude-code' ? 'externalAgents.agent.claude-code' : 'externalAgents.agent.codex');
  const agentBadge = (agent: ExternalAgent) => t(agent === 'claude-code' ? 'externalAgents.agentBadge.claude-code' : 'externalAgents.agentBadge.codex');

  if (!view) {
    return <div className="external-agents-settings" data-testid="external-agents-page">
      {errorMessage ? <WorkbenchAlert
        tone="danger"
        data-testid="external-agents-error"
        actions={<WorkbenchButton type="button" size="compact" data-testid="external-agents-retry-read" onClick={() => { void loadView(); }}>
          {t('externalAgents.action.retry')}
        </WorkbenchButton>}
      >
        {renderMessage(errorMessage)}
      </WorkbenchAlert>
        : loading ? <p role="status" className="external-agents-loading" data-testid="external-agents-loading">
          {t('externalAgents.loading')}
        </p> : null}
    </div>;
  }

  const cliInstalled = view.cli.state === 'installed';
  const cliReason = view.cli.state === 'needs-repair' || view.cli.state === 'install-failed'
    ? externalAgentsReasonMessage(view)
    : null;
  const skills = orderedExternalAgentSkills(view);
  const mcpRows = [
    { agent: 'claude-code' as const, command: view.mcpCommands.claudeCode },
    { agent: 'codex' as const, command: view.mcpCommands.codex },
  ];

  const cliBadge = view.cli.state === 'installed'
    ? { tone: 'success' as const, label: t('externalAgents.status.installed') }
    : view.cli.state === 'needs-repair'
      ? { tone: 'warning' as const, label: t('externalAgents.status.needsRepair') }
      : view.cli.state === 'install-failed'
        ? { tone: 'danger' as const, label: t('externalAgents.status.installFailed') }
        : { tone: 'neutral' as const, label: t('externalAgents.status.notInstalled') };

  const pathHint = view.cli.pathHint;

  return <div className="external-agents-settings" data-testid="external-agents-page" data-cli-state={view.cli.state}>
    {errorMessage && <WorkbenchAlert tone="danger" data-testid="external-agents-error">
      {renderMessage(errorMessage)}
    </WorkbenchAlert>}

    <section className="external-agents-section" data-testid="external-agents-cli-section">
      <div className="external-agents-section-head">
        <h2>{t('externalAgents.section.cli')}</h2>
        <WorkbenchTooltip content={t('externalAgents.cli.helpTooltip')}>
          <WorkbenchButton
            type="button"
            variant="icon"
            size="compact"
            className="external-agents-help-trigger"
            data-testid="external-agents-cli-help"
            aria-label={t('redesign.shell.help')}
          >
            <Icon name="info" size={14} />
          </WorkbenchButton>
        </WorkbenchTooltip>
      </div>

      <div className="external-agents-card external-agents-cli-row" data-testid="external-agents-cli-card">
        <div className="external-agents-cli-main">
          <span className="external-agents-cli-icon" aria-hidden="true">
            <Icon name="terminal" size={16} />
          </span>
          <span className="external-agents-cli-name" data-testid="external-agents-command-name">
            {view.commandName}
          </span>
          <WorkbenchBadge tone={cliBadge.tone} data-testid="external-agents-cli-status">
            {cliBadge.label}
          </WorkbenchBadge>

          {cliInstalled && view.cli.version && <span className="external-agents-cli-version" data-testid="external-agents-cli-version">
            {view.cli.version}
          </span>}

          {cliInstalled && view.cli.onPath === 'no' && (pathHint ? <WorkbenchPopover open={active && pathPopoverOpen} onOpenChange={setPathPopoverOpen}>
            <WorkbenchPopoverTrigger render={
              <WorkbenchButton
                type="button"
                variant="secondary"
                size="compact"
                className="external-agents-path-pill"
                data-testid="external-agents-not-on-path"
                disabled={busy}
              >
                {t('externalAgents.pathHint.badge')}
              </WorkbenchButton>
            } />
            <WorkbenchPopoverContent
              className="external-agents-path-popover"
              data-testid="external-agents-path-popover"
              side="bottom"
              align="start"
              sideOffset={8}
              zIndex={110}
              hidden={!active}
              inert={!active}
            >
              <p className="external-agents-path-popover-copy" data-testid="external-agents-path-hint-description">
                {t('externalAgents.pathHint.description', {
                  rcFile: pathHint.rcFile,
                  commandName: view.commandName,
                })}
              </p>
              <div className="external-agents-code-field">
                <code data-text-selectable data-testid="external-agents-path-hint-line">{pathHint.line}</code>
                <CopyIconButton
                  id="path-hint"
                  copied={copiedId === 'path-hint'}
                  label={t('externalAgents.action.copy')}
                  copiedLabel={t('externalAgents.action.copied')}
                  testId="external-agents-copy-path-hint"
                  onCopy={() => handleCopy('path-hint', pathHint.line)}
                />
              </div>
            </WorkbenchPopoverContent>
          </WorkbenchPopover> : <WorkbenchBadge tone="neutral" data-testid="external-agents-not-on-path">
            {t('externalAgents.pathHint.badge')}
          </WorkbenchBadge>)}

          {cliReason && <span className="external-agents-cli-reason" data-testid="external-agents-cli-reason">
            {renderMessage(cliReason)}
          </span>}
        </div>

        <div className="external-agents-cli-actions">
          {view.cli.state === 'not-installed' && <WorkbenchButton
            type="button"
            variant="primary"
            data-testid="external-agents-cli-install"
            loading={busyAction === 'install-cli:default'}
            disabled={busy}
            onClick={() => { void runMutation('install-cli:default', activeBridge => activeBridge.installCli('default')); }}
          >
            <Download size={14} aria-hidden="true" />
            <span>{t('externalAgents.action.install')}</span>
          </WorkbenchButton>}

          {cliInstalled && <>
            <div className="external-agents-path-chip" data-testid="external-agents-cli-path">
              <code data-text-selectable title={view.cli.displayPath}>{view.cli.displayPath}</code>
              <CopyIconButton
                id="cli-path"
                copied={copiedId === 'cli-path'}
                label={t('externalAgents.action.copy')}
                copiedLabel={t('externalAgents.action.copied')}
                disabled={busy}
                testId="external-agents-copy-cli-path"
                onCopy={() => handleCopy('cli-path', view.cli.commandPath ?? view.cli.displayPath)}
              />
            </div>
            <WorkbenchButton
              type="button"
              variant="ghost"
              data-testid="external-agents-cli-uninstall"
              loading={busyAction === 'uninstall-cli'}
              disabled={busy}
              onClick={() => { void runMutation('uninstall-cli', activeBridge => activeBridge.uninstallCli()); }}
            >
              {t('externalAgents.action.uninstall')}
            </WorkbenchButton>
          </>}

          {view.cli.state === 'needs-repair' && <WorkbenchButton
            type="button"
            variant="primary"
            data-testid="external-agents-cli-repair"
            loading={busyAction === 'repair-cli'}
            disabled={busy}
            onClick={() => { void runMutation('repair-cli', activeBridge => activeBridge.repairCli()); }}
          >
            <Icon name="wrench" size={14} />
            <span>{t('externalAgents.action.repair')}</span>
          </WorkbenchButton>}

          {view.cli.state === 'install-failed' && <>
            <WorkbenchButton
              type="button"
              variant="secondary"
              data-testid="external-agents-cli-choose"
              loading={busyAction === 'install-cli:choose'}
              disabled={busy}
              onClick={() => { void runMutation('install-cli:choose', activeBridge => activeBridge.installCli('choose')); }}
            >
              <FolderOpen size={14} aria-hidden="true" />
              <span>{t('externalAgents.action.chooseLocation')}</span>
            </WorkbenchButton>
            <WorkbenchButton
              type="button"
              variant="primary"
              data-testid="external-agents-cli-retry"
              loading={busyAction === 'install-cli:default'}
              disabled={busy}
              onClick={() => { void runMutation('install-cli:default', activeBridge => activeBridge.installCli('default')); }}
            >
              <RefreshCw size={14} aria-hidden="true" />
              <span>{t('externalAgents.action.retry')}</span>
            </WorkbenchButton>
          </>}
        </div>
      </div>
    </section>

    <section className="external-agents-section" data-testid="external-agents-skills-section">
      <div className="external-agents-section-head">
        <h2>{t('externalAgents.section.skills')}</h2>
      </div>

      <div className="external-agents-card">
        {skills.map(skill => {
          const badge = externalAgentSkillBadge(skill.state);
          const installDisabled = !cliInstalled;
          const installButton = <WorkbenchButton
            type="button"
            variant="secondary"
            data-testid={`external-agents-skill-install-${skill.agent}`}
            loading={busyAction === `install-skill:${skill.agent}`}
            disabled={busy || installDisabled}
            onClick={() => { void runMutation(`install-skill:${skill.agent}`, activeBridge => activeBridge.installSkill(skill.agent)); }}
          >
            <Download size={14} aria-hidden="true" />
            <span>{t('externalAgents.action.install')}</span>
          </WorkbenchButton>;

          const updateButton = <WorkbenchButton
            type="button"
            variant="primary"
            data-testid={`external-agents-skill-update-${skill.agent}`}
            loading={busyAction === `update-skill:${skill.agent}`}
            disabled={busy}
            onClick={() => handleUpdateSkill(skill.agent)}
          >
            <RefreshCw size={14} aria-hidden="true" />
            <span>{t('externalAgents.action.update')}</span>
          </WorkbenchButton>;

          return <div
            key={skill.agent}
            className="external-agents-skill-row"
            data-testid={`external-agents-skill-row-${skill.agent}`}
            data-skill-state={skill.state}
            data-directory={skill.displayDirectory}
          >
            <div className="external-agents-skill-main">
              <span className="external-agents-agent-badge" aria-hidden="true">{agentBadge(skill.agent)}</span>
              <span className="external-agents-skill-name">{agentLabel(skill.agent)}</span>
              <WorkbenchBadge tone={badge.tone} data-testid={`external-agents-skill-status-${skill.agent}`}>
                {t(badge.key)}
              </WorkbenchBadge>
            </div>

            <div className="external-agents-skill-actions">
              {skill.state === 'not-installed' && (installDisabled
                ? <WorkbenchTooltip content={t('externalAgents.cliRequiredTooltip')}>
                  <span
                    className="external-agents-disabled-wrap"
                    tabIndex={0}
                    data-testid={`external-agents-skill-disabled-${skill.agent}`}
                  >
                    {installButton}
                  </span>
                </WorkbenchTooltip>
                : installButton)}

              {skill.state === 'installed' && <WorkbenchButton
                type="button"
                variant="ghost"
                data-testid={`external-agents-skill-uninstall-${skill.agent}`}
                loading={busyAction === `uninstall-skill:${skill.agent}`}
                disabled={busy}
                onClick={() => { void runMutation(`uninstall-skill:${skill.agent}`, activeBridge => activeBridge.uninstallSkill(skill.agent)); }}
              >
                {t('externalAgents.action.uninstall')}
              </WorkbenchButton>}

              {(skill.state === 'update-available' || skill.state === 'modified') && updateButton}
            </div>
          </div>;
        })}
      </div>
    </section>

    <section className="external-agents-section" data-testid="external-agents-mcp-section">
      <div className="external-agents-section-head">
        <h2>{t('externalAgents.section.mcp')}</h2>
      </div>

      <div className="external-agents-card external-agents-mcp-card">
        {mcpRows.map(row => {
          const copyId = `mcp-${row.agent}`;
          const rowContent = <div
            className={cliInstalled ? 'external-agents-mcp-row' : 'external-agents-mcp-row is-disabled'}
            data-testid={`external-agents-mcp-row-${row.agent}`}
            data-disabled={!cliInstalled ? 'true' : undefined}
            tabIndex={!cliInstalled ? 0 : undefined}
          >
            <span className="external-agents-mcp-agent">{agentLabel(row.agent)}</span>
            <div className="external-agents-mcp-command">
              <code data-text-selectable={cliInstalled || undefined} data-testid={`external-agents-mcp-command-${row.agent}`}>
                {row.command}
              </code>
            </div>
            <CopyIconButton
              id={copyId}
              copied={copiedId === copyId}
              label={t('externalAgents.action.copy')}
              copiedLabel={t('externalAgents.action.copied')}
              disabled={!cliInstalled}
              testId={`external-agents-copy-mcp-${row.agent}`}
              onCopy={() => handleCopy(copyId, row.command)}
            />
          </div>;

          return cliInstalled
            ? <React.Fragment key={row.agent}>{rowContent}</React.Fragment>
            : <WorkbenchTooltip key={row.agent} content={t('externalAgents.cliRequiredTooltip')}>
              {rowContent}
            </WorkbenchTooltip>;
        })}
      </div>
    </section>

    <Dialog
      open={active && pendingOverwrite !== null}
      onOpenChange={open => { if (!open && !busy) setPendingOverwrite(null); }}
    >
      <WorkbenchDialogContent
        size="confirm"
        showCloseButton={false}
        className="external-agents-confirm-dialog"
        data-testid="external-agents-overwrite-dialog"
        title={pendingOverwrite ? t('externalAgents.overwriteConfirm.title', { agent: agentLabel(pendingOverwrite) }) : ''}
        description={t('externalAgents.overwriteConfirm.body')}
        footer={<>
          <WorkbenchButton
            type="button"
            variant="secondary"
            data-testid="external-agents-overwrite-cancel"
            disabled={busy}
            onClick={() => setPendingOverwrite(null)}
          >
            {t('externalAgents.action.cancel')}
          </WorkbenchButton>
          <WorkbenchButton
            type="button"
            variant="primary"
            data-testid="external-agents-overwrite-confirm"
            loading={pendingOverwrite !== null && busyAction === `overwrite-skill:${pendingOverwrite}`}
            disabled={busy}
            onClick={() => { if (pendingOverwrite) void confirmOverwriteSkill(pendingOverwrite); }}
          >
            {t('externalAgents.action.update')}
          </WorkbenchButton>
        </>}
      />
    </Dialog>
  </div>;
}
