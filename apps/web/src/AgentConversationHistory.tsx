import React,{useLayoutEffect,useRef,useState} from 'react';
import {Input} from '@mioon/ui/components/input';
import {WorkbenchButton as Button} from '@mioon/ui/components/workbench-controls';
import type {AgentTaskConversation} from '../../../packages/contracts/src/agent-tasks-v2.ts';
import {useI18n} from './i18n/I18nProvider.tsx';
import {conversationDay,conversationMatches,conversationTime,readLegacyConversation} from './agent-conversations.ts';
import type {ConversationDay,LegacyConversation} from './agent-conversations.ts';
import Icon from './icons.tsx';

export interface AgentConversationHistoryProps {open:boolean;projectId:string;conversations:AgentTaskConversation[];phase:'closed'|'loading'|'ready'|'error';nextCursor:string|null;currentId:string|null;currentLegacyId?:string;newConversation:boolean;disabled:boolean;selectionError?:boolean;onClose:()=>void;onSelect:(id:string)=>unknown;onSelectLegacy:(value:LegacyConversation)=>unknown;onMore:()=>unknown}
export default function AgentConversationHistory({open,projectId,conversations,phase,nextCursor,currentId,currentLegacyId,newConversation,disabled,selectionError=false,onClose,onSelect,onSelectLegacy,onMore}:AgentConversationHistoryProps){
  const {t,locale}=useI18n(),[query,setQuery]=useState(''),[legacy,setLegacy]=useState<LegacyConversation|null>(null),[legacyPhase,setLegacyPhase]=useState<'idle'|'loading'|'ready'|'error'>('idle');
  const search=useRef<HTMLInputElement|null>(null),epoch=useRef(0),flight=useRef<number|null>(null),mounted=useRef(false),shown=useRef(open),loadedProject=useRef(projectId);shown.current=open;
  useLayoutEffect(()=>{mounted.current=true;return()=>{mounted.current=false;epoch.current++;flight.current=null;};},[]);
  async function loadLegacy(older=false){if(!shown.current||flight.current!==null||older&&!legacy?.chatCursor&&!legacy?.editCursor)return;const token=epoch.current;flight.current=token;setLegacyPhase('loading');try{const next=await readLegacyConversation(projectId,older?legacy:null);if(mounted.current&&shown.current&&epoch.current===token){setLegacy(next);setLegacyPhase('ready');}}catch{if(mounted.current&&shown.current&&epoch.current===token)setLegacyPhase('error');}finally{if(flight.current===token)flight.current=null;}}
  useLayoutEffect(()=>{epoch.current++;flight.current=null;const changed=loadedProject.current!==projectId;if(changed){loadedProject.current=projectId;setLegacy(null);setLegacyPhase('idle');setQuery('');}if(open){setQuery('');search.current?.focus();if(changed||legacyPhase==='idle'||legacyPhase==='loading')void loadLegacy();}else if(legacyPhase==='loading')setLegacyPhase('idle');},[open,projectId]);
  if(!open)return null;
  const entries=conversations.filter(item=>conversationMatches(item.title,query,locale)),old=legacy&&conversationMatches(legacy.title||t('agent.conversation.legacy'),query,locale)?legacy:null;
  const showNew=newConversation&&conversationMatches(t('agent.panel.newConversation'),query,locale),more=Boolean(nextCursor||legacy?.chatCursor||legacy?.editCursor);
  const loadMore=()=>{if(nextCursor){if(phase!=='loading'&&phase!=='error')onMore();}else if(legacyPhase!=='loading')void loadLegacy(true);};
  return <section className="mio-history-overlay" aria-label={t('agent.conversation.title')} data-testid="agent-task-history" onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();onClose();}}}>
    <header><strong>{t('agent.conversation.title')}</strong><Button variant="icon" aria-label={t('agent.conversation.back')} onClick={onClose}><Icon name="close" /></Button></header>
    <div className="mio-history-search"><Icon name="search" /><Input ref={search} type="search" value={query} aria-label={t('agent.conversation.search')} placeholder={t('agent.conversation.search')} onChange={event=>setQuery(event.target.value)} /></div>
    {selectionError&&<p role="alert" className="mio-error">{t('agent.conversation.loadError')}</p>}
    <div className="mio-history-list" data-testid="agent-task-history-list" onScroll={event=>{const node=event.currentTarget;if(!query.trim()&&node.scrollHeight-node.scrollTop-node.clientHeight<48)loadMore();}}>
      {(['today','yesterday','earlier'] as ConversationDay[]).map(day=>{const group=entries.filter(item=>conversationDay(item.updatedAt)===day);if(!group.length&&!(day==='today'&&showNew)&&!(day==='earlier'&&old))return null;return <section key={day} className="mio-history-group"><h4>{t(`agent.conversation.${day}`)}</h4>
        {day==='today'&&showNew&&<Button variant="ghost" className="mio-history-item" aria-current="page" onClick={onClose}><span className="mio-history-title">{t('agent.panel.newConversation')}</span><span className="mio-secondary">{t('agent.conversation.current')}</span></Button>}
        {group.map(item=><Button key={item.id} variant="ghost" className="mio-history-item" data-testid="agent-task-history-item" aria-current={currentId===item.id?'page':undefined} disabled={disabled} onClick={()=>onSelect(item.id)}><span className="mio-history-title" title={item.title}>{item.title}</span><span className="mio-history-meta"><span>{conversationTime(item.updatedAt,locale,day)}</span><span data-tone={item.lastRunStatus==='completed'?'success':item.lastRunStatus==='failed'?'danger':'neutral'}>{t(`agent.task.status.${item.lastRunStatus}`)}</span><span>{t('agent.conversation.changes',{count:item.changeCount})}</span></span>{currentId===item.id&&<span className="mio-current-conversation">{t('agent.conversation.current')}</span>}</Button>)}
        {day==='earlier'&&old&&<Button variant="ghost" className="mio-history-item" data-testid="agent-task-legacy-history-item" aria-current={currentLegacyId===old.id?'page':undefined} disabled={disabled} onClick={()=>onSelectLegacy(old)}><span className="mio-history-title">{old.title||t('agent.conversation.legacy')}</span><span className="mio-history-meta"><span>{conversationTime(old.updatedAt,locale,'earlier')}</span><span>{t(`agent.task.status.${old.lastRunStatus}`)}</span><span>{t('agent.conversation.changes',{count:old.changeCount})}</span></span><span className="mio-secondary">{t('agent.conversation.legacy')}</span>{currentLegacyId===old.id&&<span className="mio-current-conversation">{t('agent.conversation.current')}</span>}</Button>}
      </section>;})}
      {!entries.length&&!old&&!showNew&&phase!=='loading'&&<p className="mio-secondary">{t(query?'agent.conversation.noMatch':'agent.conversation.empty')}</p>}
      {(phase==='loading'||legacyPhase==='loading')&&<p role="status" className="mio-secondary">{t('agent.conversation.loading')}</p>}
      {phase==='error'&&<div role="alert"><p>{t('agent.task.error')}</p><Button variant="ghost" onClick={onMore}>{t('agent.task.reload')}</Button></div>}
      {legacyPhase==='error'&&<div role="alert"><p>{t('agent.task.error')}</p><Button variant="ghost" onClick={()=>{void loadLegacy();}}>{t('agent.task.reload')}</Button></div>}
      {more&&<Button variant="ghost" disabled={phase==='loading'||legacyPhase==='loading'} onClick={loadMore}>{t('agent.conversation.loadMore')}</Button>}
    </div>
  </section>;
}
