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
import { invalidateAgentEditingOwner } from './AgentEditingBoundary.tsx';
import {
  createRetainedEditingClient, matchesEditingBatchReceipt, RetainedEditingConflict,
} from './agent-retained-editing.ts';
import type { NativeCloseSourceRegistry } from './native-close-sources.ts';
import { taskDisplayTargets } from './agent-task-presentation.ts';
import type { TaskDisplayLookup } from './agent-task-presentation.ts';

type PendingResolve = AgentTaskEditingInput | AgentTaskEditingResolveBatchInput;

/** An unconfirmed clear can only query its original durable receipt. */
export default function AgentRetainedEditing({ projectId, visible, readOnly, nativeCloseRegistry, recovery, targetName }: {
  projectId: string; visible: boolean; readOnly: boolean; nativeCloseRegistry?: unknown; recovery?: ReactNode; targetName?: TaskDisplayLookup;
}) {
  const {t, locale} = useI18n(), confirm = useConfirmation();
  const [claims, setClaims] = useState<AgentTaskEditingClaimOwner[]>([]);
  const [busy, setBusy] = useState(false), [unknown, setUnknown] = useState(false);
  const client = useRef(createRetainedEditingClient());
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
    setBusy(false); setClaims([]); setUnknown(false);
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

  useLayoutEffect(() => { if (visible) void load(); }, [projectId, visible]);

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
    const groups = await client.current.read(projectId);
    if (isCurrent(token)) {
      setClaims(groups.flatMap(group => group.owners));
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

  async function resolve({claim, generation, sequence, claimSnapshot}: AgentTaskEditingClaimOwner) {
    const canResolve = () => !flight.current && !pending.current && !receiptBlocked.current &&
      view.current.visible && !view.current.readOnly && view.current.projectId === projectId;
    if (generation === null || sequence === null || !canResolve()) return;
    const token = epoch.current, viewToken = view.current;
    if (!await confirm(message('agent.task.editingResolve')) || !isCurrent(token) || viewToken !== view.current || !canResolve()) return;
    const input: AgentTaskEditingResolveBatchInput = {
      requestId: crypto.randomUUID(), projectId, claims: [{claimId: claim.id, ownerId: claim.ownerId, generation, sequence, claimSnapshot}],
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

  const retained = claims.filter(owner => owner.liveness === 'retained' && owner.generation !== null && owner.sequence !== null);
  if (!recovery && !unknown && !retained.length) return null;
  return <section className="mio-card agent-task-retained-editing" data-testid="agent-retained-editing">
    <strong>{t('agent.panel.recoveryTitle')}</strong>{recovery}
    <div className="mio-retained-items">
      {unknown && <p role="alert">{t('agent.task.editingUnknown')}</p>}
      {retained.map(owner => {
        const {claim} = owner;
        const kind = AGENT_TASK_DISPLAY_TARGET_KINDS.find(value => value === agentTaskEditingTargetRevisionKind(claim.target.kind)) ?? 'unknown';
        return <article key={claim.id}>
          <p>{t('agent.panel.editingItem')} · {taskDisplayTargets({operation: '', targets: [{kind, id: claim.target.id}], targetCount: 1, fields: []}, locale, targetName)}</p>
          <Button type="button" disabled={!visible || readOnly || busy || receiptBlocked.current || Boolean(pending.current)} onClick={() => {void resolve(owner);}}>{t('agent.task.editingResolve')}</Button>
        </article>;
      })}
      {(unknown || retained.length > 0) && <Button type="button" variant="ghost" disabled={!visible || busy || receiptBlocked.current} onClick={() => {void load();}}>{t(pending.current ? 'agent.task.confirmRead' : 'agent.task.reload')}</Button>}
    </div>
  </section>;
}
