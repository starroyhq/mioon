import React,{useEffect,useRef,useState} from 'react';
import {Button} from '@mioon/ui/components/button';
import {agentAuthorizationListSchema,agentAuthorizationReceiptSchema} from './agent-authorization-state.ts';
import type {AgentAuthorizationList,AgentAuthorizationRecord} from '../../../packages/contracts/src/agent-authorization.ts';
import {useI18n} from './i18n/I18nProvider.tsx';

/** Local authorization metadata only. No connection key or message content is
 * sent to this panel; revocation never schedules a model request. */
export default function AgentAuthorizations({visible=true}:{visible?:boolean}){
  const {t}=useI18n(),[data,setData]=useState<AgentAuthorizationList|null>(null),[busy,setBusy]=useState(false),[failed,setFailed]=useState(false);
  const epoch=useRef(0),pending=useRef(false),controller=useRef<AbortController|null>(null);
  async function rpc(operation:string,input:unknown,signal:AbortSignal):Promise<unknown>{
    const response=await fetch('/api/rpc',{method:'POST',credentials:'same-origin',cache:'no-store',signal,
      headers:{'Content-Type':'application/json'},body:JSON.stringify({operation,input})});
    const envelope:unknown=await response.json();
    if(!response.ok||!envelope||typeof envelope!=='object'||!('ok' in envelope)||envelope.ok!==true||!('data' in envelope))throw new Error('Authorization request failed');
    return envelope.data;
  }
  async function load(){
    const token=++epoch.current;controller.current?.abort();const abort=new AbortController();controller.current=abort;
    setBusy(true);setFailed(false);
    try{const next=agentAuthorizationListSchema.parse(await rpc('agent.authorization.list',{},abort.signal));if(epoch.current===token&&!abort.signal.aborted)setData(next);}
    catch{if(epoch.current===token&&!abort.signal.aborted)setFailed(true);}
    finally{if(epoch.current===token)setBusy(false);}
  }
  useEffect(()=>{
    if(visible)void load();
    return()=>{epoch.current++;controller.current?.abort();};
  },[visible]);
  async function revoke(grant:AgentAuthorizationRecord){
    if(!visible||!data||busy||pending.current)return;pending.current=true;setBusy(true);setFailed(false);
    const token=epoch.current,abort=new AbortController();controller.current=abort;
    try{
      agentAuthorizationReceiptSchema.parse(await rpc('agent.authorization.revoke',{requestId:globalThis.crypto.randomUUID(),expectedRevision:data.revision,authorizationId:grant.id},abort.signal));
      if(epoch.current===token&&!abort.signal.aborted)await load();
    }catch{if(epoch.current===token&&!abort.signal.aborted){setFailed(true);setBusy(false);}}
    finally{pending.current=false;}
  }
  return <section className="agent-settings-section" data-testid="agent-authorizations" aria-busy={busy}>
    <div className="agent-settings-section-title"><h3>{t('agent.authorization.listTitle')}</h3><Button type="button" variant="ghost" data-testid="agent-authorizations-refresh" disabled={!visible||busy} onClick={()=>{void load();}}>{t('agent.authorization.refresh')}</Button></div>
    <p className="agent-settings-help">{t('agent.authorization.explanation')}</p>
    {failed&&<p role="alert" data-text-selectable data-testid="agent-authorizations-error">{t('agent.authorization.error')}</p>}
    {data&&<>{data.authorizations.length?<ul>{data.authorizations.map(grant=><li key={grant.id} data-testid="agent-authorization-target"><p data-text-selectable>{grant.model} · {t(`agent.authorization.scope.${grant.scope}`)}</p><p className="agent-chat-context" data-text-selectable>{grant.destination}</p><Button type="button" variant="ghost" data-testid={`agent-authorization-revoke-${grant.id}`} disabled={!visible||busy} onClick={()=>{void revoke(grant);}}>{t('agent.authorization.revoke')}</Button></li>)}</ul>:<p data-testid="agent-authorizations-empty">{t('agent.authorization.empty')}</p>}</>}
  </section>;
}
