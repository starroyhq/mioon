import React, { useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@mioon/ui/components/button';
import { useConfirmation } from '@mioon/ui/components/workbench-confirm';
import { message } from '../../../packages/i18n/src/index.ts';
import { useI18n } from './i18n/I18nProvider.tsx';
import { createAgentEditingClient } from './agent-editing-protection.ts';
import type { AgentTaskClaim, AgentTaskEditingInput } from '../../../packages/contracts/src/agent-tasks-v2.ts';
import { agentTaskEditingSchema } from '../../../packages/contracts/src/agent-tasks-v2.ts';
import { agentEditingOwnedByThisWindow, invalidateAgentEditingOwner } from './AgentEditingBoundary.tsx';
import type { NativeCloseSourceRegistry } from './native-close-sources.ts';

/** Retained claims have no timeout. Clearing one is an explicit user action,
 * and an unconfirmed clear can only query its original durable receipt. */
export default function AgentRetainedEditing({ projectId, visible, readOnly, nativeCloseRegistry }: {projectId:string;visible:boolean;readOnly:boolean;nativeCloseRegistry?:unknown}) {
  const {t}=useI18n(),confirm=useConfirmation(),[claims,setClaims]=useState<AgentTaskClaim[]>([]),[busy,setBusy]=useState(false),[unknown,setUnknown]=useState(false),client=useRef(createAgentEditingClient()),flight=useRef(false),epoch=useRef(0),mounted=useRef(false);
  const view=useRef({projectId,visible,readOnly});if(view.current.projectId!==projectId||view.current.visible!==visible||view.current.readOnly!==readOnly)view.current={projectId,visible,readOnly};
  const key=`mioon.agent-editing-recovery.${projectId}`, pending=useRef<AgentTaskEditingInput|null>(null), source=useRef<ReturnType<NativeCloseSourceRegistry['register']>|null>(null),version=useRef(0);
  const report=()=>source.current?.update({dirty:false,busy:flight.current,blocked:Boolean(pending.current),version:++version.current});
  function persist(value:AgentTaskEditingInput|null){if(value)sessionStorage.setItem(key,JSON.stringify(value));else sessionStorage.removeItem(key);pending.current=value;report();}
  useLayoutEffect(()=>{mounted.current=true;source.current=(nativeCloseRegistry as NativeCloseSourceRegistry|undefined)?.register('agent-editing-recovery-v2')??null;try{const raw=sessionStorage.getItem(key);if(raw){pending.current=agentTaskEditingSchema.parse(JSON.parse(raw));setUnknown(true);}}catch{setUnknown(true);}report();return()=>{mounted.current=false;epoch.current++;source.current?.release();source.current=null;};},[projectId,nativeCloseRegistry]);
  async function load(){if(flight.current||!visible)return;flight.current=true;setBusy(true);report();const token=++epoch.current;
    try{const original=pending.current,next=original&&client.current.lookup?await client.current.lookup(projectId,original.ownerId,original.requestId):await client.current.read(projectId);
      if(!mounted.current||token!==epoch.current)return;
      if(original){invalidateAgentEditingOwner(projectId, original.ownerId);const receipt=next.receipt;if(!receipt||receipt.requestId!==original.requestId||receipt.projectId!==projectId||receipt.ownerId!==original.ownerId||receipt.generation!==original.generation||receipt.sequence!==original.sequence){setUnknown(true);return;}persist(null);}
      const all=original?await client.current.read(projectId):next;if(mounted.current&&token===epoch.current){setClaims(all.claims);setUnknown(false);}
    }catch{if(mounted.current&&token===epoch.current)setUnknown(true);}finally{flight.current=false;report();if(mounted.current&&token===epoch.current)setBusy(false);}}
  async function resolve(claim:AgentTaskClaim){if(flight.current||pending.current||!view.current.visible||view.current.readOnly||view.current.projectId!==projectId)return;const token=epoch.current,viewToken=view.current;if(!await confirm(message('agent.task.editingResolve'))||token!==epoch.current||viewToken!==view.current||!mounted.current||!view.current.visible||view.current.readOnly)return;
    const input:AgentTaskEditingInput={requestId:crypto.randomUUID(),projectId,ownerId:claim.ownerId,generation:Date.now(),sequence:1,action:'resolve',targets:[claim.target]};
    try{persist(input);}catch{setUnknown(true);return;}
    invalidateAgentEditingOwner(projectId, claim.ownerId);
    flight.current=true;setBusy(true);report();try{await client.current.update(input);if(!mounted.current||token!==epoch.current)return;persist(null);flight.current=false;await load();}catch{if(mounted.current)setUnknown(true);}finally{flight.current=false;report();if(mounted.current)setBusy(false);}}
  const retained=claims.filter(claim=>!agentEditingOwnedByThisWindow(claim.ownerId));
  return <details className="agent-task-retained-editing" data-testid="agent-retained-editing" onToggle={event=>{if(event.currentTarget.open)void load();}}><summary>{t('agent.task.editingRetained')}</summary><Button type="button" variant="ghost" disabled={!visible||busy} onClick={()=>{void load();}}>{t(pending.current?'agent.task.confirmRead':'agent.task.reload')}</Button>{unknown&&<p role="alert">{t('agent.task.editingUnknown')}</p>}{retained.map(claim=><article key={claim.id}><p>{claim.target.kind} · {claim.target.id}</p><Button type="button" variant="outline" disabled={!visible||readOnly||busy||Boolean(pending.current)} onClick={()=>{void resolve(claim);}}>{t('agent.task.editingResolve')}</Button></article>)}</details>;
}
