import React, { createContext, useContext, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Button } from '@mioon/ui/components/button';
import { useConfirmation } from '@mioon/ui/components/workbench-confirm';
import { WorkbenchTooltip } from '@mioon/ui/components/workbench-tooltip';
import Icon from './icons.tsx';
import { useI18n } from './i18n/I18nProvider.tsx';
import { message } from '../../../packages/i18n/src/index.ts';
import type { AgentTaskTarget } from '../../../packages/contracts/src/agent-tasks-v2.ts';
import { createAgentEditingProtection, agentEditingOwnerIdentity, agentEditingOwnerInWindow } from './agent-editing-protection.ts';
import type { AgentEditingState } from './agent-editing-protection.ts';
import type { NativeCloseSourceRegistry } from './native-close-sources.ts';
import type { AgentEditingProof } from './agent-editing-proof.ts';
import { useWorkspaceVisibility } from './workspace-visibility.tsx';
import './agent-task-v2.css';

const EditingContext = createContext<() => boolean>(() => true);
export const useAgentEditingAdmission = () => useContext(EditingContext);
let liveWindowOwner: string | null = null;
let nativeWindowOwner: string | null = null;
export function setNativeAgentEditingWindowOwner(windowId: string | null): void { nativeWindowOwner = windowId; }
// A duplicated tab copies sessionStorage. A fresh realm must never inherit the
// power to release the original window's live draft protection.
export function agentEditingWindowOwner(): string { return nativeWindowOwner ?? (liveWindowOwner ??= crypto.randomUUID()); }
type Protection = ReturnType<typeof createAgentEditingProtection>;
interface EditingParticipant { visible: boolean; clean: boolean; canRelease: () => boolean }
interface EditingOwner {
  projectId: string;
  ownerId: string;
  controller: Protection;
  listeners: Set<(state: AgentEditingState) => void>;
  participants: Set<EditingParticipant>;
  departed: Set<EditingParticipant>;
  acquiring?: Promise<boolean>;
  reading?: Promise<boolean>;
  holdKey?: string;
}
const owners = new Map<string, EditingOwner>();
const closeListeners = new Set<() => void>();
const targetKey = (targets: readonly Pick<AgentTaskTarget, 'kind' | 'id'>[]) =>
  targets.map(target => JSON.stringify([target.kind, target.id])).sort();
const editingKey = (projectId: string, targets: readonly Pick<AgentTaskTarget, 'kind' | 'id'>[]) =>
  JSON.stringify([projectId, nativeWindowOwner, targetKey(targets)]);
