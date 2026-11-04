import React, {createRef,useLayoutEffect,useMemo,useRef,useState} from 'react';
import type {ChangeEvent,FormEvent,RefObject} from 'react';
import {Input} from '@mioon/ui/components/input';
import {Label} from '@mioon/ui/components/label';
import {useConfirmation} from '@mioon/ui/components/workbench-confirm';
import {WorkbenchBadge,WorkbenchButton,WorkbenchTabs} from '@mioon/ui/components/workbench-controls';
import {message} from '../../../packages/i18n/src/index.ts';
import type {AgentTaskConnectionTest} from '../../../packages/contracts/src/agent-tasks-v2.ts';
import {AGENT_CONNECTION_LIMITS} from '../../../packages/contracts/src/agent-connection-settings.ts';
import type {AgentModelListCacheRequest,AgentModelListRequest} from '../../../packages/contracts/src/agent-model-list.ts';
import {createAgentModelListSession} from './agent-model-list-session.ts';
import type {AgentModelListView} from './agent-model-list-session.ts';
import {agentModelListRows} from './agent-model-list-rows.ts';
import {useI18n} from './i18n/I18nProvider.tsx';
import AgentAuthorizations from './AgentAuthorizations.tsx';
import AgentConnectionTest from './AgentConnectionTest.tsx';
import AgentTaskPolicy from './AgentTaskPolicy.tsx';
import type {AgentTaskPolicyController,AgentTaskPolicyNavigation} from './AgentTaskPolicy.tsx';
import SettingsServicesLayout from './SettingsServicesLayout.tsx';
import type {SettingsServicesFooter} from './SettingsServicesLayout.tsx';
import {WorkbenchSelect} from './WorkspaceControls.tsx';
import Icon from './icons.tsx';
import {useWorkspaceVisibility} from './workspace-visibility.tsx';
import {closeSettingsAfterPermission,createSettingsNavigationReporter} from './settings-navigation-state.ts';
import {AGENT_PROTOCOLS,agentDiagnosticMatchesExecution,agentServiceEqual,agentServiceBase,agentServiceBindingChanged,agentServiceEndpointPreview,agentSettingsBusy,agentSettingsCanSave,agentSettingsDirty,agentSettingsEditable,
 agentPresetLabel,agentPlatformLabel,agentPresetNote,createAgentSettingsSession,initialAgentSettingsState} from './agent-settings.ts';
import type {AgentSettingsSnapshot,AgentSettingsState,Translate} from './agent-settings.ts';

type AgentSettingsSession=ReturnType<typeof createAgentSettingsSession>;
type NavigationReporter=ReturnType<typeof createSettingsNavigationReporter>;
type NavigationInput=Parameters<NavigationReporter['update']>[0];
interface AgentSettingsProps {
 onClose:()=>void;beforeClose?:Parameters<typeof closeSettingsAfterPermission>[0];closeLabel?:string;
 onNavigationStateChange?:Parameters<NavigationReporter['connect']>[0];projectId?:string|null;
}
const serviceOrder=['minimax','deepseek','openai','anthropic','qwen','zhipu','kimi','openrouter','ollama'];
const storageReasons:Readonly<Record<string,Parameters<Translate>[0]>>={WEB_SESSION_ONLY:'connections.storage.webReason',LINUX_BASIC_TEXT:'connections.storage.basicReason',OS_SECRET_STORE_UNAVAILABLE:'connections.storage.unavailableReason'};
const storageReason=(storage:AgentSettingsSnapshot['storage'],t:Translate):string=>t(storage.reasonCode&&storageReasons[storage.reasonCode]|| (storage.persistentAvailable?'connections.storage.availableReason':'connections.storage.fallbackReason'));
export {agentDiagnosticMatchesExecution} from './agent-settings.ts';

/** One retained settings session owns all non-secret drafts. Each password has
 * its own mounted DOM input; moving between services never moves its value. */
