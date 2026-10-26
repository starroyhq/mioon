import React, { createContext, useContext, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Button } from '@mioon/ui/components/button';
import { useConfirmation } from '@mioon/ui/components/workbench-confirm';
import { useI18n } from './i18n/I18nProvider.tsx';
import { message } from '../../../packages/i18n/src/index.ts';
import type { AgentTaskTarget } from '../../../packages/contracts/src/agent-tasks-v2.ts';
import { createAgentEditingProtection, agentEditingOwnerIdentity, agentEditingOwnerInWindow } from './agent-editing-protection.ts';
import type { AgentEditingState } from './agent-editing-protection.ts';
import type { NativeCloseSourceRegistry } from './native-close-sources.ts';
import type { AgentEditingProof } from './agent-editing-proof.ts';
import './agent-task-v2.css';

const EditingContext = createContext<() => boolean>(() => true);
export const useAgentEditingAdmission = () => useContext(EditingContext);
let liveWindowOwner: string | null = null;
// A duplicated tab copies sessionStorage. A fresh realm must never inherit the
// power to release the original window's live draft protection.
export function agentEditingWindowOwner(): string { return liveWindowOwner ??= crypto.randomUUID(); }
type Protection = ReturnType<typeof createAgentEditingProtection>;
const owners = new Map<string, { projectId: string; ownerId: string; controller: Protection; listeners: Set<(state: AgentEditingState) => void> }>();
const closeListeners = new Set<() => void>();
function protection(projectId: string, targets: readonly AgentTaskTarget[], workspaceScope = 'normal') {
  const key = `${workspaceScope}:${projectId}:${targets.map(target => `${target.kind}:${target.id}`).join(',')}`;
  const present = owners.get(key); if (present) return present;
  const listeners = new Set<(state: AgentEditingState) => void>(), ownerId = agentEditingOwnerIdentity(workspaceScope, agentEditingWindowOwner(), targets);
  const controller = createAgentEditingProtection({ projectId, ownerId, targets, onChange: next => { for (const listener of listeners) listener(next); for (const listener of closeListeners) listener(); } });
  const entry = { projectId, ownerId, controller, listeners }; owners.set(key, entry); return entry;
}
export function agentEditingOwnedByThisWindow(ownerId: string, workspaceScope = 'normal'): boolean { return agentEditingOwnerInWindow(ownerId, workspaceScope, agentEditingWindowOwner()); }
export function invalidateAgentEditingOwner(projectId: string, ownerId: string): void { for (const entry of owners.values()) if (entry.projectId === projectId && entry.ownerId === ownerId) entry.controller.invalidate(); }
export function agentEditingTargetActive(projectId: string, kind: string, id: string): boolean { return owners.get(`normal:${projectId}:${kind}:${id}`)?.controller.canEdit() ?? false; }
export function agentEditingProof(projectId:string,kind:string,id:string):AgentEditingProof|null {const entry=owners.get(`normal:${projectId}:${kind}:${id}`),state=entry?.controller.getState(),claim=state?.claims.find(value=>value.target.kind===kind&&value.target.id===id);return entry?.controller.canEdit()&&claim&&typeof state?.timelineRevision==='number'?{ownerId:claim.ownerId,kind,id,revision:state.targets?.find(target=>target.kind===kind&&target.id===id)?.revision??0,timelineRevision:state.timelineRevision}:null;}
export async function refreshAgentEditingTargets(projectId:string):Promise<void>{await Promise.allSettled([...owners.entries()].filter(([key])=>key.startsWith('normal:'+projectId+':')).map(([,entry])=>entry.controller.refresh()));}
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
  try { const entry = protection(projectId, [target]); if (entry.controller.canEdit()) return true; if (entry.controller.getState().phase === 'idle') { await entry.controller.refresh(); if (entry.controller.getState().phase === 'idle') return entry.controller.acquire(); } return false; } catch { return false; }
}
export interface AgentEditingBoundaryProps { projectId?: string | null; workspaceScope?: string; targets: readonly AgentTaskTarget[]; disabled?: boolean; controlsOnly?: boolean; canRelease: () => boolean; onDiscard?: () => unknown; children: ReactNode | ((allowed: boolean) => ReactNode) }
export default function AgentEditingBoundary(props: AgentEditingBoundaryProps) {
  const identity = JSON.stringify([props.projectId, props.workspaceScope, props.targets.map(target => [target.kind, target.id])]);
  if (props.disabled || !props.projectId || !props.targets.length) return <>{typeof props.children === 'function' ? props.children(Boolean(props.disabled)) : props.children}</>;
  return <OwnedEditingBoundary key={identity} {...props} projectId={props.projectId} />;
}
function OwnedEditingBoundary({ projectId, workspaceScope = 'normal', targets, canRelease, onDiscard, children, controlsOnly = false }: Omit<AgentEditingBoundaryProps, 'projectId'> & { projectId: string }) {
  const { t } = useI18n(), confirm = useConfirmation(), [state, setState] = useState<AgentEditingState>({ phase: 'loading', claims: [], pending: null }), controller = useRef<ReturnType<typeof createAgentEditingProtection> | null>(null), release = useRef(canRelease), discard = useRef(onDiscard); release.current = canRelease; discard.current=onDiscard;
  useLayoutEffect(() => {
    let entry: ReturnType<typeof protection>;
    try { entry = protection(projectId, targets, workspaceScope); } catch { setState({ phase: 'uncertain', claims: [], pending: null }); return; }
    controller.current = entry.controller; const listener = (next: AgentEditingState) => setState(next); entry.listeners.add(listener); setState(entry.controller.getState());
    if (entry.controller.getState().phase === 'idle') void entry.controller.refresh();
    return () => { entry.listeners.delete(listener); if (controller.current === entry.controller) controller.current = null; };
  }, []);
  const allowed = state.phase === 'active', busy = ['loading', 'acquiring', 'releasing'].includes(state.phase);
  const admission = () => controller.current?.canEdit() ?? false;
  const reject = (event: React.SyntheticEvent) => { if (!admission()) { event.preventDefault(); event.stopPropagation(); } };
  return <EditingContext.Provider value={admission}><div className={`agent-editing-owner${controlsOnly ? ' agent-editing-canvas' : ''}`} data-editing-targets={targets.map(target => `${target.kind}:${target.id}`).join(',')} data-editing-phase={state.phase}>
    <div className="agent-editing-protection" data-testid="agent-editing-protection"><p role="status">{t(allowed ? 'agent.task.editingActive' : state.phase === 'uncertain' || state.phase === 'retained' ? 'agent.task.editingUnknown' : 'agent.task.editingHint')}</p>
      {state.phase === 'idle' && <Button type="button" size="sm" data-testid="agent-editing-start" onClick={() => { void controller.current?.acquire(); }}>{t('agent.task.editingStart')}</Button>}
      {allowed && <Button type="button" size="sm" variant="outline" data-testid="agent-editing-release" disabled={!canRelease()} onClick={() => { if (release.current()) void controller.current?.release(); }}>{t('agent.task.editingRelease')}</Button>}
      {state.phase === 'retained' && <Button type="button" size="sm" variant="outline" data-testid="agent-editing-restore" onClick={()=>{void controller.current?.restore();}}>{t('agent.task.editingRestore')}</Button>}
      {state.phase === 'retained' && onDiscard && !canRelease() && <Button type="button" size="sm" variant="outline" data-testid="agent-editing-discard" onClick={()=>{void(async()=>{const action=discard.current,owner=controller.current;if(action&&await confirm(message('agent.task.editingDiscardConfirm'))&&owner===controller.current)await action();})();}}>{t('agent.task.editingDiscard')}</Button>}
      {state.phase === 'retained' && <Button type="button" size="sm" variant="outline" data-testid="agent-editing-resolve" onClick={() => { void (async () => { if (release.current() && await confirm(message('agent.task.editingResolve')) && release.current()) await controller.current?.resolve(); })(); }}>{t('agent.task.editingResolve')}</Button>}
      {state.phase === 'uncertain' && <Button type="button" size="sm" variant="outline" data-testid="agent-editing-query" disabled={busy} onClick={() => { void controller.current?.refresh(); }}>{t('agent.task.confirmRead')}</Button>}
    </div>
    {controlsOnly ? typeof children === 'function' ? children(allowed) : children : <fieldset className="agent-editing-fields" disabled={!allowed} onBeforeInputCapture={reject} onCompositionStartCapture={reject} onPointerDownCapture={reject} onKeyDownCapture={reject} onDragStartCapture={reject}>{typeof children === 'function' ? children(allowed) : children}</fieldset>}
  </div></EditingContext.Provider>;
}
