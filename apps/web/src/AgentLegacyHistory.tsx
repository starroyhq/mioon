import React, { useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@mioon/ui/components/button';
import { Badge } from '@mioon/ui/components/badge';
import { useI18n } from './i18n/I18nProvider.tsx';
import { createAgentChatClient, safeAgentChatSnapshot, safeAgentChatHistory } from './agent-chat.ts';
import type { AgentChatRun } from './agent-chat.ts';
import { createAgentEditsClient, safeAgentEditPage, agentEditStatusDescriptor } from './agent-edits.ts';
import type { AgentEditProposal } from './agent-edits.ts';

/** Historical records retain their original DTO and approval semantics. This
 * reader exposes no old send, apply, reject or recovery mutation callbacks. */
export default function AgentLegacyHistory({projectId}:{projectId:string}) {
  const {t,renderMessage}=useI18n(),[runs,setRuns]=useState<AgentChatRun[]|null>(null),[proposals,setProposals]=useState<AgentEditProposal[]>([]),[chatCursor,setChatCursor]=useState<string|null>(null),[editCursor,setEditCursor]=useState<string|null>(null),[failed,setFailed]=useState(false),[busy,setBusy]=useState(false),epoch=useRef(0),mounted=useRef(false),flight=useRef(false);
  useLayoutEffect(()=>{mounted.current=true;return()=>{mounted.current=false;epoch.current++;};},[projectId]);
  async function load(older:'chat'|'edits'|null=null){if(flight.current)return;flight.current=true;setBusy(true);setFailed(false);const token=++epoch.current;
    const operations=[older==='edits'?Promise.resolve(null):older==='chat'?createAgentChatClient().history(projectId,chatCursor):createAgentChatClient().read(projectId),older==='chat'?Promise.resolve(null):createAgentEditsClient().list(projectId,{view:'all',cursor:older==='edits'?editCursor:null})];
    const [chat,edits]=await Promise.allSettled(operations);
    if(mounted.current&&token===epoch.current){
      if(chat?.status==='fulfilled'&&chat.value!==null){try{const data=older==='chat'?safeAgentChatHistory(chat.value,projectId,null,null,chatCursor):safeAgentChatSnapshot(chat.value,projectId);setRuns(data.runs);setChatCursor(data.historyCursor);}catch{setFailed(true);}}
      else if(chat?.status==='rejected')setFailed(true);
      if(edits?.status==='fulfilled'&&edits.value!==null){try{const data=safeAgentEditPage(edits.value,projectId);setProposals(data.proposals);setEditCursor(data.nextCursor);}catch{setFailed(true);}}
      else if(edits?.status==='rejected')setFailed(true);
      setBusy(false);
    }flight.current=false;
  }
  return <details className="agent-task-legacy" data-testid="agent-task-legacy" onToggle={event=>{if(event.currentTarget.open&&!runs)void load();}}><summary>{t('agent.task.legacy')}</summary>{failed&&<p role="alert">{t('agent.task.error')}</p>}<Button type="button" variant="ghost" disabled={busy} onClick={()=>{void load();}}>{t('agent.task.reload')}</Button>{runs?.map(run=><article key={run.id} data-legacy-run={run.id}><p>{run.userText}</p><p>{run.assistantText}</p><Badge>{run.status}</Badge></article>)}{chatCursor&&<Button type="button" variant="outline" disabled={busy} onClick={()=>{void load('chat');}}>{t('agent.chat.olderPage')}</Button>}{proposals.map(proposal=><article key={proposal.id} data-legacy-proposal={proposal.id}><strong>{proposal.operation}</strong><Badge>{renderMessage(agentEditStatusDescriptor(proposal.status))}</Badge><pre>{JSON.stringify(proposal.diff,null,2)}</pre></article>)}{editCursor&&<Button type="button" variant="outline" disabled={busy} onClick={()=>{void load('edits');}}>{t('agent.chat.olderPage')}</Button>}</details>;
}