export default function AgentSettings({onNavigationStateChange,projectId=null}:AgentSettingsProps) {
 const {t,renderMessage,formatDate}=useI18n(),confirm=useConfirmation(),visible=useWorkspaceVisibility();
 const [state,setState]=useState<AgentSettingsState>(initialAgentSettingsState),[hasKeys,setHasKeys]=useState<ReadonlySet<string>>(new Set()),[replacing,setReplacing]=useState<ReadonlySet<string>>(new Set()),[keyCleared,setKeyCleared]=useState<ReadonlySet<string>>(new Set()),[modelErrors,setModelErrors]=useState<ReadonlySet<string>>(new Set());
 const [latest,setLatest]=useState<AgentTaskConnectionTest|null>(null),[policyState,setPolicyState]=useState<AgentTaskPolicyNavigation>({dirty:false,busy:false,unknown:false}),[partial,setPartial]=useState(false);
 const [modelLists,setModelLists]=useState<Readonly<Record<string,AgentModelListView>>>({}),modelListsSession=useRef<ReturnType<typeof createAgentModelListSession>|null>(null),modelDetailIdentity=useRef<string|null>(null),addressEditing=useRef(new Set<string>()),[addressEpoch,setAddressEpoch]=useState(0);
 const interaction=useMemo(()=>({visible}),[visible]),interactionRef=useRef(interaction);
 const [documentEpoch,setDocumentEpoch]=useState(0),documentVersion=useRef(0);
 const [saveOutcome,setSaveOutcome]=useState<{connectionSaved:boolean;connectionFailed:boolean;policyDirty:boolean}|null>(null);
 const keyInputs=useRef(new Map<string,RefObject<HTMLInputElement|null>>()),modelInputs=useRef(new Map<string,RefObject<HTMLInputElement|null>>());
 const session=useRef<AgentSettingsSession|null>(null),dismissed=useRef(false),navigation=useRef<NavigationReporter|null>(null),visibility=useRef(visible);
 const policy=useRef<AgentTaskPolicyController|null>(null),policyNavigation=useRef<AgentTaskPolicyNavigation>({dirty:false,busy:false,unknown:false});
 const submitPending=useRef(false);
 if(!navigation.current)navigation.current=createSettingsNavigationReporter();
 function inputRef(map:Map<string,RefObject<HTMLInputElement|null>>,key:string):RefObject<HTMLInputElement|null>{let ref=map.get(key);if(!ref){ref=createRef<HTMLInputElement>();map.set(key,ref);}return ref;}
 const anyKey=()=>Array.from(keyInputs.current.values()).some(ref=>Boolean(ref.current?.value));
 const navigationInput=(next:AgentSettingsState):NavigationInput=>({dirty:agentSettingsDirty(next)||anyKey()||policyNavigation.current.dirty,phase:policyNavigation.current.busy?'saving':next.phase,recovery:policyNavigation.current.unknown?'unknown':next.recovery});
 const report=(next:AgentSettingsState)=>navigation.current!.update(navigationInput(next));
 function clearKeys(key?:string){
  modelListsSession.current?.invalidate(key);
  for(const [owner,ref] of keyInputs.current)if(key===undefined||key===owner){if(ref.current)ref.current.value='';}
  setHasKeys(previous=>key===undefined?new Set():new Set([...previous].filter(item=>item!==key)));
  setReplacing(previous=>key===undefined?new Set():new Set([...previous].filter(item=>item!==key)));
  report(session.current?.getState()||state);
 }
 useLayoutEffect(()=>{const owner=navigation.current!.connect(onNavigationStateChange,navigationInput(session.current?.getState()||state));return()=>navigation.current!.disconnect(owner);},[onNavigationStateChange]);
 useLayoutEffect(()=>{
  dismissed.current=false;const current=createAgentSettingsSession({onChange:next=>{if(!dismissed.current){report(next);setState(next);}}});session.current=current;void current.load();
  const discovery=createAgentModelListSession({onChange:next=>{if(!dismissed.current)setModelLists(next);}});modelListsSession.current=discovery;
  return()=>{dismissed.current=true;discovery.dispose();if(modelListsSession.current===discovery)modelListsSession.current=null;for(const ref of keyInputs.current.values())if(ref.current)ref.current.value='';current.dispose();if(session.current===current)session.current=null;};
 },[]);
 useLayoutEffect(()=>{visibility.current=visible;interactionRef.current=interaction;session.current?.setVisible(visible);if(!visible){const keys=new Set([...keyInputs.current].filter(([,ref])=>Boolean(ref.current?.value)).map(([key])=>key));clearKeys();if(keys.size)setKeyCleared(previous=>new Set([...previous,...keys]));}report(session.current?.getState()||state);},[interaction]);
 useLayoutEffect(()=>{
  const hidden=()=>{documentVersion.current++;setDocumentEpoch(documentVersion.current);if(document.hidden){const keys=new Set([...keyInputs.current].filter(([,ref])=>Boolean(ref.current?.value)).map(([key])=>key));clearKeys();setKeyCleared(keys);}};
  document.addEventListener('visibilitychange',hidden);return()=>document.removeEventListener('visibilitychange',hidden);
 },[]);
 useLayoutEffect(()=>{if(!state.draft)return;const keys=new Set(state.draft!.services.map(entry=>entry.serviceKey));modelListsSession.current?.forget([...keys]);for(const map of [keyInputs.current,modelInputs.current])for(const [key,ref] of map)if(!keys.has(key)){if(ref.current)ref.current.value='';map.delete(key);}},[state.draft?.services]);
 const usable=(key?:string)=>!dismissed.current&&visible&&visibility.current&&!document.hidden&&interactionRef.current===interaction&&documentVersion.current===documentEpoch&&(key===undefined||session.current?.getState().selectedKey===key);
 function modelListRequest(key:string):AgentModelListCacheRequest|null{
  const current=session.current?.getState(),entry=current?.draft?.services.find(item=>item.serviceKey===key);if(!entry||!current?.snapshot)return null;
  try{return {serviceKey:key,expectedSettingsRevision:current.snapshot.revision,selection:{presetId:entry.presetId,platformId:entry.platformId,baseUrl:agentServiceBase(entry,current.snapshot.presets),protocol:entry.protocol}};}catch{return null;}
 }
 function modelListCredential(key:string):AgentModelListRequest['credential']|null{
  if(!usable(key))return null;const current=session.current!.getState(),entry=current.draft?.services.find(item=>item.serviceKey===key),saved=current.snapshot?.services.find(item=>item.serviceKey===key);
  if(!entry||!current.snapshot)return null;const value=keyInputs.current.get(key)?.current?.value??'';
  if(value)return {source:'input',value};
  if(current.serviceIntents[key]?.action!=='remove'&&saved?.secret.configured&&!agentServiceBindingChanged(saved,entry,current.snapshot.presets))return {source:'saved'};
  // These known unavailable descriptors return before key acquisition. The
  // two public/local descriptors explicitly allow an unauthenticated list.
  if(['qwen','zhipu','ollama','openrouter'].includes(entry.presetId))return {source:'none'};
  return null;
 }
 function fetchModels(key:string,force=true){
  if(!usable(key)||!agentSettingsEditable(session.current?.getState()))return;const request=modelListRequest(key);if(!request)return;
  void modelListsSession.current?.[force?'refresh':'open'](request,()=>modelListCredential(key));
 }
 const selectedEntry=state.draft?.services.find(entry=>entry.serviceKey===state.selectedKey);
 let detailIdentity:string|null=null;try{if(selectedEntry&&state.snapshot)detailIdentity=JSON.stringify([selectedEntry.serviceKey,selectedEntry.presetId,selectedEntry.platformId,agentServiceBase(selectedEntry,state.snapshot.presets),selectedEntry.protocol]);}catch{/* Incomplete addresses do not dispatch. */}
 useLayoutEffect(()=>{addressEditing.current.clear();},[state.selectedKey]);
 useLayoutEffect(()=>{
  if(addressEditing.current.has(state.selectedKey)){modelListsSession.current?.suspend();return;}
  if(!visible||document.hidden||!agentSettingsEditable(state)||!detailIdentity){modelListsSession.current?.suspend();modelDetailIdentity.current=null;return;}
  const previous=modelDetailIdentity.current;modelDetailIdentity.current=detailIdentity;
  const changed=Boolean(previous&&previous!==detailIdentity&&JSON.parse(previous)[0]===state.selectedKey);
  fetchModels(state.selectedKey,changed);
 },[detailIdentity,state.snapshot?.revision,visible,documentEpoch,state.phase,addressEpoch]);
 function bindingChange(key:string,change:()=>boolean|undefined){
  if(!usable(key))return;modelListsSession.current?.invalidate(key);const before=session.current?.getState().draft?.services.find(item=>item.serviceKey===key);if(!change())return;
  const next=session.current!.getState(),after=next.draft?.services.find(item=>item.serviceKey===key);
  if(agentServiceBindingChanged(before,after,next.snapshot!.presets)){clearKeys(key);setKeyCleared(previous=>new Set([...previous,key]));}
 }
 async function save(){
  if(!usable()||submitPending.current||policyNavigation.current.busy)return;
  const current=session.current?.getState()||state,connectionDirty=agentSettingsDirty(current)||anyKey(),policyDirty=policyNavigation.current.dirty;
  if(connectionDirty&&!agentSettingsCanSave(current)||!connectionDirty&&!policyDirty)return;
  modelListsSession.current?.invalidate();
  submitPending.current=true;setPartial(false);setSaveOutcome(null);
  try{
   // save reads all DOM inputs exactly once and clears all of them before its
   // first dispatch/await. The value map never becomes React/session state.
   const connectionSaved=connectionDirty?await session.current!.save({read:key=>keyInputs.current.get(key)?.current?.value||'',clear:()=>clearKeys()}):false;
   if(dismissed.current)return;
   if(policyDirty&&visibility.current&&!document.hidden)await policy.current?.save();
   if(dismissed.current)return;
   setSaveOutcome({connectionSaved,connectionFailed:connectionDirty&&!connectionSaved,policyDirty});
  }finally{submitPending.current=false;}
 }
 useLayoutEffect(()=>{if(!saveOutcome||policyState.busy)return;const policyFailed=saveOutcome.policyDirty&&(policyState.dirty||policyState.unknown);setPartial(Boolean(saveOutcome.connectionSaved&&policyFailed||saveOutcome.policyDirty&&!policyFailed&&saveOutcome.connectionFailed));},[saveOutcome,policyState]);
 function submit(event:FormEvent<HTMLFormElement>){event.preventDefault();void save();}
 function discard(){if(!usable()||submitPending.current||agentSettingsBusy(session.current?.getState()))return;clearKeys();for(const ref of modelInputs.current.values())if(ref.current)ref.current.value='';setPartial(false);setSaveOutcome(null);session.current?.useLatest();policy.current?.discard();}
 async function deleteService(key:string){
  if(!usable(key)||!session.current?.canRemove(key))return;const version=navigation.current!.getState().version;
  if(!await confirm(message('agent.settings.x6.deleteConfirm'))||!usable(key)||navigation.current!.getState().version!==version||!session.current?.canRemove(key))return;
  clearKeys(key);session.current.removeCustom(key);
 }
 const {snapshot,draft,phase,recovery}=state,busy=agentSettingsBusy(state),editable=visible&&agentSettingsEditable(state),connectionDirty=agentSettingsDirty(state)||hasKeys.size>0,dirty=connectionDirty||policyState.dirty;
 const saving=busy&&phase!=='loading'||policyState.busy,attention=['error','load_error','blocked','review'].includes(phase)||policyState.unknown;
 const statusKey=partial?'agent.settings.x6.partial':saving?'mio.settings.footer.saving':attention?'mio.settings.footer.review':dirty?'mio.settings.footer.unsaved':'mio.settings.footer.saved';
 const canSave=visible&&!saving&&!policyState.unknown&&(connectionDirty?agentSettingsCanSave(state):policyState.dirty);
 const statusMessage=state.displayMessages.map(descriptor=>renderMessage(descriptor)).join(' ');
 const currentService=draft?.services.find(item=>item.serviceKey===draft.mioSelection?.serviceKey),currentPlatform=snapshot?.presets.find(item=>item.id===currentService?.presetId)?.platforms.find(item=>item.id===currentService?.platformId);
 const currentAdapted=Boolean(currentService&&currentService.presetId!=='custom'&&currentPlatform?.supportedModelHints?.[currentService.protocol]?.includes(draft!.mioSelection!.modelId));
 const savedCurrent=snapshot?.services.find(item=>item.serviceKey===currentService?.serviceKey);
 const currentUnchanged=Boolean(currentService&&savedCurrent&&snapshot?.mioSelection?.serviceKey===draft?.mioSelection?.serviceKey&&snapshot?.mioSelection?.modelId===draft?.mioSelection?.modelId&&agentServiceEqual(savedCurrent,currentService,snapshot!.presets)&&!hasKeys.has(currentService.serviceKey)&&state.serviceIntents[currentService.serviceKey]?.action!=='remove');
 const verified=agentDiagnosticMatchesExecution(latest,snapshot?.execution??null)&&latest?.status==='completed'&&currentUnchanged;
 const footer:SettingsServicesFooter={state:partial?'partial':saving?'saving':phase==='blocked'?'blocked':recovery?'unknown':attention?'error':dirty?'dirty':'saved',status:<WorkbenchBadge dot tone={attention||partial?'warning':dirty||saving?'neutral':'success'} data-testid="agent-settings-footer-status">{t(statusKey)}</WorkbenchBadge>,
  save:{label:t('mio.settings.save'),testId:'agent-settings-save',disabled:!canSave,busy:saving,onAction:()=>{void save();}},discard:{label:t('mio.settings.discard'),testId:'agent-settings-cancel',disabled:!visible||saving||!dirty,onAction:discard}};
 const general=<div className="mio-settings-general">
  <section className="mio-settings-section"><header className="mio-settings-section-head"><h2>{t('agent.settings.x6.current')}</h2></header>
   <div className="mio-current-model" data-testid="agent-settings-current-model">
    {currentService&&draft?.mioSelection?<><div className="mio-current-model-copy"><strong>{draft.mioSelection.modelId}</strong><span>{currentService.presetId==='custom'?currentService.name:agentPresetLabel({id:currentService.presetId},t)} · {currentPlatform?agentPlatformLabel(currentService.presetId,currentPlatform,t):''} · {AGENT_PROTOCOLS[currentService.protocol].label}</span><div className="mio-settings-inline"><WorkbenchBadge>{t(currentAdapted?'agent.settings.x6.adapted':'agent.settings.x6.unverified')}</WorkbenchBadge><span>{t(!currentUnchanged?'agent.settings.x6.pendingModel':verified?'agent.settings.x6.currentPassed':'agent.settings.x6.currentUntested')}</span></div></div></>:<p>{t('agent.settings.x6.unconfigured')}</p>}
    <WorkbenchButton type="button" size="compact" variant="ghost" data-testid="agent-settings-change-model" onClick={()=>{if(usable('general'))session.current?.view(currentService?.serviceKey??'minimax');}}>{t('agent.settings.x6.change')}</WorkbenchButton>
   </div>
  </section>
  <AgentTaskPolicy visible={visible} controller={policy} onNavigationChange={next=>{policyNavigation.current=next;setPolicyState(next);report(session.current?.getState()||state);}}/>
  <AgentAuthorizations visible={visible&&state.selectedKey==='general'}/>
 </div>;
 const services=draft?.services??[];
 const panels=[{key:'general',content:general},...services.map(entry=>{
  const key=entry.serviceKey,preset=snapshot!.presets.find(item=>item.id===entry.presetId)!,platform=preset.platforms.find(item=>item.id===entry.platformId)!,selected=state.selectedKey===key,enabled=editable&&selected;
  const saved=snapshot!.services.find(item=>item.serviceKey===key),changedBinding=agentServiceBindingChanged(saved,entry,snapshot!.presets),intent=state.serviceIntents[key]??{action:'keep',storage:'session'},configured=Boolean(saved?.secret.configured&&!changedBinding),keyEntry=(!configured||replacing.has(key))&&intent.action!=='remove';
  const refs=inputRef(keyInputs.current,key),manualRef=inputRef(modelInputs.current,key),hints=entry.presetId==='custom'?[]:platform.supportedModelHints?.[entry.protocol]??[];
  const selectedModel=draft!.mioSelection?.serviceKey===key?draft!.mioSelection.modelId:null,savedModel=snapshot!.mioSelection?.serviceKey===key?snapshot!.mioSelection.modelId:null;
  let base='';try{base=agentServiceBase(entry,snapshot!.presets);}catch{/* Incomplete address is an editable draft. */}
  const listIdentity=base?JSON.stringify([key,entry.presetId,entry.platformId,base,entry.protocol]):null,list=modelLists[key]?.identity===listIdentity?modelLists[key]:undefined;
  const models=agentModelListRows({observation:list?.observation,adaptedIds:hints,manualIds:entry.manualModelIds,currentId:savedModel,draftId:selectedModel,custom:entry.presetId==='custom',showMissing:list?.phase==='success'}),missing=models.find(model=>model.missing);
  const listBusy=list?.phase==='loading',listStatus=list?.phase==='success'?(list.observation?.complete?list.observation.models.length?'agent.settings.models.success':'agent.settings.models.empty':'agent.settings.models.partial'):list?.phase==='loading'?'agent.settings.models.loading':list?.phase==='waiting_key'?'agent.settings.models.waitingKey':list?.phase==='invalid_key'?'agent.settings.models.invalidKey':list?.phase==='unavailable'?'agent.settings.models.unavailable':list?.phase==='network_denied'?'agent.settings.models.networkDenied':list?.phase==='unreachable'||list?.phase==='error'?'agent.settings.models.unreachable':'agent.settings.models.idle';
  const messagesV1=entry.presetId==='custom'&&entry.protocol==='anthropic_messages'&&/\/v1\/?$/u.test(entry.addressInput.trim());
  const ownTest=snapshot!.execution?.binding.serviceKey===key?snapshot!.execution:null;
  const addressRow=<div className="mio-settings-row"><Label htmlFor={`agent-address-${key}`}>{t(platform.addressMode==='workspace'?'agent.settings.x6.workspace':platform.addressMode==='local'?'agent.settings.x6.localOrigin':platform.addressMode==='custom'?'agent.settings.x6.customBase':'mio.settings.label.baseUrl')}</Label><div className="mio-settings-control">
     <Input id={`agent-address-${key}`} data-testid={`agent-settings-base-url-${key}`} value={platform.addressMode==='fixed'?base:entry.addressInput} disabled={!enabled||platform.addressMode==='fixed'} readOnly={platform.addressMode==='fixed'} maxLength={2048} spellCheck={false} autoCapitalize="none" placeholder={platform.addressMode==='workspace'?'workspace-id':platform.addressMode==='local'?'http://127.0.0.1:11434':'https://api.example.com'} onBlur={()=>{if(usable(key)&&addressEditing.current.delete(key))setAddressEpoch(previous=>previous+1);}} onChange={(event:ChangeEvent<HTMLInputElement>)=>{if(!usable(key))return;addressEditing.current.add(key);bindingChange(key,()=>session.current?.editService(key,{addressInput:event.target.value}));}}/>
     {platform.addressMode==='fixed'&&<p className="agent-settings-help">{t('agent.settings.x6.baseLocked')}</p>}
     {messagesV1&&<p className="agent-settings-binding-warning" data-testid={`agent-settings-messages-v1-${key}`}>{t('agent.settings.x6.messagesV1')} <WorkbenchButton type="button" variant="ghost" size="compact" disabled={!enabled} onClick={()=>bindingChange(key,()=>session.current?.editService(key,{addressInput:entry.addressInput.trim().replace(/\/v1\/?$/u,'')}))}>{t('agent.settings.x6.removeV1')}</WorkbenchButton></p>}
     <p className="agent-settings-help" data-text-selectable data-testid={`agent-settings-endpoint-${key}`}>{t('agent.settings.endpointPreview',{protocol:AGENT_PROTOCOLS[entry.protocol].label})} {agentServiceEndpointPreview(entry,snapshot!.presets)||t('agent.settings.endpointEmpty')}</p>
     {Boolean(platform.sources.length)&&<div className="agent-settings-sources">{platform.sources.map(source=>snapshot!.storage.sessionScope==='app'?<span className="agent-settings-source-reference" key={source.url}><span>{t('agent.settings.officialDocs')}</span><span>{source.url}</span></span>:<a href={source.url} key={source.url} target="_blank" rel="noopener noreferrer">{t('agent.settings.officialDocs')}<Icon name="arrow" size={10}/></a>)}</div>}
    </div></div>;
  return {key,content:<div className="mio-settings-service" data-testid={`agent-settings-service-${key}`}>
   <header className="mio-settings-service-head"><h2>{entry.presetId==='custom'?entry.name:agentPresetLabel(preset,t)}</h2>{entry.presetId==='custom'&&<WorkbenchButton type="button" variant="danger-ghost" size="compact" data-testid={`agent-settings-delete-${key}`} disabled={!enabled||!session.current?.canRemove(key)} title={!session.current?.canRemove(key)?t('agent.settings.x6.deleteInUse'):undefined} onClick={()=>{void deleteService(key);}}>{t('agent.settings.x6.deleteService')}</WorkbenchButton>}</header>
   {entry.presetId==='custom'&&!session.current?.canRemove(key)&&<p className="agent-settings-help">{t('agent.settings.x6.deleteInUse')}</p>}
   <p className="agent-settings-help" data-testid={`agent-settings-preset-note-${key}`}>{agentPresetNote(preset,platform,t)}</p>
   <div className="mio-settings-rows">
    {entry.presetId==='custom'&&<div className="mio-settings-row"><Label htmlFor={`agent-name-${key}`}>{t('agent.settings.x6.name')}</Label><div className="mio-settings-control"><Input id={`agent-name-${key}`} data-testid={`agent-settings-name-${key}`} value={entry.name} maxLength={100} disabled={!enabled} onChange={(event:ChangeEvent<HTMLInputElement>)=>{if(usable(key))session.current?.editService(key,{name:event.target.value});}}/></div></div>}
    {preset.platforms.length>1&&<div className="mio-settings-row"><Label htmlFor={`agent-platform-${key}`}>{t('agent.settings.platform')}</Label><div className="mio-settings-control"><WorkbenchSelect id={`agent-platform-${key}`} data-testid={`agent-settings-platform-${key}`} value={entry.platformId} disabled={!enabled} onChange={(event:{target:{value:string}})=>bindingChange(key,()=>session.current?.selectPlatform(key,event.target.value))}>{preset.platforms.map(item=><option key={item.id} value={item.id}>{agentPlatformLabel(preset.id,item,t)}</option>)}</WorkbenchSelect></div></div>}
    <div className="mio-settings-row"><span className="mio-settings-label">{t('mio.settings.label.protocol')}</span><div className="mio-settings-control"><WorkbenchTabs data-testid={`agent-settings-protocol-${key}`} value={entry.protocol} label={t('mio.settings.label.protocol')} onValueChange={(value:string)=>bindingChange(key,()=>session.current?.selectProtocol(key,value))} options={platform.availableProtocols.map(protocol=>({value:protocol,label:AGENT_PROTOCOLS[protocol].label,disabled:!enabled,testId:`agent-settings-protocol-${key}-${protocol}`}))}/><p className="agent-settings-help" data-testid={`agent-settings-protocol-help-${key}`}>{t('agent.settings.x6.protocolHelp')}</p></div></div>
    {entry.presetId==='custom'&&addressRow}
    <div className="mio-settings-row"><span className="mio-settings-label" id={`agent-secret-heading-${key}`}>{t('mio.settings.label.key')}</span><div className="mio-settings-control" role="group" aria-labelledby={`agent-secret-heading-${key}`}>
     <div className="mio-settings-inline"><WorkbenchBadge tone={intent.action==='remove'?'warning':configured?'success':'neutral'} data-testid={`agent-settings-secret-status-${key}`} data-configured={configured} data-storage={saved?.secret.storage??'none'}>{t(intent.action==='remove'?'mio.settings.key.clearing':configured?'mio.settings.key.configured':'mio.settings.key.missing')}</WorkbenchBadge>
      <WorkbenchButton type="button" variant="ghost" size="compact" data-testid={`agent-settings-check-key-${key}`} disabled={!enabled||!base||listBusy} onClick={()=>fetchModels(key)}>{t('agent.settings.x6.checkModel')}</WorkbenchButton>
      {configured&&intent.action!=='remove'&&!replacing.has(key)&&<WorkbenchButton type="button" variant="ghost" size="compact" data-testid={`agent-settings-replace-key-${key}`} disabled={!enabled} onClick={()=>{if(usable(key))setReplacing(previous=>new Set([...previous,key]));}}>{t('mio.settings.key.replace')}</WorkbenchButton>}
      {replacing.has(key)&&<WorkbenchButton type="button" variant="ghost" size="compact" data-testid={`agent-settings-cancel-replace-${key}`} disabled={!enabled} onClick={()=>{if(usable(key))clearKeys(key);}}>{t('common.cancel')}</WorkbenchButton>}
      {saved?.secret.configured&&<WorkbenchButton type="button" variant="danger-ghost" size="compact" data-testid={`agent-settings-remove-key-${key}`} aria-pressed={intent.action==='remove'} disabled={!enabled} onClick={()=>{if(usable(key)){clearKeys(key);session.current?.removeKey(key,intent.action!=='remove');}}}>{t(intent.action==='remove'?'connections.undoRemove':'mio.settings.key.clear')}</WorkbenchButton>}
     </div>
     <div className="mio-settings-key-entry" hidden={!keyEntry} inert={!keyEntry}><Label className="sr-only" htmlFor={`agent-key-${key}`}>{t(configured?'agent.settings.replaceKey':'agent.settings.enterKey')}</Label><Input ref={refs} id={`agent-key-${key}`} data-testid={`agent-settings-key-${key}`} type="password" autoComplete="new-password" spellCheck={false} autoCapitalize="none" disabled={!enabled||!keyEntry} maxLength={8192} placeholder={t(configured?'agent.settings.keepPlaceholder':'agent.settings.newKeyPlaceholder')} onBlur={()=>{if(usable(key)&&keyEntry&&refs.current?.value)fetchModels(key);}} onChange={(event:ChangeEvent<HTMLInputElement>)=>{if(!usable(key)||!keyEntry)return;modelListsSession.current?.invalidate(key);setHasKeys(previous=>new Set([...previous].filter(item=>item!==key).concat(event.target.value?[key]:[])));setKeyCleared(previous=>new Set([...previous].filter(item=>item!==key)));report(session.current?.getState()||state);}}/>
      <WorkbenchSelect id={`agent-storage-${key}`} data-testid={`agent-settings-storage-${key}`} aria-label={t('agent.settings.keyStorage')} value={intent.storage} disabled={!enabled} onChange={(event:{target:{value:string}})=>{if(usable(key))session.current?.setStorage(key,event.target.value);}}><option value="session">{t(snapshot!.storage.sessionScope==='app'?'connections.storage.appSession':'connections.storage.serverSession')}</option><option value="persistent" disabled={!snapshot!.storage.persistentAvailable}>{t(snapshot!.storage.persistentAvailable?'connections.storage.persistent':'connections.storage.persistentUnavailable')}</option></WorkbenchSelect>
      <p className="agent-settings-help">{t('agent.settings.keyHelp')} {storageReason(snapshot!.storage,t)} {!hasKeys.has(key)&&configured?t('agent.settings.reenterStorage'):''}</p>
     </div>
     {keyCleared.has(key)&&<p className="agent-settings-binding-warning" role="status" data-testid={`agent-settings-key-cleared-${key}`}>{t('agent.settings.notice.keyCleared')}</p>}
     {changedBinding&&saved?.secret.configured&&<p className="agent-settings-binding-warning">{t('agent.settings.bindingWarning')}</p>}
    </div></div>
    {entry.presetId!=='custom'&&addressRow}
   </div>
   <section className="mio-settings-section mio-model-section"><header className="mio-settings-model-heading"><h3>{t('mio.settings.label.model')}</h3><WorkbenchButton type="button" size="compact" variant="ghost" disabled={!enabled||!base||listBusy} aria-busy={listBusy} data-testid={`agent-settings-fetch-${key}`} onClick={()=>fetchModels(key)}>{t('agent.settings.x6.fetchModels')}</WorkbenchButton></header>
    <p className="agent-settings-help mio-model-observation" role="status" data-testid={`agent-settings-model-list-status-${key}`} data-phase={list?.phase??'idle'}>{t(listStatus)}{list?.observation&&<> · {t('agent.settings.models.fetchedAt',{time:formatDate(list.observation.fetchedAt,{dateStyle:'short',timeStyle:'short'})})}</>}</p>
    {entry.protocol==='responses'&&<p className="agent-settings-help" data-testid={`agent-settings-model-guidance-${key}`}>{entry.presetId==='custom'?t('agent.settings.responsesCustom'):t('agent.task.protocolScope')}{entry.presetId==='qwen'?' '+t('agent.settings.presets.qwenResponses'):''}</p>}{entry.protocol==='anthropic_messages'&&<p className="agent-settings-help" data-testid={`agent-settings-anthropic-guidance-${key}`}>{t('agent.settings.anthropicScope')}</p>}
    <div className="mio-model-list">{models.map(model=><div className="mio-model-row" key={model.id} data-testid={`agent-settings-model-row-${key}-${model.id}`}><div><strong>{model.id}</strong>{model.displayName&&model.displayName!==model.id&&<span className="mio-model-display-name">{model.displayName}</span>}<WorkbenchBadge tone={model.missing?'warning':'neutral'}>{t(model.missing?'agent.settings.models.missing':model.adapted?'agent.settings.x6.adapted':'agent.settings.x6.unverified')}</WorkbenchBadge>{model.manual&&<WorkbenchBadge>{t('agent.settings.models.manual')}</WorkbenchBadge>}{model.current&&selectedModel!==model.id&&<WorkbenchBadge>{t('agent.settings.x6.usingModel')}</WorkbenchBadge>}</div><div className="mio-settings-inline"><WorkbenchButton type="button" size="compact" variant="ghost" disabled={!enabled||selectedModel===model.id} data-testid={`agent-settings-use-${key}-${model.id}`} onClick={()=>{if(usable(key))session.current?.selectMio(key,model.id);}}>{t(selectedModel===model.id?savedModel===model.id?'agent.settings.x6.usingModel':'agent.settings.x6.pendingModel':'agent.settings.x6.useModel')}</WorkbenchButton>{model.manual&&<WorkbenchButton type="button" size="compact" variant="ghost" disabled={!enabled} aria-label={t('agent.settings.x6.removeModel')} onClick={()=>{if(usable(key))session.current?.removeModel(key,model.id);}}><Icon name="close" size={12}/></WorkbenchButton>}</div></div>)}</div>
    {missing&&<p className="agent-settings-binding-warning" role="status" data-testid={`agent-settings-model-missing-${key}`}>{t('agent.settings.models.missingWarning',{model:missing.id})}</p>}
    <div className="mio-settings-inline"><Input ref={manualRef} id={`agent-model-${key}`} data-testid={`agent-settings-model-${key}`} aria-label={t('mio.settings.label.model')} disabled={!enabled||entry.manualModelIds.length>=AGENT_CONNECTION_LIMITS.manualModels} maxLength={200} placeholder={t('agent.settings.modelPlaceholder')} spellCheck={false} autoCapitalize="none"/><WorkbenchButton type="button" size="compact" variant="ghost" data-testid={`agent-settings-add-model-${key}`} disabled={!enabled||entry.manualModelIds.length>=AGENT_CONNECTION_LIMITS.manualModels} onClick={()=>{if(!usable(key))return;const accepted=session.current?.addModel(key,manualRef.current?.value??'');setModelErrors(previous=>new Set([...previous].filter(item=>item!==key).concat(accepted?[]:[key])));if(accepted&&manualRef.current)manualRef.current.value='';}}>{t('agent.settings.x6.addModel')}</WorkbenchButton></div><p className="agent-settings-help">{t('agent.settings.x6.manualHint')}</p>{modelErrors.has(key)&&<p className="mio-settings-notice" role="alert">{t('agent.settings.x6.modelRequired')}</p>}
    <p className="agent-settings-help">{t('agent.settings.models.scope')}</p>
   </section>
   <section className="mio-settings-section"><header className="mio-settings-section-head"><h3>{t('mio.settings.label.test')}</h3></header>{ownTest?<AgentConnectionTest visible={visible&&selected} configuration={ownTest.configuration} settingsRevision={ownTest.revision} settingsBinding={ownTest.binding} blocked={connectionDirty||!agentSettingsCanSave(state)} projectId={projectId} onLatestChange={setLatest}/>:<div className="mio-settings-test"><WorkbenchButton type="button" disabled>{t('mio.settings.test.run')}</WorkbenchButton><span className="agent-settings-help">{t('agent.settings.x6.testSelectedOnly')}</span></div>}</section>
  </div>};
 })];
 return <section className="agent-settings-page mio-settings mio-services-settings" data-testid="agent-settings-page" data-phase={phase} aria-label={t('agent.settings.title')} hidden={!visible} inert={!visible}><form noValidate autoComplete="off" onSubmit={submit} className="agent-settings-form">
  {!snapshot||!draft?<div className="agent-settings-loading" role="status">{phase==='loading'?<><span className="spinner"/>{t('agent.settings.loading')}</>:<><Icon name="info" size={24}/><p data-text-selectable data-testid="agent-settings-error" role="alert">{statusMessage}</p><WorkbenchButton type="button" data-testid="agent-settings-reload" onClick={()=>{if(usable())void session.current?.load();}}>{t('connections.reload')}</WorkbenchButton></>}</div>:<SettingsServicesLayout title={t('agent.settings.title')} selectedKey={state.selectedKey} onSelect={key=>{if(usable())session.current?.view(key);}} pageVisible={visible} footer={footer}
   groups={[{key:'general',items:[{key:'general',label:t('agent.settings.x6.general'),testId:'agent-settings-nav-general'}]},{key:'services',title:t('agent.settings.x6.services'),items:[...serviceOrder.flatMap(key=>{const entry=services.find(item=>item.serviceKey===key);return entry?[{key,label:agentPresetLabel({id:entry.presetId},t),badge:snapshot.mioSelection?.serviceKey===key?<Icon name="check" size={12}/>:undefined,testId:`agent-settings-nav-${key}`}]:[];}),...services.filter(entry=>entry.presetId==='custom').map(entry=>({key:entry.serviceKey,label:entry.name,testId:`agent-settings-nav-${entry.serviceKey}`}))],action:{label:t('agent.settings.x6.addService'),testId:'agent-settings-add-service',disabled:!editable||services.filter(entry=>entry.presetId==='custom').length>=AGENT_CONNECTION_LIMITS.customServices,onAction:()=>{if(usable())session.current?.addCustom(t('agent.settings.x6.customName',{count:services.filter(entry=>entry.presetId==='custom').length+1}));}}}]} panels={panels.map(panel=>({key:panel.key,content:<>{statusMessage&&<div className="mio-settings-page-notice" role={attention?'alert':'status'} data-text-selectable data-testid={`agent-settings-notice-${panel.key}`}>{statusMessage}{recovery&&<div className="agent-settings-recovery-actions">{phase==='blocked'?<WorkbenchButton type="button" size="compact" data-testid="agent-settings-reload" disabled={!visible||busy} onClick={()=>{if(usable())void session.current?.reload();}}>{t('agent.settings.reloadState')}</WorkbenchButton>:<><WorkbenchButton type="button" size="compact" data-testid="agent-settings-review" disabled={!visible||busy} onClick={()=>{if(usable())session.current?.acknowledge();}}>{t('agent.settings.reviewDone')}</WorkbenchButton><WorkbenchButton type="button" variant="ghost" size="compact" data-testid="agent-settings-use-latest" disabled={!visible||busy} onClick={()=>{if(usable()){clearKeys();session.current?.useLatest();}}}>{t('agent.settings.useServer')}</WorkbenchButton></>}</div>}</div>}{panel.content}</>}))}/>}
 </form></section>;
}