const holdKey = (projectId: string, { kind, id }: Pick<AgentTaskTarget, 'kind' | 'id'>) => JSON.stringify([projectId, kind, id]);
function protection(projectId: string, targets: readonly AgentTaskTarget[]): EditingOwner {
  const key = editingKey(projectId, targets);
  const present = owners.get(key); if (present) return present;
  const listeners = new Set<(state: AgentEditingState) => void>();
  // Workspace/recovery scopes are not editing identities. Imperative edits
  // and all controls in one window share the controller for their target set.
  const ownerId = agentEditingOwnerIdentity(nativeWindowOwner ? 'desktop' : 'normal', agentEditingWindowOwner(), targets);
  const controller = createAgentEditingProtection({ projectId, ownerId, targets, onChange: next => { for (const listener of listeners) listener(next); for (const listener of closeListeners) listener(); } });
  const entry = { projectId, ownerId, controller, listeners, participants: new Set<EditingParticipant>(), departed: new Set<EditingParticipant>(), holdKey: targets.length === 1 ? holdKey(projectId, targets[0]) : undefined };
  owners.set(key, entry);
  return entry;
}
function refreshOwner(entry: EditingOwner): Promise<boolean> {
  return entry.reading ??= entry.controller.refresh().finally(() => { entry.reading = undefined; });
}
function acquireOwner(entry: EditingOwner): Promise<boolean> {
  if (entry.controller.canEdit()) return Promise.resolve(true);
  return entry.acquiring ??= (async () => {
    if (entry.reading) await entry.reading;
    return entry.controller.canEdit() || await entry.controller.acquire();
  })().finally(() => { entry.acquiring = undefined; });
}
const targetOwner = (projectId: string, kind: string, id: string) => owners.get(editingKey(projectId, [{ kind, id }]));
export function agentEditingOwnedByThisWindow(ownerId: string): boolean { return agentEditingOwnerInWindow(ownerId, nativeWindowOwner ? 'desktop' : 'normal', agentEditingWindowOwner()); }
export function invalidateAgentEditingOwner(projectId: string, ownerId: string): void { for (const entry of owners.values()) if (entry.projectId === projectId && entry.ownerId === ownerId) entry.controller.invalidate(); }
export function agentEditingTargetActive(projectId: string, kind: string, id: string): boolean { return targetOwner(projectId, kind, id)?.controller.canEdit() ?? false; }
export function agentEditingProof(projectId:string,kind:string,id:string):AgentEditingProof|null {const entry=targetOwner(projectId,kind,id),state=entry?.controller.getState(),claim=state?.claims.find(value=>value.target.kind===kind&&value.target.id===id);return entry?.controller.canEdit()&&claim&&typeof state?.timelineRevision==='number'?{ownerId:claim.ownerId,kind,id,revision:state.targets?.find(target=>target.kind===kind&&target.id===id)?.revision??0,timelineRevision:state.timelineRevision}:null;}
export async function refreshAgentEditingTargets(projectId: string): Promise<void> {
  await Promise.allSettled([...owners.values()].filter(entry => entry.projectId === projectId &&
    (entry.participants.size || entry.acquiring || entry.controller.getState().phase !== 'idle')).map(refreshOwner));
}
export function subscribeAgentEditingChanges(listener:()=>void):()=>void{closeListeners.add(listener);return()=>{closeListeners.delete(listener);};}
function editingCloseIdentity(id: string, state: AgentEditingState): readonly unknown[] {
  const target = ({kind, id, revision}: AgentTaskTarget) => [kind, id, revision];
  const ordered = (values: readonly unknown[][]) => values.map(value => JSON.stringify(value)).sort();
  const pending = state.pending;
  // Actual target/claim authority changes still revoke close consent. Fresh
  // response objects, server timestamps and ledger ordering are observations,
  // not new input; only this local signature sees the target identifiers.
  return [id, state.phase, pending ? [pending.requestId, pending.projectId, pending.ownerId, pending.generation, pending.sequence, pending.action,
    ordered(pending.targets.map(target))] : null, state.timelineRevision,
    ordered((state.targets ?? []).map(target)), ordered(state.claims.map(claim => [claim.id, claim.projectId, claim.ownerId, ...target(claim.target), claim.state]))];
}
export function watchAgentEditingClose(registry: NativeCloseSourceRegistry): () => void {
  const source = registry.register('agent-editing-v2'); let version = 0, previous = '';
  const update = () => { const states = [...owners.entries()].map(([id, entry]) => ({ id, ...entry.controller.getState() })), signature = JSON.stringify(states.map(state => editingCloseIdentity(state.id, state))); if (signature === previous) return; previous = signature; source.update({ dirty: false, busy: states.some(state => ['acquiring', 'releasing'].includes(state.phase)), blocked: states.some(state => Boolean(state.pending) || ['uncertain', 'retained'].includes(state.phase)), version: ++version }); };
  closeListeners.add(update); update(); return () => { closeListeners.delete(update); source.release(); };
}
export async function acquireAgentEditingTarget(projectId: string, target: AgentTaskTarget): Promise<boolean> {
  try { return await acquireOwner(protection(projectId, [target])); } catch { return false; }
}
function ownerCanRelease(entry: EditingOwner): boolean {
  try {
    // Unmount is not a discard acknowledgment. A detached dirty or pending
    // editor must still prohibit a later pagehide or sibling's release.
    return !entry.departed.size && !(entry.holdKey && holds.get(entry.holdKey)?.count) && [...entry.participants].every(participant => participant.canRelease());
  } catch { return false; }
}
const hasVisibleParticipant = (entry: EditingOwner) => [...entry.participants].some(participant => participant.visible);
function deferRelease(entry: EditingOwner, allowed: () => boolean): void {
  // A selection replacement or StrictMode remount can attach to this same
  // claim in the same commit. Read the new guards before changing the ledger.
  setTimeout(() => {
    void (async () => {
      await entry.acquiring;
      await entry.reading;
      if (entry.controller.canEdit() && allowed() && ownerCanRelease(entry)) await entry.controller.release();
    })().catch(() => {});
  }, 0);
}
/** The navigation guard calls after discarding the current drafts, before
 * changing selection and repointing the corresponding draft controllers. */
export function settleDiscardedAgentEditingDrafts(projectId: string | null): void {
  for (const entry of owners.values()) {
    if (entry.projectId !== projectId) continue;
    let settled = false;
    for (const participant of entry.participants) {
      if (!participant.clean && participant.canRelease()) { participant.clean = true; settled = true; }
    }
    if (settled) deferRelease(entry, () => true);
  }
}
export function releaseUnobservedAgentEditingTarget(projectId: string, target: AgentTaskTarget): void {
  const entry = targetOwner(projectId, target.kind, target.id);
  if (entry) deferRelease(entry, () => !hasVisibleParticipant(entry));
}
/** A pagehide without BFCache is the end of a normal document. Keepalive lets
 * its final release reach the host without making it part of the native close
 * ticket. Uncertain requests, dirty drafts and active holds remain durable. */
