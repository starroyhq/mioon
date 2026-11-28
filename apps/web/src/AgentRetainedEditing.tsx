import React, { useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { WorkbenchButton as Button } from '@mioon/ui/components/workbench-controls';
import { useConfirmation } from '@mioon/ui/components/workbench-confirm';
import { message } from '../../../packages/i18n/src/index.ts';
import {
  AGENT_TASK_DISPLAY_TARGET_KINDS, agentTaskEditingResolveBatchSchema, agentTaskEditingSchema, agentTaskEditingTargetRevisionKind,
} from '../../../packages/contracts/src/agent-tasks-v2.ts';
import type {
  AgentTaskEditingClaimOwner, AgentTaskEditingInput, AgentTaskEditingResolveBatchInput,
} from '../../../packages/contracts/src/agent-tasks-v2.ts';
import { useI18n } from './i18n/I18nProvider.tsx';
import { createAgentEditingClient } from './agent-editing-protection.ts';
import {
  agentRetainedEditingEvidence,
  invalidateAgentEditingOwner,
  releaseLocalAgentEditingOwner,
  subscribeAgentEditingChanges,
} from './AgentEditingBoundary.tsx';
import {
  createRetainedEditingClient, matchesEditingBatchReceipt, RetainedEditingConflict,
} from './agent-retained-editing.ts';
import type { RetainedEditingLocalEvidence, RetainedEditingStatus, RetainedEditingStatusView } from './agent-retained-editing.ts';
import type { NativeCloseSourceRegistry } from './native-close-sources.ts';
import { taskDisplayTargets } from './agent-task-presentation.ts';
import type { TaskDisplayLookup } from './agent-task-presentation.ts';
import Icon from './icons.tsx';
import './mio-co-editing.css';

type PendingResolve = AgentTaskEditingInput | AgentTaskEditingResolveBatchInput;
type GroupView = RetainedEditingStatusView['groups'][number];

export interface RetainedEditingLocator {
  kind: string;
  id: string;
}

const MAX_BATCH_CLAIMS = 100;

function statusMessageKey(status: RetainedEditingStatus) {
  switch (status) {
    case 'local_unsaved': return 'agent.coEdit.status.local_unsaved' as const;
    case 'local_occupied': return 'agent.coEdit.status.local_occupied' as const;
    case 'another_window': return 'agent.coEdit.status.another_window' as const;
    default: return 'agent.coEdit.status.unconfirmed' as const;
  }
}

/** An unconfirmed clear can only query its original durable receipt. */
export default function AgentRetainedEditing({
  projectId,
  visible,
  readOnly,
  nativeCloseRegistry,
  recovery,
  targetName,
  readDraft,
  onLocateTarget,
}: {
  projectId: string;
  visible: boolean;
  readOnly: boolean;
  nativeCloseRegistry?: unknown;
  recovery?: ReactNode;
  targetName?: TaskDisplayLookup;
  readDraft?: RetainedEditingLocalEvidence['readDraft'];
  onLocateTarget?: (locator: RetainedEditingLocator) => unknown;
}) {
  const {t, locale} = useI18n(), confirm = useConfirmation();
  const [statusView, setStatusView] = useState<RetainedEditingStatusView | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false), [unknown, setUnknown] = useState(false);
  const client = useRef(createRetainedEditingClient());
  const readDraftRef = useRef(readDraft);
  readDraftRef.current = readDraft;
  const flight = useRef(false), epoch = useRef(0), mounted = useRef(false), receiptBlocked = useRef(false);
  const view = useRef({projectId, visible, readOnly});
  if (view.current.projectId !== projectId || view.current.visible !== visible || view.current.readOnly !== readOnly) {
    view.current = {projectId, visible, readOnly};
  }
  const key = `mioon.agent-editing-recovery.${projectId}`;
  const pending = useRef<PendingResolve | null>(null), version = useRef(0);
  const source = useRef<ReturnType<NativeCloseSourceRegistry['register']> | null>(null);
  const report = () => source.current?.update({
    dirty: false, busy: flight.current, blocked: Boolean(pending.current) || receiptBlocked.current, version: ++version.current,
  });
  const isCurrent = (token: number) => mounted.current && token === epoch.current;
  function persist(value: PendingResolve | null) {
    try {
      if (value) sessionStorage.setItem(key, JSON.stringify(value));
      else sessionStorage.removeItem(key);
      pending.current = value;
    } catch (error) {
      receiptBlocked.current = true;
      throw error;
    } finally { report(); }
  }

  useLayoutEffect(() => {
    mounted.current = true;
    source.current = (nativeCloseRegistry as NativeCloseSourceRegistry | undefined)?.register('agent-editing-recovery-v2') ?? null;
    pending.current = null; receiptBlocked.current = false; flight.current = false;
    setBusy(false); setStatusView(null); setUnknown(false); setExpanded(false);
    try {
      const raw = sessionStorage.getItem(key);
      if (raw) {
        const input: unknown = JSON.parse(raw), batch = agentTaskEditingResolveBatchSchema.safeParse(input);
        const saved = batch.success ? batch.data : agentTaskEditingSchema.parse(input);
        if (saved.projectId !== projectId || 'action' in saved && saved.action !== 'resolve') throw Error('Invalid retained editing receipt');
        pending.current = saved;
        setUnknown(true);
      }
    } catch {
      receiptBlocked.current = true;
      setUnknown(true);
    }
    report();
    return () => {
      mounted.current = false;
      epoch.current++;
      source.current?.release();
      source.current = null;
    };
  }, [projectId, nativeCloseRegistry]);

  useLayoutEffect(() => {
    if (!visible) return;
    void load();
    return subscribeAgentEditingChanges(() => {
      if (mounted.current && view.current.visible && !flight.current && !pending.current && !receiptBlocked.current) {
        void load();
      }
    });
  }, [projectId, visible]);

  function startFlight(): number {
    flight.current = true;
    setBusy(true);
    report();
    return ++epoch.current;
  }

  function finishFlight(token: number) {
    if (!isCurrent(token)) return;
    flight.current = false;
    setBusy(false);
    report();
  }

  async function readClaims(token: number) {
    const evidence = agentRetainedEditingEvidence(projectId, owner => readDraftRef.current?.(owner));
    const next = await client.current.readStatus(projectId, evidence);
    if (isCurrent(token)) {
      setStatusView(next);
      setUnknown(false);
    }
  }

  async function load() {
    if (flight.current || !visible || receiptBlocked.current) return;
    const token = startFlight();
    try {
      const original = pending.current;
      if (original) {
        let acknowledged: boolean;
        if ('action' in original) {
          const next = await createAgentEditingClient().lookup?.(projectId, original.ownerId, original.requestId);
          if (!isCurrent(token)) return;
          invalidateAgentEditingOwner(projectId, original.ownerId);
          const receipt = next?.receipt;
          acknowledged = receipt?.requestId === original.requestId && !receipt.error && receipt.projectId === projectId &&
            receipt.ownerId === original.ownerId && receipt.generation === original.generation && receipt.sequence === original.sequence;
        } else {
          acknowledged = matchesEditingBatchReceipt(original, await client.current.lookup(projectId, original.requestId));
        }
        if (!isCurrent(token)) return;
        if (!acknowledged) { setUnknown(true); return; }
        persist(null);
      }
      await readClaims(token);
    } catch {
      if (isCurrent(token)) setUnknown(true);
    } finally { finishFlight(token); }
  }

  async function resolveOwners(ownersToEnd: readonly AgentTaskEditingClaimOwner[], confirmDescriptor: ReturnType<typeof message>) {
    const canResolve = () => !flight.current && !pending.current && !receiptBlocked.current &&
      view.current.visible && !view.current.readOnly && view.current.projectId === projectId;
    const batch = ownersToEnd
      .filter((owner): owner is AgentTaskEditingClaimOwner & {generation: number; sequence: number} =>
        owner.liveness === 'retained' && owner.generation !== null && owner.sequence !== null)
      .slice(0, MAX_BATCH_CLAIMS);
    if (!batch.length || !canResolve()) return;
    const token = epoch.current, viewToken = view.current;
    if (!await confirm(confirmDescriptor) || !isCurrent(token) || viewToken !== view.current || !canResolve()) return;
    const input: AgentTaskEditingResolveBatchInput = {
      requestId: crypto.randomUUID(),
      projectId,
      claims: batch.map(({claim, generation, sequence, claimSnapshot}) => ({
        claimId: claim.id,
        ownerId: claim.ownerId,
        generation,
        sequence,
        claimSnapshot,
      })),
    };
    try { persist(input); } catch { setUnknown(true); return; }
    const attempt = startFlight();
    try {
      try {
        if (!matchesEditingBatchReceipt(input, await client.current.resolve(input))) throw Error('Batch receipt mismatch');
      } catch (error) {
        if (!(error instanceof RetainedEditingConflict)) throw error;
      }
      if (!isCurrent(attempt)) return;
      persist(null);
      await readClaims(attempt);
    } catch {
      if (isCurrent(attempt)) setUnknown(true);
    } finally { finishFlight(attempt); }
  }

  async function endGroup(group: GroupView) {
    if (group.canEnd) {
      await resolveOwners(
        group.owners.filter(owner => owner.canEnd),
        message('agent.task.editingResolve'),
      );
      return;
    }
    const canResolve = () => !flight.current && !pending.current && !receiptBlocked.current &&
      view.current.visible && !view.current.readOnly && view.current.projectId === projectId;
    if (!canResolve()) return;
    const isLocal = group.status === 'local_occupied' || group.status === 'local_unsaved';
    if (!isLocal) return;
    const token = epoch.current, viewToken = view.current;
    if (group.status === 'local_unsaved') {
      if (!await confirm(message('agent.task.editingDiscardConfirm')) || !isCurrent(token) || viewToken !== view.current || !canResolve()) return;
    }
    const attempt = startFlight();
    try {
      const ownerIds = [...new Set(group.owners.map(owner => owner.claim.ownerId))];
      for (const ownerId of ownerIds) {
        await releaseLocalAgentEditingOwner(projectId, ownerId, { discardUnsaved: group.status === 'local_unsaved' });
      }
      if (!isCurrent(attempt)) return;
      await readClaims(attempt);
    } catch {
      if (isCurrent(attempt)) setUnknown(true);
    } finally { finishFlight(attempt); }
  }

  async function endAll() {
    if (!statusView) return;
    const endable = statusView.groups.flatMap(group => group.owners.filter(owner => owner.canEnd));
    if (!endable.length) return;
    await resolveOwners(endable, message('agent.coEdit.endAllConfirm', { count: statusView.endableGroupCount }));
  }

  const groups = statusView?.groups ?? [];
  const endableGroupCount = statusView?.endableGroupCount ?? 0;
  const open = expanded || unknown;
  const disabled = !visible || readOnly || busy || receiptBlocked.current || Boolean(pending.current);

  if (!recovery && !unknown && !groups.length) return null;

  return <div className="mio-retained-container" data-testid="agent-retained-editing">
    {recovery && <section className="mio-card"><strong>{t('agent.panel.recoveryTitle')}</strong>{recovery}</section>}
    {(groups.length > 0 || unknown) && <>
      <div className="mio-retained-bar">
        <Button
          type="button"
          variant="ghost"
          size="compact"
          className="mio-retained-toggle"
          data-testid="agent-retained-toggle"
          aria-expanded={open}
          onClick={() => setExpanded(value => !value)}
        >
          <Icon name="arrow" size={12} />
          <span>{t('agent.coEdit.retainedBar', { count: groups.length })}</span>
        </Button>
        {open && <div className="mio-retained-bar-actions">
          {!unknown && groups.length > 0 && (
            <Button
              type="button"
              variant="icon"
              size="compact"
              className="mio-retained-reload-icon"
              data-testid="agent-retained-reload"
              aria-label={t('agent.task.reload')}
              title={t('agent.task.reload')}
              disabled={!visible || busy || receiptBlocked.current}
              onClick={() => { void load(); }}
            >
              <Icon name="refresh" size={12} />
            </Button>
          )}
          {endableGroupCount > 0 && (
            <Button
              type="button"
              variant="secondary"
              size="compact"
              className="mio-retained-end-all"
              data-testid="agent-retained-end-all"
              disabled={disabled}
              onClick={() => { void endAll(); }}
            >
              {t('agent.coEdit.endAll', { count: endableGroupCount })}
            </Button>
          )}
        </div>}
      </div>
      {open && <div className="mio-retained-list" data-testid="agent-retained-list">
        {unknown && <div className="mio-retained-unknown-row">
          <p role="alert">{t('agent.task.editingUnknown')}</p>
          <Button
            type="button"
            variant="ghost"
            size="compact"
            data-testid="agent-retained-reload"
            disabled={!visible || busy || receiptBlocked.current}
            onClick={() => { void load(); }}
          >
            {t(pending.current ? 'agent.task.confirmRead' : 'agent.task.reload')}
          </Button>
        </div>}
        {groups.map(group => {
          const kind = AGENT_TASK_DISPLAY_TARGET_KINDS.find(value => value === agentTaskEditingTargetRevisionKind(group.kind)) ?? 'unknown';
          const title = taskDisplayTargets({operation: '', targets: [{kind, id: group.id}], targetCount: 1, fields: []}, locale, targetName);
          const foreignInUseOnly = group.status === 'another_window' && !group.canEnd;
          const canEndRow = group.canEnd || group.status === 'local_occupied' || group.status === 'local_unsaved';
          return <article key={`${group.kind}:${group.id}`} className="mio-retained-row" data-testid="agent-retained-row" data-status={group.status}>
            <div className="mio-retained-info">
              <span className="mio-retained-title" title={title}>{title}</span>
              <span className="mio-retained-status" data-status={group.status} data-testid="agent-retained-status">
                {group.status === 'local_unsaved' && <span className="mio-retained-status-dot" aria-hidden="true" />}
                {group.status === 'another_window' && <Icon name="window" size={11} />}
                <span>{t(statusMessageKey(group.status))}</span>
              </span>
            </div>
            <div className="mio-retained-actions">
              {foreignInUseOnly ? (
                <span className="mio-retained-in-use" data-testid="agent-retained-in-use">{t('agent.coEdit.inUse')}</span>
              ) : <>
                {onLocateTarget && (
                  <Button
                    type="button"
                    variant="icon"
                    size="compact"
                    className="mio-retained-locate"
                    data-testid="agent-retained-locate"
                    aria-label={t('agent.task.locate')}
                    disabled={!visible}
                    onClick={() => { onLocateTarget(group.locator); }}
                  >
                    <Icon name="locate" size={13} />
                  </Button>
                )}
                {canEndRow && (
                  <Button
                    type="button"
                    variant="secondary"
                    size="compact"
                    className="mio-retained-end"
                    data-testid="agent-retained-end"
                    disabled={disabled}
                    onClick={() => { void endGroup(group); }}
                  >
                    {t('agent.coEdit.endOne')}
                  </Button>
                )}
              </>}
            </div>
          </article>;
        })}
      </div>}
    </>}
  </div>;
}