export function releaseCleanAgentEditingOnPageHide(): void {
  for (const entry of owners.values()) {
    if (entry.controller.canEdit() && ownerCanRelease(entry)) void entry.controller.release(true);
  }
}
interface EditingHold { count: number; claimed: boolean; timer: ReturnType<typeof setTimeout> | null }
const holds = new Map<string, EditingHold>();
/**
 * Holds editing protection of one target while a full-window editor is open
 * (the camera previs editor), so Mio's writes to it are refused as for any edit. It
 * claims the target unless this window already protects it, and on release
 * gives back only a claim it made. Releasing waits one task, so a StrictMode
 * remount keeps the same claim.
 */
export function holdAgentEditingTarget(projectId: string, target: AgentTaskTarget): (settled?: boolean) => void {
  const key = holdKey(projectId, target);
  let hold = holds.get(key);
  if (hold) {
    if (hold.timer) { clearTimeout(hold.timer); hold.timer = null; }
    hold.count++;
  } else {
    const created: EditingHold = { count: 1, claimed: false, timer: null };
    hold = created; holds.set(key, created);
    if (!agentEditingTargetActive(projectId, target.kind, target.id)) void acquireAgentEditingTarget(projectId, target).then(claimed => {
      created.claimed = claimed;
      const next = holds.get(key);
      if (!claimed || next === created) return;
      // The editor closed while the claim was being made: an editor opened
      // again on the same target takes it over, otherwise it goes now.
      if (next) next.claimed = true;
      else {
        const entry = targetOwner(projectId, target.kind, target.id);
        if (entry) deferRelease(entry, () => true);
      }
    });
  }
  const current = hold;
  let done = false;
  return (settled = true) => {
    if (done) return;
    done = true;
    if (!settled) targetOwner(projectId, target.kind, target.id)?.controller.invalidate();
    if (--current.count > 0) return;
    current.timer = setTimeout(() => {
      current.timer = null;
      if (current.count > 0 || holds.get(key) !== current) return;
      holds.delete(key);
      const entry = targetOwner(projectId, target.kind, target.id);
      if (entry) deferRelease(entry, () => current.claimed || !hasVisibleParticipant(entry));
    }, 0);
  };
}
export interface AgentEditingBoundaryProps { projectId?: string | null; workspaceScope?: string; targets: readonly AgentTaskTarget[]; disabled?: boolean; controlsOnly?: boolean; autoAcquire?: boolean; canRelease: () => boolean; onDiscard?: () => unknown; children: ReactNode | ((allowed: boolean) => ReactNode) }
export default function AgentEditingBoundary(props: AgentEditingBoundaryProps) {
  const identity = JSON.stringify([props.projectId, targetKey(props.targets)]);
  if (props.disabled || !props.projectId || !props.targets.length) return <>{typeof props.children === 'function' ? props.children(Boolean(props.disabled)) : props.children}</>;
  return <OwnedEditingBoundary key={identity} {...props} projectId={props.projectId} />;
}
function OwnedEditingBoundary({ projectId, targets, canRelease, onDiscard, children, controlsOnly = false, autoAcquire = false }: Omit<AgentEditingBoundaryProps, 'projectId'> & { projectId: string }) {
  const { t } = useI18n(), confirm = useConfirmation(), visible = useWorkspaceVisibility();
  const [state, setState] = useState<AgentEditingState>({ phase: 'loading', claims: [], pending: null });
  const owner = useRef<EditingOwner | null>(null), release = useRef(canRelease), discard = useRef(onDiscard);
  release.current = canRelease; discard.current = onDiscard;
  const clean = canRelease(), previous = useRef({visible, clean}), autoAcquired = useRef(false);
  const participant = useRef<EditingParticipant>({visible, clean, canRelease: () => release.current()});
  useLayoutEffect(() => {
    let entry: EditingOwner;
    try { entry = protection(projectId, targets); } catch { setState({ phase: 'uncertain', claims: [], pending: null }); return; }
    owner.current = entry;
    const registered = participant.current, listener = (next: AgentEditingState) => setState(next);
    entry.departed.delete(registered);
    entry.participants.add(registered);
    entry.listeners.add(listener);
    setState(entry.controller.getState());
    if (entry.controller.getState().phase === 'idle' && !entry.acquiring) void refreshOwner(entry);
    return () => {
      entry.listeners.delete(listener);
      entry.participants.delete(registered);
      if (!registered.clean) entry.departed.add(registered);
      if (owner.current === entry) owner.current = null;
      deferRelease(entry, () => !hasVisibleParticipant(entry));
    };
  }, []);
  useLayoutEffect(() => {
    participant.current.visible = visible;
    participant.current.clean = clean;
    const was = previous.current, entry = owner.current;
    previous.current = {visible, clean};
    if (!entry) return;
    if (!was.clean && clean) deferRelease(entry, () => true);
    else if (was.visible && !visible) deferRelease(entry, () => !hasVisibleParticipant(entry));
  }, [visible, clean]);
  useLayoutEffect(() => {
    if (!visible || !autoAcquire) { autoAcquired.current = false; return; }
    if (state.phase === 'active') autoAcquired.current = true;
    if (autoAcquire && state.phase === 'idle' && owner.current && !autoAcquired.current) {
      autoAcquired.current = true;
      void acquireOwner(owner.current);
    }
  }, [visible, autoAcquire, state.phase]);
  async function discardRetained() {
    const entry = owner.current, action = discard.current;
    if (!entry || !action || !await confirm(message('agent.task.editingDiscardConfirm')) || entry !== owner.current) return;
    const observed = entry.controller.getState();
    if (observed.phase !== 'retained' || observed.pending || await action() === false) return;
    // The discard may update React's dirty guard on its next commit.
    setTimeout(() => {
      if (entry === owner.current && entry.controller.getState() === observed && ownerCanRelease(entry)) void entry.controller.resolve();
    }, 0);
  }
  const allowed = state.phase === 'active', busy = ['loading', 'acquiring', 'releasing'].includes(state.phase);
  const admission = () => owner.current?.controller.canEdit() ?? false;
  const reject = (event: React.SyntheticEvent) => { if (!admission()) { event.preventDefault(); event.stopPropagation(); } };
  // Starting and finishing an edit is one compact control; its hint and the announced status keep the full
  // explanation. Recovery states need a decision, so they keep the explanatory card.
  const recovery = state.phase === 'uncertain' || state.phase === 'retained';
  return <EditingContext.Provider value={admission}><div className={`agent-editing-owner${controlsOnly ? ' agent-editing-canvas' : ''}`} data-editing-targets={targets.map(target => `${target.kind}:${target.id}`).join(',')} data-editing-phase={state.phase}>
    <div className={`agent-editing-protection${recovery ? '' : ' is-compact'}`} data-testid="agent-editing-protection"><p role="status" className={recovery ? undefined : 'sr-only'}>{t(allowed ? 'agent.task.editingActive' : recovery ? 'agent.task.editingUnknown' : 'agent.task.editingHint')}</p>
      {state.phase === 'idle' && <WorkbenchTooltip content={t('agent.task.editingHint')}><Button type="button" size="sm" variant="outline" data-testid="agent-editing-start" aria-label={t('agent.task.editingStart')} onClick={() => { if (owner.current) void acquireOwner(owner.current); }}><Icon name="pencil" size={12} />{t('agent.task.editingStartShort')}</Button></WorkbenchTooltip>}
      {allowed && <WorkbenchTooltip content={t('agent.task.editingActive')}><Button type="button" size="sm" variant="outline" data-testid="agent-editing-release" disabled={!clean} onClick={() => { const entry = owner.current; if (entry && ownerCanRelease(entry)) void entry.controller.release(); }}>{t('agent.task.editingRelease')}</Button></WorkbenchTooltip>}
      {state.phase === 'retained' && <Button type="button" size="sm" variant="outline" data-testid="agent-editing-restore" onClick={()=>{void owner.current?.controller.restore();}}>{t('agent.task.editingRestore')}</Button>}
      {state.phase === 'retained' && onDiscard && !clean && <Button type="button" size="sm" variant="outline" data-testid="agent-editing-discard" onClick={() => { void discardRetained(); }}>{t('agent.task.editingDiscard')}</Button>}
      {state.phase === 'retained' && <Button type="button" size="sm" variant="outline" data-testid="agent-editing-resolve" onClick={() => { void (async () => { const entry = owner.current; if (entry && ownerCanRelease(entry) && await confirm(message('agent.task.editingResolve')) && entry === owner.current && ownerCanRelease(entry)) await entry.controller.resolve(); })(); }}>{t('agent.task.editingResolve')}</Button>}
      {state.phase === 'uncertain' && <Button type="button" size="sm" variant="outline" data-testid="agent-editing-query" disabled={busy} onClick={() => { if (owner.current) void refreshOwner(owner.current); }}>{t('agent.task.confirmRead')}</Button>}
    </div>
    {controlsOnly ? typeof children === 'function' ? children(allowed) : children : <fieldset className="agent-editing-fields" disabled={!allowed} onBeforeInputCapture={reject} onCompositionStartCapture={reject} onPointerDownCapture={reject} onKeyDownCapture={reject} onDragStartCapture={reject}>{typeof children === 'function' ? children(allowed) : children}</fieldset>}
  </div></EditingContext.Provider>;
}
