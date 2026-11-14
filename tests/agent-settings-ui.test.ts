import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import * as logic from '../apps/web/src/agent-settings.ts';
import * as navigation from '../apps/web/src/settings-navigation-state.ts';
import * as modelDiscovery from '../apps/web/src/agent-model-list-session.ts';
import * as modelRows from '../apps/web/src/agent-model-list-rows.ts';
import * as agentProtocol from '../packages/contracts/src/agent-protocol.ts';
import * as openAiFamilies from '../packages/contracts/src/agent-openai-model-family.ts';
import type {AgentModelListClient} from '../apps/web/src/agent-model-list-session.ts';
import type {AgentModelListResult,AgentModelListSuccess} from '../packages/contracts/src/agent-model-list.ts';
import * as i18n from '../packages/i18n/src/index.ts';
import {createI18nTestContext} from './helpers/i18n.ts';
import {adapterSettings} from './helpers/agent-adapter-fixture.ts';
import {agentAdaptedModelHints} from '../packages/business/src/agent/model-profiles.ts';
import {AGENT_CONNECTION_LIMITS} from '../packages/contracts/src/agent-connection-settings.ts';
import type {AgentSettingsSnapshot} from '../packages/contracts/src/agent-connection-settings.ts';
import type {SettingsServicesLayoutProps} from '../apps/web/src/SettingsServicesLayout.tsx';
import type {Locale} from '../packages/i18n/src/types.ts';
import {settingsUiFixture,uiSettings,ADAPTER_CUSTOM_SERVICE_KEY,flushSettingsUi as flush,deferredSettingsUi as deferred,assertNoSecrets} from './helpers/agent-settings-ui-fixture.ts';
const custom=ADAPTER_CUSTOM_SERVICE_KEY;
const codeError=(code:string)=>Object.assign(Error('reflected-secret'),{code});

test('strict collection snapshots reject unknown/private fields, malformed identity and inconsistent execution',()=>{
 const original=uiSettings();assert.deepEqual(logic.safeAgentSettings(original).services,original.services);
 for(const patch of [{private:'synthetic-secret'},{revision:-1},{services:original.services.slice(1)},{execution:{...original.execution,revision:-1}},{verification:'connected'},{notices:['PRIVATE']},{mioSelection:null}] as const)assert.throws(()=>logic.safeAgentSettings({...original,...patch}));
 const unsafe=structuredClone(original);unsafe.presets[0]!.platforms[0]!.sources=[{label:'Official',url:'javascript:alert(1)'},{label:'Official',url:'https://name:synthetic-secret@example.com'},{label:'Official',url:'https://example.com/docs'}];
 assert.throws(()=>logic.safeAgentSettings(unsafe),'Unsafe provider references are rejected before rendering');
});

test('service binding includes stable owner and receiver, and retains protocol/model-only changes',()=>{
 const initial=uiSettings(),entry=initial.services.find(item=>item.serviceKey===custom)!;
 assert.equal(logic.agentServiceBindingChanged(entry,{...entry,manualModelIds:['another-model']},initial.presets),false);
 assert.equal(logic.agentServiceBindingChanged(entry,{...entry,protocol:'responses'},initial.presets),false);
 assert.equal(logic.agentServiceBindingChanged(entry,{...entry,addressInput:'https://synthetic.example/'},initial.presets),false);
 for(const patch of [{serviceKey:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'},{addressInput:'https://other.example'},{addressInput:'https://synthetic.example/other'}])assert.equal(logic.agentServiceBindingChanged(entry,{...entry,...patch},initial.presets),true);
});

test('client only uses authenticated local GET/PUT, projects errors and times out',async()=>{
 const requests:Array<{url:RequestInfo|URL;options?:RequestInit}>=[];
 const client=logic.createAgentSettingsClient({fetchImpl:async(url,options)=>{requests.push({url,options});return Response.json({ok:true,data:uiSettings()});}});
 await client.read();await client.write({synthetic:'metadata'});
 assert.deepEqual(requests.map(request=>request.url),['/api/agent/settings','/api/agent/settings']);
 for(const request of requests){assert.equal(request.options?.credentials,'same-origin');assert.equal(request.options?.cache,'no-store');}
 assert.equal(requests[0]!.options?.method,'GET');assert.equal(requests[1]!.options?.method,'PUT');assert.equal(requests[1]!.options?.body,'{"synthetic":"metadata"}');
 const bad=logic.createAgentSettingsClient({fetchImpl:async()=>Response.json({ok:false,error:{code:'PRIVATE',message:'reflected-secret'}},{status:500})});await assert.rejects(bad.read(),error=>{assertNoSecrets(error);return true;});
 let aborted=false;const slow=logic.createAgentSettingsClient({timeoutMs:2,fetchImpl:(_url,options)=>{options?.signal?.addEventListener('abort',()=>{aborted=true;});return new Promise(()=>{});}});await assert.rejects(slow.read());assert.equal(aborted,true);
});

test('service navigation never selects Mio or changes metadata; manual/custom limits and delete admission are explicit',async()=>{
 const f=settingsUiFixture();await f.session.load();const original=structuredClone(f.session.getState().draft);
 f.session.view('minimax');f.session.view('general');assert.deepEqual(f.session.getState().draft,original);assert.equal(logic.agentSettingsDirty(f.session.getState()),false);
 assert.equal(f.session.canRemove(custom),false);assert.equal(f.session.removeCustom(custom),false);
 f.session.selectMio('openai','manual-openai');assert.equal(f.session.canRemove(custom),false,'Saved selection still owns the service until saved');await f.session.save();assert.equal(f.session.canRemove(custom),true);
 assert.equal(f.session.addModel('openai','  manual-id  '),true);assert.equal(f.session.addModel('openai','manual-id'),false);assert.equal(f.session.addModel('openai','x'.repeat(201)),false);
 for(let i=1;i<50;i++)assert.equal(f.session.addModel('openai',`model-${i}`),true);assert.equal(f.session.addModel('openai','model-overflow'),false);
 assert.equal(f.session.removeCustom(custom),true);const newKey=f.session.addCustom('Custom');assert.equal(newKey,'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');assert.equal(f.session.getState().draft?.mioSelection?.serviceKey,'openai');
});

test('single CAS save reads every DOM source once, clears before dispatch, and supports independent key actions',async()=>{
 const f=settingsUiFixture();await f.session.load();f.session.removeKey(custom);f.session.setStorage('openai','persistent');let cleared=false;const reads:string[]=[];
 const originalWrite=f.client.write;f.client.write=input=>{assert.equal(cleared,true);return originalWrite(input);};
 assert.equal(await f.session.save({read:key=>{reads.push(key);return key==='openai'?'synthetic-secret-openai':key==='deepseek'?'synthetic-secret-deepseek':'';},clear:()=>{cleared=true;}}),true);
 assert.equal(f.calls.length,1);assert.equal(new Set(reads).size,reads.length);assert.equal(reads.length,f.saved().services.length);
 const actions=f.calls[0]!.secretActions;assert.deepEqual(actions.find(item=>item.serviceKey==='openai'),{serviceKey:'openai',action:'replace',storage:'persistent',value:'synthetic-secret-openai'});assert.deepEqual(actions.find(item=>item.serviceKey===custom),{serviceKey:custom,action:'remove'});
 assert.equal(f.saved().services.find(item=>item.serviceKey==='deepseek')?.secret.configured,true);assertNoSecrets(f.emitted);
});

test('validation clears all submitted DOM inputs without dispatch; unavailable persistent storage never silently downgrades',async()=>{
 const initial=uiSettings();initial.storage={persistentAvailable:false,sessionScope:'app',reasonCode:'OS_SECRET_STORE_UNAVAILABLE'};initial.services.find(item=>item.serviceKey===custom)!.secret={configured:true,storage:'persistent'};initial.execution!.secret={configured:true,storage:'persistent'};
 const f=settingsUiFixture({initial});await f.session.load();assert.equal(f.session.getState().serviceIntents[custom]!.storage,'persistent');let clears=0;
 assert.equal(await f.session.save({read:key=>key===custom?'synthetic-secret':'',clear:()=>{clears++;}}),false);assert.equal(clears,1);assert.equal(f.calls.length,0);assert.equal(f.session.getState().serviceIntents[custom]!.storage,'persistent');assertNoSecrets(f.emitted);
 f.session.setStorage(custom,'session');assert.equal(await f.session.save({read:key=>key===custom?'synthetic-secret':'',clear:()=>{clears++;}}),true);assert.equal(f.saved().execution?.secret.storage,'session');
});

test('CAS conflict and unknown result perform one readback, preserve drafts, and require review with no key replay',async()=>{
 for(const code of ['AGENT_SETTINGS_CONFLICT','NETWORK']){
  const f=settingsUiFixture({write:()=>Promise.reject(codeError(code))});await f.session.load();f.session.addModel('openai','draft-model');
  assert.equal(await f.session.save({read:key=>key==='openai'?'synthetic-secret':'',clear:()=>{}}),false);assert.equal(f.calls.length,1);assert.equal(f.reads,2);assert.equal(f.session.getState().phase,'review');assert.equal(logic.agentSettingsCanSave(f.session.getState()),false);assert.ok(f.session.getState().draft?.services.find(item=>item.serviceKey==='openai')?.manualModelIds.includes('draft-model'));assertNoSecrets(f.emitted);
  f.session.acknowledge();assert.equal(logic.agentSettingsCanSave(f.session.getState()),true);await f.session.save();assert.equal(f.calls.length,2);assert.equal(f.calls[1]!.expectedRevision,1);assert.ok(f.calls[1]!.secretActions.every(action=>action.action!=='replace'),'Explicit retry never reconstructs a password');
 }
 const held=deferred(),f=settingsUiFixture({read:count=>count===1?uiSettings():held.promise,write:()=>Promise.reject(codeError('NETWORK'))});await f.session.load();const pending=f.session.save({read:()=>'',clear:()=>{}});await flush();assert.equal(f.session.getState().phase,'reconciling');held.reject(Error('reflected-secret'));await pending;assert.equal(f.session.getState().phase,'blocked');assert.equal(logic.agentSettingsCanSave(f.session.getState()),false);
});

test('definitive failures and disposed/hidden sessions cannot replay or resurrect secret-bearing saves',async()=>{
 for(const code of ['UNAUTHORIZED','AGENT_SETTINGS_VALIDATION','AGENT_SETTINGS_STORAGE_UNAVAILABLE']){
  const f=settingsUiFixture({write:()=>Promise.reject(codeError(code))});await f.session.load();await f.session.save({read:key=>key==='openai'?'synthetic-secret':'',clear:()=>{}});assert.equal(f.reads,1);assert.equal(f.calls.length,1);assert.equal(f.session.getState().phase,'error');assertNoSecrets(f.emitted);
 }
 const held=deferred(),f=settingsUiFixture({write:()=>held.promise});await f.session.load();const saving=f.session.save({read:key=>key==='openai'?'synthetic-secret':'',clear:()=>{}});const count=f.emitted.length;f.session.dispose();held.resolve(f.saved());await saving;assert.equal(f.emitted.length,count);assert.equal(await f.session.save(),false);assert.equal(f.session.editService('openai',{manualModelIds:['late']}),false);
});

interface Element {type:unknown;props:Record<string,unknown>}
interface Hook {value?:unknown;deps?:readonly unknown[];cleanup?:void|(()=>void)}
const isElement=(value:unknown):value is Element=>Boolean(value&&typeof value==='object'&&'props' in value);
function nodes(value:unknown):Element[]{return Array.isArray(value)?value.flatMap(nodes):isElement(value)?[value,...nodes(value.props.children)]:[];}
function invoke(node:Element,name:string,...args:unknown[]):unknown{const callback=node.props[name];assert.equal(typeof callback,'function',name);return Reflect.apply(callback as (...values:unknown[])=>unknown,undefined,args);}
const source=readFileSync(new URL('../apps/web/src/AgentSettings.tsx',import.meta.url),'utf8'),transformed=transformSync(source,{loader:'tsx',format:'cjs',jsx:'transform'}).code;
const listed=(ids:string[]=[]):AgentModelListSuccess=>({outcome:'success',models:ids.map(id=>({id,adaptation:'unverified'})),complete:true,source:'current_protocol',fetchedAt:'2026-11-04T00:00:00.000Z'});
function adaptedUiSettings():AgentSettingsSnapshot{
 const initial=uiSettings();for(const preset of initial.presets){preset.supportedModelHints=agentAdaptedModelHints(preset.id);for(const platform of preset.platforms)platform.supportedModelHints=agentAdaptedModelHints(preset.id);}return initial;
}
function uiHarness(client:logic.AgentSettingsClient,discovery:AgentModelListClient={modelsCache:async()=>({status:'hit',result:listed()}),modelsList:async()=>listed()},
 testDraftConnection:typeof modelDiscovery.testAgentDraftConnection=async()=>({outcome:'success'})){
 const hooks:Hook[]=[],dom=new Map<string,{value:string}>(),listeners=new Set<()=>void>(),reports:navigation.SettingsNavigationState[]=[];let cursor=0,pending:Array<()=>void>=[],tree:unknown,visible=true,locale:Locale='zh-Hans';
 const document={hidden:false,addEventListener:(_name:string,fn:()=>void)=>listeners.add(fn),removeEventListener:(_name:string,fn:()=>void)=>listeners.delete(fn)};
 const element=(type:unknown,props:Record<string,unknown>|null,...children:unknown[]):Element=>{
  if(type==='ServicesLayout'){
   const layout=props as unknown as SettingsServicesLayoutProps;
   return {type,props:{...props,children:[...layout.groups.flatMap(group=>group.items.map(item=>element('button',{'data-testid':item.testId,onClick:()=>layout.onSelect(item.key)}))),...layout.groups.filter(group=>group.action).map(group=>element('button',{'data-testid':group.action!.testId,disabled:group.action!.disabled,onClick:group.action!.onAction})),...layout.panels.map(panel=>element('section',{'data-panel':panel.key,hidden:panel.key!==layout.selectedKey},panel.content)),element('button',{'data-testid':layout.footer.save.testId,disabled:layout.footer.save.disabled,onClick:layout.footer.save.onAction}),element('button',{'data-testid':layout.footer.discard!.testId,disabled:layout.footer.discard!.disabled,onClick:layout.footer.discard!.onAction})]}};
  }
  return {type,props:{...props,children}};
 };
 const react={createElement:element,Fragment:'Fragment',createRef:()=>({current:null}),useRef:(initial:unknown)=>{const index=cursor++;return(hooks[index]??={value:{current:initial}}).value;},
  useState:(initial:unknown)=>{const index=cursor++;const slot=hooks[index]??={value:typeof initial==='function'?Reflect.apply(initial,undefined,[]):initial};return[slot.value,(next:unknown)=>{slot.value=typeof next==='function'?Reflect.apply(next,undefined,[slot.value]):next;}];},
  useMemo:(callback:()=>unknown,deps:readonly unknown[])=>{const index=cursor++,old=hooks[index];if(!old?.deps||old.deps.length!==deps.length||!deps.every((value,index)=>Object.is(value,old.deps![index])))hooks[index]={value:callback(),deps};return hooks[index]!.value;},
  useLayoutEffect:(callback:()=>void|(()=>void),deps?:readonly unknown[])=>{const index=cursor++,old=hooks[index];if(deps&&old?.deps&&deps.length===old.deps.length&&deps.every((value,index)=>Object.is(value,old.deps![index])))return;hooks[index]={...old,deps};pending.push(()=>{old?.cleanup?.();hooks[index]!.cleanup=callback();});}};
 const module:{exports:{default?:(props:unknown)=>unknown;agentDiagnosticMatchesExecution?:typeof logic.agentDiagnosticMatchesExecution}}={exports:{}};
 Function('require','module','exports','document',transformed)((id:string)=>{
  if(id==='react')return {__esModule:true,default:react,...react};if(id==='./i18n/I18nProvider.tsx')return {useI18n:()=>createI18nTestContext(locale)};
  if(id==='../../../packages/i18n/src/index.ts')return i18n;if(id==='../../../packages/contracts/src/agent-connection-settings.ts')return {AGENT_CONNECTION_LIMITS};
  if(id==='./settings-navigation-state.ts')return navigation;if(id==='./workspace-visibility.tsx')return {useWorkspaceVisibility:()=>visible};
  if(id==='./agent-settings.ts')return {...logic,createAgentSettingsSession:(options:logic.AgentSettingsSessionOptions)=>logic.createAgentSettingsSession({...options,client})};
  if(id==='./agent-model-list-session.ts')return {...modelDiscovery,testAgentDraftConnection:testDraftConnection,createAgentModelListSession:(options:Parameters<typeof modelDiscovery.createAgentModelListSession>[0])=>modelDiscovery.createAgentModelListSession({...options,client:discovery})};
  if(id==='./agent-model-list-rows.ts')return modelRows;
  if(id==='./ModelPickerDialog.tsx')return {__esModule:true,default:'ModelPickerDialog'};
  if(id==='../../../packages/contracts/src/agent-protocol.ts')return agentProtocol;
  if(id==='../../../packages/contracts/src/agent-openai-model-family.ts')return openAiFamilies;
  if(id==='./SettingsServicesLayout.tsx')return {__esModule:true,default:'ServicesLayout'};
  if(id==='@mioon/ui/components/workbench-confirm')return {useConfirmation:()=>async()=>true};
  if(id==='./AgentTaskPolicy.tsx'||id==='./AgentAuthorizations.tsx'||id==='./AgentConnectionTest.tsx'||id==='./icons.tsx')return {__esModule:true,default:id};
  if(id.startsWith('@mioon/ui/')||id==='./WorkspaceControls.tsx')return new Proxy({},{get:(_target,key)=>String(key)});throw Error(id);
 },module,module.exports,document);
 const h={render(){cursor=0;pending=[];tree=module.exports.default!({onClose:()=>{},onNavigationStateChange:(next:navigation.SettingsNavigationState)=>reports.push(next)});for(const node of nodes(tree)){const ref=node.props.ref;if(ref&&typeof ref==='object'&&'current'in ref){const id=String(node.props.id);if(!dom.has(id))dom.set(id,{value:''});ref.current=dom.get(id);}}for(const effect of pending)effect();return tree;},
  find(id:string){const node=nodes(tree).find(item=>item.props['data-testid']===id);assert.ok(node,id);return node;},click(id:string){invoke(h.find(id),'onClick');h.render();},view(key:string){h.click(`agent-settings-nav-${key}`);},
  picker:()=>nodes(tree).find(item=>item.type==='ModelPickerDialog'),
  pickerItems:()=>h.picker()?.props.items as {id:string;added?:boolean;active?:boolean;verified?:boolean}[]|undefined,
  modelRow(key:string,id:string){return nodes(tree).find(node=>node.props['data-testid']===`agent-settings-model-row-${key}-${id}`);},
  closePicker(){const picker=h.picker();assert.ok(picker);invoke(picker,'onClose');h.render();},
  addPicked(...ids:string[]){const picker=h.picker();assert.ok(picker);invoke(picker,'onAdd',ids);h.render();},
  change(id:string,value:string){const node=h.find(id);invoke(node,typeof node.props.onValueChange==='function'?'onValueChange':'onChange',typeof node.props.onValueChange==='function'?value:{target:{value}});h.render();},
  key(key:string,value:string){const node=h.find(`agent-settings-key-${key}`),ref=node.props.ref as {current:{value:string}};ref.current.value=value;invoke(node,'onChange',{target:{value}});h.render();},keyValue(key:string){return (h.find(`agent-settings-key-${key}`).props.ref as {current:{value:string}}).current.value;},
  form(){return nodes(tree).find(node=>node.type==='form')!;},
  save(){const form=nodes(tree).find(node=>node.type==='form')!;invoke(form,'onSubmit',{preventDefault(){}});h.render();},setVisible(value:boolean){visible=value;h.render();},setLocale(value:Locale){locale=value;h.render();},documentHidden(){document.hidden=true;for(const listener of listeners)listener();h.render();},
  latest:()=>reports.at(-1)!,reports,unmount(){for(const hook of hooks)hook.cleanup?.();},matches:module.exports.agentDiagnosticMatchesExecution!};return h;
}
const ready=async(h:ReturnType<typeof uiHarness>)=>{h.render();await flush();h.render();};

test('the Mio execution policy has confirmation controls without a step-limit field',()=>{
 const policySource=readFileSync(new URL('../apps/web/src/AgentTaskPolicy.tsx',import.meta.url),'utf8');
 assert.match(policySource,/agent-policy-preset/u);
 assert.doesNotMatch(policySource,/agent-policy-steps|mio\.settings\.steps|stepLimit/u);
});

function renderedWorkbenchButton(node:Element):Element{
 const source=readFileSync(new URL('../packages/ui/src/components/workbench-controls.tsx',import.meta.url),'utf8');
 const start=source.indexOf('export function WorkbenchButton('),end=source.indexOf('\nexport interface WorkbenchTabOption',start);assert.ok(start>=0&&end>start);
 const module:{exports:{WorkbenchButton?:(props:Record<string,unknown>)=>Element}}={exports:{}};
 const react={createElement:(type:unknown,props:Record<string,unknown>,...children:unknown[]):Element=>({type,props:{...props,children}})};
 Function('module','exports','React','Button','cn',transformSync(source.slice(start,end),{loader:'tsx',format:'cjs'}).code)(module,module.exports,react,'button',(...values:unknown[])=>values.filter(Boolean).join(' '));
 assert.equal(typeof module.exports.WorkbenchButton,'function');return module.exports.WorkbenchButton!(node.props);
}

test('actual model fetch and key check show the real button spinner while pending and clear it on completion or cancellation',async()=>{
 for(const action of ['fetch','check-key'])for(const finish of ['complete','hide']){
  const initial=uiSettings();initial.services.find(entry=>entry.serviceKey==='openai')!.secret={configured:true,storage:'session'};
  const pending=deferred(),signals:AbortSignal[]=[],f=settingsUiFixture({initial}),h=uiHarness(f.client,{modelsCache:async()=>({status:'hit',result:listed(['old-model'])}),modelsList:async(_input,options)=>{signals.push(options.signal);return pending.promise;}});
  try{
   await ready(h);h.view('openai');await flush();h.render();
   assert.equal(renderedWorkbenchButton(h.find('agent-settings-fetch-openai')).props['aria-busy'],undefined);
   h.click(`agent-settings-${action}-openai`);assert.equal(signals.length,1);
   for(const button of ['fetch','check-key']){
    const rendered=renderedWorkbenchButton(h.find(`agent-settings-${button}-openai`));assert.equal(rendered.props['aria-busy'],true);assert.equal(rendered.props.disabled,true);
    assert.equal(nodes(rendered).some(item=>item.props.className==='wb-spinner'),true,'The production WorkbenchButton renders its pending indicator');
   }
   assert.equal(h.find('agent-settings-model-list-status-openai').props['data-phase'],'loading');
   if(finish==='hide'){h.setVisible(false);assert.equal(signals[0]!.aborted,true);}
   pending.resolve(listed(['late-model']));await flush();h.render();
   for(const button of ['fetch','check-key']){const rendered=renderedWorkbenchButton(h.find(`agent-settings-${button}-openai`));assert.equal(rendered.props['aria-busy'],undefined);assert.equal(nodes(rendered).some(item=>item.props.className==='wb-spinner'),false);}
   assert.equal(h.modelRow('openai','late-model'),undefined);
   if(finish==='complete'&&action==='fetch'){assert.equal(h.picker()?.props.status,'ready');assert.deepEqual(h.pickerItems()?.map(item=>item.id),['late-model']);}
   else assert.equal(h.picker(),undefined);
   assert.equal(f.calls.length,0);assert.equal(f.saved().verification,'not_tested');assertNoSecrets(h.reports);
  }finally{h.unmount();}
 }
});

test('model list failures explain the next step in all four locales and keep the last observation',async()=>{
 const initial=uiSettings();initial.services.find(entry=>entry.serviceKey==='openai')!.secret={configured:true,storage:'session'};
 initial.services.find(entry=>entry.serviceKey==='openai')!.manualModelIds=['last-fetched-model'];
 const previous=listed(['last-fetched-model']);
 let next:AgentModelListResult=previous;
 const f=settingsUiFixture({initial}),h=uiHarness(f.client,{modelsCache:async()=>({status:'hit',result:previous}),modelsList:async()=>next});
 const cases=[
  [{outcome:'invalid_key',reason:'rejected'},'invalidKey'],
  [{outcome:'invalid_key',reason:'permission_denied'},'permissionDenied'],
  [{outcome:'unavailable',reason:'not_found'},'notFound'],
  [{outcome:'unreachable',reason:'rate_limited'},'rateLimited'],
  [{outcome:'unreachable',reason:'server_error'},'serverError'],
  [{outcome:'unreachable',reason:'connection_failed'},'connectionFailed'],
  [{outcome:'unreachable',reason:'timeout'},'timeout'],
  [{outcome:'network_denied',reason:'policy'},'networkDenied'],
 ] as const;
 try{
  await ready(h);h.view('openai');await flush();h.render();
  for(const [failure,suffix] of cases){
   next=failure;
   h.click('agent-settings-fetch-openai');await flush();h.render();
   assert.equal(h.find('agent-settings-model-list-status-openai').props['data-phase'],failure.outcome);
   for(const locale of i18n.LOCALES){
    h.setLocale(locale);
    const copy=i18n.catalogs[`agent.settings.models.${suffix}` as keyof typeof i18n.catalogs]?.[locale];
    assert.equal(typeof copy,'string',`${locale} ${suffix}`);
    const children=h.find('agent-settings-model-list-status-openai').props.children;
    assert.ok(Array.isArray(children));
    assert.equal(children[0],copy);
    assert.equal(h.picker()?.props.status,'error');assert.equal(h.picker()?.props.statusMessage,copy);
   }
   assert.ok(h.find('agent-settings-model-row-openai-last-fetched-model'));assert.deepEqual(h.pickerItems(),[]);h.closePicker();
  }
  assert.equal(f.calls.length,0);
  assert.equal(f.saved().verification,'not_tested');
 }finally{h.unmount();}
});

test('actual model labels use documented OpenAI families for snapshots without trusting provider adaptation claims',async()=>{
 const known='gpt-5.4-mini-2026-03-17',future='gpt-5.9-mini',invalid='gpt-5.1-mini';
 const initial=adapterSettings({presetId:'openai',platformId:'global',baseUrl:'https://api.openai.com/v1',protocol:'responses',model:known},{revision:0});
 const observation={...listed([known,future,invalid,'gpt-4.1-mini']),models:listed([known,future,invalid,'gpt-4.1-mini']).models.map(model=>({...model,adaptation:'adapted' as const}))};
 const f=settingsUiFixture({initial}),h=uiHarness(f.client,{modelsCache:async()=>({status:'hit',result:observation}),modelsList:async()=>observation});
 try{
  await ready(h);h.view('openai');await flush();h.render();
  h.key('openai','synthetic-secret');h.click('agent-settings-fetch-openai');await flush();h.render();
  assert.deepEqual(h.pickerItems()?.map(item=>[item.id,item.verified]),[[known,true],[future,false],[invalid,false],['gpt-4.1-mini',true]]);
  for(const locale of i18n.LOCALES){
   h.setLocale(locale);
   assert.ok(JSON.stringify(h.find(`agent-settings-model-row-openai-${known}`)).includes(i18n.translate(locale,'agent.settings.x6.adapted')));
   for(const model of [future,invalid,'gpt-4.1-mini'])assert.equal(h.modelRow('openai',model),undefined);
   assert.ok(JSON.stringify(h.find('agent-settings-current-model')).includes(i18n.translate(locale,'agent.settings.x6.adapted')));
   const note=JSON.stringify(h.find('agent-settings-preset-note-openai'));
   assert.match(note,/Responses/);assert.match(note,{'zh-Hans':/当前一代/,'zh-Hant':/目前世代/,en:/current-generation/,ja:/現行世代/}[locale]);
   assert.doesNotMatch(note,/GPT-5\.4 mini/);
   assert.doesNotMatch(JSON.stringify(h.find('agent-settings-preset-note-openai')),/非推理|非推論|Non-reasoning/);
  }
  assert.equal(f.calls.length,0);assert.equal(f.saved().mioSelection?.modelId,known);assertNoSecrets(h.reports);
 }finally{h.unmount();}
});

test('actual UI retains independent password DOM through brand navigation, locale rerenders and same-receiver protocol changes',async()=>{
 const f=settingsUiFixture(),h=uiHarness(f.client);await ready(h);h.view('openai');h.key('openai','synthetic-secret-A');const a=h.find('agent-settings-key-openai').props.ref;
 h.view('deepseek');h.key('deepseek','synthetic-secret-B');h.view('openai');h.setLocale('en');assert.equal(h.find('agent-settings-key-openai').props.ref,a);assert.equal(h.keyValue('openai'),'synthetic-secret-A');assert.equal(h.keyValue('deepseek'),'synthetic-secret-B');
 h.change('agent-settings-protocol-openai','chat_completions');assert.equal(h.keyValue('openai'),'synthetic-secret-A');assert.equal(f.calls.length,0);assertNoSecrets(h.reports);h.unmount();assert.equal((a as {current:{value:string}}).current.value,'');
});

test('actual binding edits clear only their service input; hidden detail callbacks cannot edit another service',async()=>{
 const f=settingsUiFixture(),h=uiHarness(f.client);await ready(h);
 const mounted=nodes(h.render());for(const key of [custom,'openai']){const address=`agent-settings-base-url-${key}`,password=`agent-settings-key-${key}`;const before=mounted.findIndex(node=>node.props['data-testid']===address),after=mounted.findIndex(node=>node.props['data-testid']===password);assert.equal(mounted.filter(node=>node.props['data-testid']===address).length,1,'Each retained service renders its address once');assert.equal(mounted.filter(node=>node.props['data-testid']===password).length,1,'Each retained service keeps one password input');assert.equal(key===custom?before<after:after<before,true,'13-02 places custom address before key; 13-01 keeps builtin key before address');}
 h.view(custom);h.key(custom,'synthetic-secret-custom');const stale=h.find(`agent-settings-base-url-${custom}`);h.view('openai');h.key('openai','synthetic-secret-openai');invoke(stale,'onChange',{target:{value:'https://stale.example'}});h.render();assert.equal(h.keyValue(custom),'synthetic-secret-custom');h.view(custom);h.change(`agent-settings-base-url-${custom}`,'https://changed.example');assert.equal(h.keyValue(custom),'');assert.equal(h.keyValue('openai'),'synthetic-secret-openai');h.unmount();
});

test('actual save clears every DOM input before one atomic request, and never refills after acknowledgement',async()=>{
 const held=deferred(),f=settingsUiFixture({write:()=>held.promise}),h=uiHarness(f.client);await ready(h);h.view('openai');h.key('openai','synthetic-secret-openai');h.view('deepseek');h.key('deepseek','synthetic-secret-deepseek');h.save();assert.equal(h.keyValue('openai'),'');assert.equal(h.keyValue('deepseek'),'');assert.equal(f.calls.length,1);assert.equal(h.find('agent-settings-save').props.disabled,true);held.resolve(f.saved());await flush();h.render();assert.equal(h.keyValue('openai'),'');assert.equal(h.keyValue('deepseek'),'');assert.equal(h.find('agent-settings-secret-status-openai').props['data-configured'],true);h.unmount();
});

test('actual page hide, document hide and discard clear all passwords; old handlers remain inactive',async()=>{
 for(const mode of ['page','document','discard']){const f=settingsUiFixture(),h=uiHarness(f.client);await ready(h);h.view('openai');h.key('openai','synthetic-secret-openai');h.view('deepseek');h.key('deepseek','synthetic-secret-deepseek');const old=h.find('agent-settings-key-deepseek');if(mode==='page')h.setVisible(false);else if(mode==='document')h.documentHidden();else h.click('agent-settings-cancel');assert.equal(h.keyValue('openai'),'');assert.equal(h.keyValue('deepseek'),'');invoke(old,'onChange',{target:{value:'synthetic-secret-late'}});h.render();assert.equal(f.calls.length,0);assertNoSecrets(h.reports);h.unmount();}
});

test('actual manual-model selection remains draft only while list fetching stays independent of save and verification',async()=>{
 const f=settingsUiFixture(),h=uiHarness(f.client);await ready(h);h.view('openai');await flush();h.render();const input=h.find('agent-settings-model-openai');(input.props.ref as {current:{value:string}}).current.value='manual-new';h.click('agent-settings-add-model-openai');h.click('agent-settings-use-openai-manual-new');assert.equal(f.calls.length,0);assert.equal(h.find('agent-settings-fetch-openai').props.disabled,false);assert.equal(h.find('agent-settings-current-model').props.children!==undefined,true);h.save();await flush();h.render();assert.equal(f.saved().mioSelection?.modelId,'manual-new');assert.equal(f.calls.length,1);assert.equal(f.saved().verification,'not_tested');h.unmount();
});

test('actual detail opens only its cache, keeps manually added rows, and does not dirty or verify the page',async()=>{
 const initial=uiSettings();initial.services.find(entry=>entry.serviceKey==='openai')!.manualModelIds=['manual-model'];
 const f=settingsUiFixture({initial}),cacheCalls:string[]=[],listCalls:string[]=[];
 const discovery:AgentModelListClient={modelsCache:async input=>{cacheCalls.push(input.serviceKey);return {status:'hit',result:listed(['remote-model','gpt-4.1-mini'])};},modelsList:async input=>{listCalls.push(input.serviceKey);return listed(['refreshed-model']);}};
 const h=uiHarness(f.client,discovery);await ready(h);assert.deepEqual(cacheCalls,[]);h.view('openai');await flush();h.render();assert.deepEqual(cacheCalls,['openai']);assert.deepEqual(listCalls,[]);assert.equal(h.modelRow('openai','gpt-4.1-mini'),undefined);assert.equal(h.modelRow('openai','remote-model'),undefined);assert.ok(h.find('agent-settings-model-row-openai-manual-model'));assert.equal(h.find('agent-settings-save').props.disabled,true);assert.equal(f.calls.length,0);assert.equal(f.saved().revision,initial.revision);assert.equal(f.saved().verification,'not_tested');
 for(const locale of i18n.LOCALES){h.setLocale(locale);assert.doesNotMatch(JSON.stringify(h.find('agent-settings-model-list-status-openai')),/agent\.settings\.models\./);}assert.deepEqual(cacheCalls,['openai']);h.unmount();
});

test('actual picker locks added and active models, stages only selected IDs, and persists them only in the ordinary settings save',async()=>{
 const initial=uiSettings(),service=initial.services.find(item=>item.serviceKey===custom)!,active=initial.mioSelection!.modelId;
 service.manualModelIds=['manual-before'];service.secret={configured:true,storage:'session'};initial.execution!.secret=service.secret;
 const result=listed(['manual-before',active,'selected-one','skipped','selected-two']);
 const f=settingsUiFixture({initial}),h=uiHarness(f.client,{modelsCache:async()=>({status:'hit',result}),modelsList:async()=>result});
 const fetch=async()=>{h.click(`agent-settings-fetch-${custom}`);await flush();h.render();};
 try{
  await ready(h);h.view(custom);await flush();h.render();
  await fetch();assert.equal(h.picker()?.props.status,'ready');
  assert.deepEqual(h.pickerItems()?.map(item=>[item.id,item.added,item.active]),[['manual-before',true,false],[active,true,true],['selected-one',false,false],['skipped',false,false],['selected-two',false,false]]);
  const prior=h.picker();assert.ok(prior);h.closePicker();invoke(prior,'onAdd',['selected-one']);h.render();assert.equal(h.modelRow(custom,'selected-one'),undefined);assert.equal(h.latest().dirty,false);
  await fetch();h.addPicked('manual-before','selected-one');assert.ok(h.picker());assert.equal(h.modelRow(custom,'selected-one'),undefined);
  h.addPicked('selected-one','selected-two');assert.equal(h.picker(),undefined);assert.ok(h.modelRow(custom,'manual-before'));assert.ok(h.modelRow(custom,'selected-one'));assert.ok(h.modelRow(custom,'selected-two'));assert.equal(h.modelRow(custom,'skipped'),undefined);
  assert.deepEqual(f.saved().services.find(entry=>entry.serviceKey===custom)?.manualModelIds,['manual-before']);assert.deepEqual(f.saved().mioSelection,initial.mioSelection);assert.equal(f.calls.length,0);assert.equal(h.latest().dirty,true);
  h.save();await flush();h.render();assert.equal(f.calls.length,1);assert.deepEqual(f.saved().services.find(entry=>entry.serviceKey===custom)?.manualModelIds,['manual-before','selected-one','selected-two']);assert.deepEqual(f.saved().mioSelection,initial.mioSelection);
 }finally{h.unmount();}
});

test('actual Qwen detail without a list offers adapted models and selects one only in the unsaved Mio draft',async()=>{
 const initial=adaptedUiSettings(),entry=initial.services.find(item=>item.serviceKey==='qwen')!,platform=initial.presets.find(item=>item.id===entry.presetId)!.platforms.find(item=>item.id===entry.platformId)!,model=platform.supportedModelHints?.[entry.protocol]?.[0];assert.ok(model);
 const f=settingsUiFixture({initial}),cacheCalls:string[]=[],listCalls:Parameters<AgentModelListClient['modelsList']>[0][]=[],discovery:AgentModelListClient={modelsCache:async input=>{cacheCalls.push(input.serviceKey);return {status:'miss'};},modelsList:async input=>{listCalls.push(input);return {outcome:'unavailable',reason:'not_provided'};}};
 const h=uiHarness(f.client,discovery);await ready(h);h.view('qwen');await flush();h.render();assert.deepEqual(cacheCalls,['qwen']);assert.equal(listCalls.length,0);assert.equal(h.find('agent-settings-model-list-status-qwen').props['data-phase'],'idle');
 h.click('agent-settings-fetch-qwen');await flush();h.render();assert.equal(listCalls.length,1);assert.equal(listCalls[0]!.serviceKey,'qwen');assert.deepEqual(listCalls[0]!.credential,{source:'none'});assert.equal(h.find('agent-settings-model-list-status-qwen').props['data-phase'],'unavailable');assert.equal(h.picker()?.props.status,'error');h.closePicker();
 assert.match(JSON.stringify(h.find(`agent-settings-model-row-qwen-${model}`)),new RegExp(i18n.translate('zh-Hans','agent.settings.x6.adapted')));assert.equal(h.find(`agent-settings-use-qwen-${model}`).props.disabled,false);assert.equal(h.latest().dirty,false);
 h.click(`agent-settings-use-qwen-${model}`);assert.equal(h.latest().dirty,true);assert.match(JSON.stringify(h.find('agent-settings-current-model')),new RegExp(model.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));assert.match(JSON.stringify(h.find('agent-settings-current-model')),new RegExp(i18n.translate('zh-Hans','agent.settings.x6.pendingModel')));
 assert.equal(f.calls.length,0);assert.deepEqual(f.saved().mioSelection,initial.mioSelection);assert.equal(f.saved().revision,initial.revision);assert.equal(f.saved().verification,'not_tested');h.unmount();
});

test('actual partial and complete caches keep suggestions and exclude provider-only models',async()=>{
 for(const complete of [false,true]){
  const initial=adaptedUiSettings(),entry=initial.services.find(item=>item.serviceKey==='openai')!,platform=initial.presets.find(item=>item.id===entry.presetId)!.platforms.find(item=>item.id===entry.platformId)!,model=platform.supportedModelHints?.[entry.protocol]?.[0];assert.ok(model);
  const f=settingsUiFixture({initial}),discovery:AgentModelListClient={modelsCache:async()=>({status:'hit',result:{...listed(['remote-model']),complete}}),modelsList:async()=>assert.fail('A matching cache must not fetch')},h=uiHarness(f.client,discovery);
  await ready(h);h.view('openai');await flush();h.render();assert.equal(h.modelRow('openai','remote-model'),undefined);
  assert.equal(h.find(`agent-settings-use-openai-${model}`).props.disabled,false);assert.match(JSON.stringify(h.find(`agent-settings-model-row-openai-${model}`)),new RegExp(i18n.translate('zh-Hans','agent.settings.x6.adapted')));
  assert.equal(h.latest().dirty,false);assert.equal(f.calls.length,0);assert.deepEqual(f.saved().mioSelection,initial.mioSelection);h.unmount();
 }
});

test('actual OpenAI fallback suggestions contain current models without promoting deprecated or shut down models',async()=>{
 const initial=adaptedUiSettings();initial.services.find(entry=>entry.serviceKey==='openai')!.protocol='responses';
 const f=settingsUiFixture({initial}),h=uiHarness(f.client,{modelsCache:async()=>({status:'miss'}),modelsList:async()=>assert.fail('Suggestions must not fetch without a credential')});
 try{
  await ready(h);h.view('openai');await flush();h.render();
  const suggestions=nodes(h.render()).map(node=>node.props['data-testid']).filter((id):id is string=>typeof id==='string'&&id.startsWith('agent-settings-model-row-openai-')).map(id=>id.slice('agent-settings-model-row-openai-'.length));
  for(const model of ['gpt-6-astra','gpt-6.1-sol','gpt-6.1-terra','gpt-6-luna'])assert.ok(suggestions.includes(model),`${model} is a current suggestion`);
  assert.match(suggestions[0]!,/^gpt-6/u,'The current generation leads the fallback suggestions');
  for(const model of ['gpt-5.4-nano','gpt-5.3-codex','gpt-5.1','gpt-5','gpt-5-mini','gpt-5-nano','gpt-5-pro','o3','gpt-4.1-mini','o1','o3-mini','o4-mini'])assert.equal(suggestions.includes(model),false,`${model} must not be suggested`);
  assert.equal(h.latest().dirty,false);assert.equal(f.calls.length,0);assert.deepEqual(f.saved().mioSelection,initial.mioSelection);assertNoSecrets(h.reports);
 }finally{h.unmount();}
});

test('actual OpenAI manual and observed legacy rows retain compatibility without adapting shut down models',async()=>{
 for(const [model,adapted] of [['gpt-4.1-mini',true],['gpt-5.1',true],['o1',false],['o3-mini',false],['o4-mini',false]] as const){
  const initial=adapterSettings({presetId:'openai',platformId:'global',baseUrl:'https://api.openai.com/v1',protocol:'responses',model},{revision:0});
  const observation={...listed([model]),models:[{id:model,adaptation:'adapted' as const}]};
  const f=settingsUiFixture({initial}),h=uiHarness(f.client,{modelsCache:async()=>({status:'hit',result:observation}),modelsList:async()=>assert.fail('A complete observation must not fetch')});
  try{
   await ready(h);h.view('openai');await flush();h.render();
   for(const locale of i18n.LOCALES){
    h.setLocale(locale);
    const expected=i18n.translate(locale,adapted?'agent.settings.x6.adapted':'agent.settings.x6.unverified');
    assert.ok(JSON.stringify(h.find(`agent-settings-model-row-openai-${model}`)).includes(expected),`${model}/${locale}: observed/manual adaptation is local policy`);
    assert.ok(JSON.stringify(h.find('agent-settings-current-model')).includes(expected),`${model}/${locale}: persisted current model uses the same policy`);
   }
   assert.equal(f.calls.length,0);assert.deepEqual(f.saved().mioSelection,initial.mioSelection);assertNoSecrets(h.reports);
  }finally{h.unmount();}
 }
});

test('actual fetching and closing a failed or successful picker preserve the settings list',async()=>{
 const initial=adaptedUiSettings(),entry=initial.services.find(item=>item.serviceKey==='openai')!,platform=initial.presets.find(item=>item.id===entry.presetId)!.platforms.find(item=>item.id===entry.platformId)!,model=platform.supportedModelHints?.[entry.protocol]?.[0];assert.ok(model);
 const f=settingsUiFixture({initial}),pending=deferred();let requests=0;const discovery:AgentModelListClient={modelsCache:async()=>({status:'hit',result:listed(['retained-remote'])}),modelsList:async()=>++requests===1?pending.promise:listed(['replacement-remote'])},h=uiHarness(f.client,discovery);
 const assertMembership=()=>{assert.ok(h.modelRow('openai',model));assert.equal(h.modelRow('openai','retained-remote'),undefined);assert.equal(h.modelRow('openai','replacement-remote'),undefined);};
 await ready(h);h.view('openai');await flush();h.render();assertMembership();
 h.key('openai','synthetic-secret');h.click('agent-settings-fetch-openai');assert.equal(h.picker()?.props.status,'loading');assertMembership();
 pending.resolve({outcome:'unreachable',reason:'timeout'});await flush();h.render();assert.equal(h.picker()?.props.status,'error');assertMembership();h.closePicker();
 h.click('agent-settings-fetch-openai');await flush();h.render();assert.equal(h.picker()?.props.status,'ready');assert.deepEqual(h.pickerItems()?.map(item=>item.id),['replacement-remote']);assertMembership();h.closePicker();assertMembership();
 assert.equal(requests,2);assert.equal(f.calls.length,0);assert.deepEqual(f.saved().mioSelection,initial.mioSelection);assert.equal(f.saved().verification,'not_tested');h.unmount();
});

test('actual key typing dispatches nothing; explicit check and fetch use one-shot input, and check does not open the picker or add rows',async()=>{
 const f=settingsUiFixture(),calls:Parameters<AgentModelListClient['modelsList']>[0][]=[],discovery:AgentModelListClient={modelsCache:async()=>({status:'miss'}),modelsList:async input=>{calls.push(input);return listed(['new-model']);}};
 const h=uiHarness(f.client,discovery);await ready(h);h.view('openai');await flush();h.render();assert.equal(h.find('agent-settings-model-list-status-openai').props['data-phase'],'idle');assert.equal(calls.length,0);
 h.key('openai','synthetic-secret-openai');await flush();h.render();assert.equal(calls.length,0);
 h.click('agent-settings-check-key-openai');await flush();h.render();assert.equal(calls.length,1);assert.equal(h.picker(),undefined);assert.equal(h.modelRow('openai','new-model'),undefined);assert.deepEqual(calls[0]!.credential,{source:'input',value:'synthetic-secret-openai'});assert.equal(h.keyValue('openai'),'synthetic-secret-openai');assert.equal(f.calls.length,0);assert.equal(f.saved().verification,'not_tested');
 assert.ok(h.find('agent-settings-key-check-result-openai'));assert.ok(h.find('agent-settings-service-dirty-openai'));
 h.click('agent-settings-fetch-openai');await flush();h.render();assert.equal(calls.length,2);assert.deepEqual(calls[1]!.credential,{source:'input',value:'synthetic-secret-openai'});assert.equal(h.picker()?.props.usesDraftKey,true);assert.equal(h.modelRow('openai','new-model'),undefined);h.addPicked('new-model');
 assert.ok(h.modelRow('openai','new-model'));h.click('agent-settings-use-openai-new-model');assert.equal(f.saved().mioSelection?.serviceKey,custom);assert.equal(f.calls.length,0);assertNoSecrets(h.reports);h.unmount();
});

test('actual address editing waits for an explicit fetch; incomplete addresses never dispatch',async()=>{
 const f=settingsUiFixture(),calls:Parameters<AgentModelListClient['modelsList']>[0][]=[],discovery:AgentModelListClient={modelsCache:async()=>({status:'miss'}),modelsList:async input=>{calls.push(input);return listed(['local-model']);}};
 const h=uiHarness(f.client,discovery);await ready(h);h.view('ollama');await flush();h.render();assert.equal(calls.length,0);
 for(const value of ['http://127.0.0.1:1','http://127.0.0.1:11','http://127.0.0.1:11435']){h.change('agent-settings-base-url-ollama',value);await flush();h.render();assert.equal(calls.length,0,'Typing legal prefixes must not fetch');}
 invoke(h.find('agent-settings-base-url-ollama'),'onBlur');h.render();await flush();h.render();assert.equal(calls.length,0);h.click('agent-settings-fetch-ollama');await flush();h.render();assert.equal(calls.length,1);assert.equal(calls[0]!.selection.baseUrl,'http://127.0.0.1:11435/v1');assert.deepEqual(calls[0]!.credential,{source:'none'});h.closePicker();
 h.change('agent-settings-base-url-ollama','http://');invoke(h.find('agent-settings-base-url-ollama'),'onBlur');h.render();await flush();h.render();assert.equal(calls.length,1);assert.equal(h.find('agent-settings-fetch-ollama').props.disabled,true);assert.equal(f.calls.length,0);h.unmount();
});

test('explicit fetch after a protocol change uses the new descriptor and the entered key without saving',async()=>{
 const initial=uiSettings(),openai=initial.services.find(entry=>entry.serviceKey==='openai')!;openai.protocol='chat_completions';openai.manualModelIds=['gpt-4.1-mini'];
 const f=settingsUiFixture({initial}),calls:Parameters<AgentModelListClient['modelsList']>[0][]=[],discovery:AgentModelListClient={modelsCache:async()=>({status:'hit',result:listed()}),modelsList:async input=>{calls.push(input);return listed(['new-model']);}};
 const h=uiHarness(f.client,discovery);await ready(h);h.view('openai');await flush();h.render();h.key('openai','synthetic-secret');h.change('agent-settings-protocol-openai','responses');await flush();h.render();assert.equal(calls.length,0);
 h.click('agent-settings-fetch-openai');await flush();h.render();assert.equal(calls.length,1);assert.equal(calls[0]!.selection.protocol,'responses');assert.deepEqual(calls[0]!.credential,{source:'input',value:'synthetic-secret'});assert.equal(h.keyValue('openai'),'synthetic-secret');assert.equal(f.calls.length,0);assert.equal(f.saved().mioSelection?.serviceKey,custom);h.unmount();
});

test('a test of the current Mio draft uses its typed key and model, and clears its result on discard',async()=>{
 const f=settingsUiFixture(),calls:Parameters<typeof modelDiscovery.testAgentDraftConnection>[0][]=[];
 const h=uiHarness(f.client,undefined,async input=>{calls.push(input);return {outcome:'success'};});
 await ready(h);h.view(custom);await flush();h.render();
 h.key(custom,'synthetic-secret-custom');h.click(`agent-settings-draft-test-${custom}`);await flush();h.render();
 assert.equal(calls.length,1);
 assert.equal(calls[0]?.model,f.saved().mioSelection?.modelId);
 assert.deepEqual(calls[0]?.credential,{source:'input',value:'synthetic-secret-custom'});
 assert.ok(h.find(`agent-settings-draft-test-result-${custom}`));
 assert.equal(h.keyValue(custom),'synthetic-secret-custom');
 assert.equal(f.calls.length,0);
 h.click('agent-settings-cancel');await flush();h.render();
 assert.equal(h.keyValue(custom),'');
 assert.equal(nodes(h.render()).some(node=>node.props['data-testid']===`agent-settings-draft-test-result-${custom}`),false);
 assertNoSecrets(h.reports);
 h.unmount();
});

test('actual selected detail can list with its own saved key before it becomes the saved Mio selection',async()=>{
 const initial=uiSettings();initial.services.find(entry=>entry.serviceKey==='openai')!.secret={configured:true,storage:'session'};const f=settingsUiFixture({initial}),calls:Parameters<AgentModelListClient['modelsList']>[0][]=[],discovery:AgentModelListClient={modelsCache:async()=>({status:'miss'}),modelsList:async input=>{calls.push(input);return listed(['new-model']);}};
 const h=uiHarness(f.client,discovery);await ready(h);h.view('openai');await flush();h.render();assert.equal(calls.length,0);h.click('agent-settings-fetch-openai');await flush();h.render();assert.equal(calls.length,1);assert.equal(h.picker()?.props.usesDraftKey,false);assert.equal(calls[0]!.serviceKey,'openai');assert.deepEqual(calls[0]!.credential,{source:'saved'});assert.equal(f.saved().mioSelection?.serviceKey,custom);assert.equal(f.calls.length,0);assert.equal(f.saved().verification,'not_tested');assert.equal(h.find('agent-settings-save').props.disabled,true);h.unmount();
});

test('actual complete missing warning retains the Mio row; partial and failed refreshes cannot assert a model disappeared',async()=>{
 let result:Awaited<ReturnType<AgentModelListClient['modelsList']>>=listed();const f=settingsUiFixture(),discovery:AgentModelListClient={modelsCache:async()=>({status:'hit',result:listed()}),modelsList:async()=>result};
 const h=uiHarness(f.client,discovery);await ready(h);h.view(custom);await flush();h.render();assert.ok(h.find(`agent-settings-model-missing-${custom}`));const model=f.saved().mioSelection!.modelId;assert.ok(h.find(`agent-settings-model-row-${custom}-${model}`));
 h.key(custom,'synthetic-secret');result={...listed(),complete:false};h.click(`agent-settings-fetch-${custom}`);await flush();h.render();assert.equal(nodes(h.render()).some(node=>node.props['data-testid']===`agent-settings-model-missing-${custom}`),false);assert.ok(h.find(`agent-settings-model-row-${custom}-${model}`));h.closePicker();
 result={outcome:'invalid_key',reason:'rejected'};h.click(`agent-settings-check-key-${custom}`);await flush();h.render();assert.equal(h.find(`agent-settings-model-list-status-${custom}`).props['data-phase'],'invalid_key');assert.equal(nodes(h.render()).some(node=>node.props['data-testid']===`agent-settings-model-missing-${custom}`),false);assert.deepEqual(f.saved().mioSelection,{serviceKey:custom,modelId:model});assert.equal(f.calls.length,0);h.unmount();
});

test('actual missing warning applies only to the saved connection and remains valid through manual-model-only edits',async()=>{
 for(const edit of ['protocol','address','platform','manual']){
  const initial=edit==='platform'?adapterSettings({presetId:'minimax',platformId:'china',baseUrl:'https://api.minimax.cn/v1',model:'MiniMax-M3',protocol:'chat_completions'},{revision:0,secretStorage:'session'}):adapterSettings(undefined,{revision:0,secretStorage:'session'});
  const f=settingsUiFixture({initial}),key=initial.mioSelection!.serviceKey,model=initial.mioSelection!.modelId,discovery:AgentModelListClient={modelsCache:async()=>({status:'hit',result:listed()}),modelsList:async()=>listed()};
  const h=uiHarness(f.client,discovery);await ready(h);h.view(key);await flush();h.render();assert.ok(h.find(`agent-settings-model-missing-${key}`));
  if(edit==='protocol')h.change(`agent-settings-protocol-${key}`,'responses');
  else if(edit==='manual'){const input=h.find(`agent-settings-model-${key}`);(input.props.ref as {current:{value:string}}).current.value='manual-extra';h.click(`agent-settings-add-model-${key}`);}
  else{
   if(edit==='platform')h.change(`agent-settings-platform-${key}`,'international');
   else{h.change(`agent-settings-base-url-${key}`,'https://changed.example');invoke(h.find(`agent-settings-base-url-${key}`),'onBlur');h.render();}
  }
  await flush();h.render();assert.equal(h.find(`agent-settings-model-list-status-${key}`).props['data-phase'],'success');
  assert.equal(nodes(h.render()).some(node=>node.props['data-testid']===`agent-settings-model-missing-${key}`),edit==='manual',edit);
  assert.ok(h.find(`agent-settings-model-row-${key}-${model}`));assert.deepEqual(f.saved().mioSelection,initial.mioSelection);assert.equal(f.calls.length,0);h.unmount();
 }
});

test('actual detail switch, binding changes and page hide cancel fetches without losing independent DOM inputs or accepting late rows',async()=>{
 for(const action of ['switch','binding','hide','save','key','cancel']){
  const pending=deferred(),signals:AbortSignal[]=[],f=settingsUiFixture(),discovery:AgentModelListClient={modelsCache:async()=>({status:'miss'}),modelsList:async(_input,options)=>{signals.push(options.signal);return pending.promise;}};
  const h=uiHarness(f.client,discovery);await ready(h);h.view(custom);await flush();h.render();h.key(custom,'synthetic-secret-custom');h.click(`agent-settings-fetch-${custom}`);await flush();h.render();assert.equal(signals.length,1);const oldPicker=h.picker();assert.ok(oldPicker);const oldFetch=h.find(`agent-settings-fetch-${custom}`);
  if(action==='switch'){h.view('openai');assert.equal(h.keyValue(custom),'synthetic-secret-custom');invoke(oldFetch,'onClick');}
  else if(action==='binding')h.change(`agent-settings-base-url-${custom}`,'https://changed.example');else if(action==='hide')h.setVisible(false);else if(action==='key')h.key(custom,'synthetic-secret-new');else if(action==='cancel')h.closePicker();else h.save();
  assert.equal(h.picker(),undefined,action);assert.equal(signals[0]!.aborted,true,action);pending.resolve(listed(['late-model']));await flush();h.render();invoke(oldPicker,'onAdd',['late-model']);h.render();assert.equal(h.modelRow(custom,'late-model'),undefined,action);if(action!=='save')assert.equal(f.calls.length,0);h.unmount();
 }
});

test('current verification requires active token, three-part binding and exact protocol/model; old summaries remain historical',async()=>{
 const f=settingsUiFixture(),h=uiHarness(f.client);await ready(h);const execution=f.saved().execution!,latest={completedAt:'2026-11-04T00:00:00.000Z',status:'completed' as const,protocol:execution.configuration.protocol,model:execution.configuration.model,errorCode:null,settingsRevision:execution.revision,settingsBinding:execution.binding};assert.equal(h.matches(latest,execution),true);
 for(const patch of [{settingsRevision:undefined},{settingsBinding:undefined},{settingsRevision:execution.revision+1},{settingsBinding:{...execution.binding,entryRevision:execution.binding.entryRevision+1}},{settingsBinding:{...execution.binding,selectionRevision:execution.binding.selectionRevision+1}},{protocol:'responses'},{model:'other-model'}] as const)assert.equal(h.matches({...latest,...patch},execution),false);h.unmount();
});

test('UI preserves local-only configuration ownership and password secrecy boundaries',()=>{
 assert.doesNotMatch(source,/localStorage|sessionStorage|fetch\(|rpc\(|<Dialog|type="text"[^\n]*agent-settings-key/);assert.match(source,/SettingsServicesLayout/);assert.match(source,/AgentTaskPolicy/);assert.match(source,/AgentAuthorizations/);assert.match(source,/AgentConnectionTest/);
 assert.doesNotMatch(source,/<Input[^>]*(?:value|defaultValue)=\{[^}]*secret/);assert.match(source,/visibilitychange/);
});

test('protocol/catalog DTO negatives fail closed and never dispatch',async()=>{
 for(const protocol of [undefined,null,'','Responses','auto','__proto__',1,{}]){
  const initial=uiSettings(),entry=initial.services.find(item=>item.serviceKey===custom)!;Object.assign(entry,{protocol});
  const f=settingsUiFixture({read:()=>initial});assert.equal(await f.session.load(),false);assert.equal(await f.session.save(),false);assert.equal(f.calls.length,0);
 }
 for(const patch of [{defaultProtocol:undefined},{availableProtocols:[]},{availableProtocols:['auto']},{availableProtocols:['responses'],defaultProtocol:'chat_completions'},{availableProtocols:['responses','responses']},{supportedModelHints:{responses:[1]}}]){
  const initial=uiSettings();Object.assign(initial.presets[0]!.platforms[0]!,patch);assert.throws(()=>logic.safeAgentSettings(initial));
 }
});

test('local address/key validation keeps genuine custom/Ollama input but rejects credentials, queries, controls and overlimits',async()=>{
 for(const addressInput of ['', 'not-a-url','http://remote.example','https://name:pass@example.com','https://example.com?key=x','https://example.com#x','https://example.com/'+ 'x'.repeat(2048)]){
  const f=settingsUiFixture();await f.session.load();f.session.editService(custom,{addressInput});let clears=0;assert.equal(await f.session.save({read:()=>'',clear:()=>{clears++;}}),false);assert.equal(clears,1);assert.equal(f.calls.length,0);
 }
 for(const value of [' ','synthetic-secret\ncontrol','x'.repeat(8193),'密'.repeat(2731)]){
  const f=settingsUiFixture();await f.session.load();let clears=0;assert.equal(await f.session.save({read:key=>key===custom?value:'',clear:()=>{clears++;}}),false);assert.equal(clears,1);assert.equal(f.calls.length,0);assertNoSecrets(f.emitted);
 }
 const f=settingsUiFixture();await f.session.load();f.session.editService('ollama',{addressInput:'http://127.0.0.1:11434'});assert.equal(await f.session.save(),true);
});

test('client never reflects raw messages, details, unknown codes or thrown credential text; timeout cannot accept a late result',async()=>{
 for(const code of ['AGENT_SETTINGS_VALIDATION','synthetic-secret']){
  const client=logic.createAgentSettingsClient({fetchImpl:async()=>Response.json({ok:false,error:{code,message:'synthetic-secret',details:{value:'synthetic-secret'}}},{status:400})});
  await assert.rejects(client.read(),error=>{assert.doesNotMatch(JSON.stringify(error)+String(error),/synthetic-secret/);return true;});
 }
 await assert.rejects(logic.createAgentSettingsClient({fetchImpl:()=>{throw Error('synthetic-secret');}}).write({}),error=>{assert.doesNotMatch(String(error),/synthetic-secret/);return true;});
 const held=deferred();let calls=0,aborts=0;const client=logic.createAgentSettingsClient({timeoutMs:2,fetchImpl:(_url,options)=>{calls++;options?.signal?.addEventListener('abort',()=>{aborts++;});return held.promise as Promise<Response>;}});await assert.rejects(client.write({}));held.resolve(Response.json({ok:true,data:uiSettings()}));await flush();assert.equal(calls,1);assert.equal(aborts,1);
});

test('non-secret save does not invent a configured key; changing storage without input never migrates a saved key',async()=>{
 const f=settingsUiFixture();await f.session.load();f.session.selectMio(custom,'new-model');assert.equal(await f.session.save(),true);assert.equal(f.saved().execution?.secret.configured,false);assert.equal(f.calls[0]!.secretActions.find(action=>action.serviceKey===custom)?.action,'keep');
 const initial=uiSettings();initial.services.find(item=>item.serviceKey===custom)!.secret={configured:true,storage:'session'};initial.execution!.secret={configured:true,storage:'session'};
 const g=settingsUiFixture({initial});await g.session.load();g.session.setStorage(custom,'persistent');assert.equal(logic.agentSettingsDirty(g.session.getState()),false);g.session.selectMio(custom,'new-model');await g.session.save();assert.equal(g.calls[0]!.secretActions.find(action=>action.serviceKey===custom)?.action,'keep');assert.equal(g.saved().execution?.secret.storage,'session');
});

test('changed destination removes its saved key unless explicitly replaced; model/protocol-only edits keep same receiver key',async()=>{
 for(const replacement of [false,true]){
  const initial=uiSettings();initial.services.find(item=>item.serviceKey===custom)!.secret={configured:true,storage:'session'};initial.execution!.secret={configured:true,storage:'session'};
  const f=settingsUiFixture({initial});await f.session.load();f.session.selectMio(custom,'changed-model');f.session.selectProtocol(custom,'responses');await f.session.save();assert.equal(f.calls[0]!.secretActions.find(action=>action.serviceKey===custom)?.action,'keep');assert.equal(f.saved().execution?.configuration.model,'changed-model');assert.equal(f.saved().execution?.configuration.protocol,'responses');
  f.session.editService(custom,{addressInput:'https://other.example'});await f.session.save({read:key=>replacement&&key===custom?'synthetic-secret':'',clear:()=>{}});assert.equal(f.calls[1]!.secretActions.find(action=>action.serviceKey===custom)?.action,replacement?'replace':'remove');assert.equal(f.saved().execution?.secret.configured,replacement);
 }
});

test('remove is reversible before save and confirmed status changes only after its real acknowledgement',async()=>{
 const initial=uiSettings();initial.services.find(item=>item.serviceKey===custom)!.secret={configured:true,storage:'session'};initial.execution!.secret={configured:true,storage:'session'};
 const held=deferred(),f=settingsUiFixture({initial,write:()=>held.promise});await f.session.load();f.session.removeKey(custom);assert.equal(f.session.getState().snapshot?.execution?.secret.configured,true);f.session.removeKey(custom,false);assert.equal(f.session.getState().serviceIntents[custom]!.action,'keep');f.session.removeKey(custom);const pending=f.session.save();assert.equal(f.session.getState().snapshot?.execution?.secret.configured,true);held.resolve(f.saved());assert.equal(await pending,true);assert.equal(f.session.getState().snapshot?.execution?.secret.configured,false);
});

test('outstanding write rejects double save and metadata/platform/protocol/key changes while still allowing view navigation',async()=>{
 const held=deferred(),f=settingsUiFixture({write:()=>held.promise});await f.session.load();const pending=f.session.save({read:key=>key==='openai'?'synthetic-secret':'',clear:()=>{}});assert.equal(f.session.getState().phase,'saving');assert.equal(await f.session.save(),false);assert.equal(f.session.editService(custom,{name:'late'}),false);assert.equal(f.session.selectPlatform('minimax','international'),false);assert.equal(f.session.selectProtocol(custom,'responses'),false);assert.equal(f.session.removeKey(custom),false);assert.equal(f.session.setStorage(custom,'session'),false);assert.equal(f.session.view('deepseek'),true);assert.equal(f.calls.length,1);held.resolve(f.saved());assert.equal(await pending,true);
});

test('wrong successful secret/protocol acknowledgements reconcile once without claiming success or retry',async()=>{
 for(const cause of ['replace','remove','keep','protocol']){
  const initial=uiSettings();if(cause!=='replace'){initial.services.find(item=>item.serviceKey===custom)!.secret={configured:true,storage:'session'};initial.execution!.secret={configured:true,storage:'session'};}
  const f=settingsUiFixture({initial,write:(_input,saved)=>{const wrong=structuredClone(saved),entry=wrong.services.find(item=>item.serviceKey===custom)!;if(cause==='protocol'){entry.protocol='chat_completions';wrong.execution!.configuration.protocol='chat_completions';}else {entry.secret=cause==='replace'?{configured:false,storage:'none'}:cause==='remove'?{configured:true,storage:'session'}:{configured:true,storage:'persistent'};wrong.execution!.secret=entry.secret;}return wrong;}});await f.session.load();if(cause==='remove')f.session.removeKey(custom);if(cause==='protocol')f.session.selectProtocol(custom,'responses');assert.equal(await f.session.save({read:key=>cause==='replace'&&key===custom?'synthetic-secret':'',clear:()=>{}}),false);assert.equal(f.session.getState().phase,'review');assert.equal(f.reads,2);assert.equal(f.calls.length,1);assert.equal(await f.session.save(),false);assertNoSecrets(f.emitted);
 }
});

test('failed reconciliation only retries GET and retains blocked draft until explicit review',async()=>{
 const f=settingsUiFixture({read:(count,saved)=>count===2?Promise.reject(codeError('NETWORK')):saved,write:()=>Promise.reject(codeError('NETWORK'))});await f.session.load();f.session.addModel('openai','retained');await f.session.save();assert.equal(f.session.getState().phase,'blocked');assert.equal(f.session.acknowledge(),false);assert.equal(f.session.useLatest(),false);assert.equal(await f.session.save(),false);await f.session.reload();assert.equal(f.reads,3);assert.equal(f.calls.length,1);assert.ok(f.session.getState().draft?.services.find(item=>item.serviceKey==='openai')?.manualModelIds.includes('retained'));assert.equal(f.session.getState().phase,'review');assert.equal(logic.agentSettingsCanSave(f.session.getState()),false);f.session.acknowledge();assert.equal(logic.agentSettingsCanSave(f.session.getState()),true);
});

test('late initial read, accepted write and recovery read never publish after disposal',async()=>{
 for(const stage of ['read','write','reconcile']){
  const held=deferred(),f=settingsUiFixture({read:(count,saved)=>stage==='read'||stage==='reconcile'&&count>1?held.promise:saved,write:(_input,saved)=>stage==='write'?held.promise:Promise.reject(codeError('NETWORK'))});const loading=f.session.load();if(stage!=='read')await loading;const pending=stage==='read'?loading:f.session.save({read:key=>key==='openai'?'synthetic-secret':'',clear:()=>{}});await flush();const count=f.emitted.length;f.session.dispose();held.resolve(f.saved());await pending;await flush();assert.equal(f.emitted.length,count);assert.equal(f.session.getState().snapshot,null);assert.equal(await f.session.save(),false);assert.equal(f.session.editService(custom,{name:'stale'}),false);
 }
});

test('no initial Mio selection remains null; custom count is bounded at ten and each item keeps its stable key',async()=>{
 const initial=adapterSettings(null),client:logic.AgentSettingsClient={read:async()=>initial,write:()=>assert.fail('No implicit save')};let serial=0;const session=logic.createAgentSettingsSession({client,newServiceKey:()=>`aaaaaaaa-bbbb-4ccc-8ddd-${String(++serial).padStart(12,'0')}`});await session.load();session.view('openai');assert.equal(session.getState().draft?.mioSelection,null);const ids=[];for(let i=0;i<10;i++){const id=session.addCustom(`Custom ${i}`);assert.ok(id);ids.push(id);}assert.equal(session.addCustom('Overflow'),null);assert.equal(new Set(ids).size,10);assert.equal(session.getState().draft?.services.length,19);assert.equal(session.getState().draft?.mioSelection,null);session.dispose();
});

test('actual Responses/Messages guidance preserves task authorization scope; custom v1 warning never silently rewrites the base',async()=>{
 const f=settingsUiFixture(),h=uiHarness(f.client);await ready(h);h.view(custom);h.change(`agent-settings-base-url-${custom}`,'https://custom.example/v1');h.change(`agent-settings-protocol-${custom}`,'anthropic_messages');assert.equal(h.find(`agent-settings-base-url-${custom}`).props.value,'https://custom.example/v1');assert.ok(h.find(`agent-settings-messages-v1-${custom}`));assert.match(JSON.stringify(h.find(`agent-settings-endpoint-${custom}`)),/\/v1\/v1\/messages/);
 for(const locale of i18n.LOCALES){h.setLocale(locale);assert.ok(h.find(`agent-settings-anthropic-guidance-${custom}`));assert.doesNotMatch(JSON.stringify(h.find(`agent-settings-anthropic-guidance-${custom}`)),/agent\.settings\.anthropicScope/);}
 h.change(`agent-settings-protocol-${custom}`,'responses');const guidance=JSON.stringify(h.find(`agent-settings-model-guidance-${custom}`));assert.match(guidance,/Responses|responses/);assert.equal(f.calls.length,0);h.unmount();
});

test('Qwen and Ollama protocols derive only their platform address and never silently replace the chosen Mio model',async()=>{
 const f=settingsUiFixture();await f.session.load();f.session.selectMio('qwen','user-qwen-id');assert.equal(f.session.selectProtocol('qwen','responses'),true);assert.equal(f.session.getState().draft?.mioSelection?.modelId,'user-qwen-id');f.session.selectMio('ollama','user-local-id');assert.equal(f.session.selectProtocol('ollama','anthropic_messages'),true);const entry=f.session.getState().draft!.services.find(item=>item.serviceKey==='ollama')!;assert.equal(entry.addressInput,'http://127.0.0.1:11434');assert.equal(logic.agentServiceEndpointPreview(entry,f.session.getState().snapshot!.presets),'http://127.0.0.1:11434/v1/messages');assert.equal(f.session.getState().draft?.mioSelection?.modelId,'user-local-id');assert.equal(f.calls.length,0);
});

test('actual hidden page retains non-secret edits and rejects its old actions after reveal',async()=>{
 const f=settingsUiFixture(),h=uiHarness(f.client);await ready(h);h.view(custom);h.change(`agent-settings-name-${custom}`,'Retained name');h.change(`agent-settings-protocol-${custom}`,'responses');h.key(custom,'synthetic-secret');const oldSubmit=h.form(),oldEdit=h.find(`agent-settings-name-${custom}`),oldProtocol=h.find(`agent-settings-protocol-${custom}`);h.setVisible(false);assert.equal(h.keyValue(custom),'');assert.equal(h.find('agent-settings-page').props.inert,true);assert.equal(h.find('agent-settings-save').props.disabled,true);invoke(oldSubmit,'onSubmit',{preventDefault(){}});invoke(oldEdit,'onChange',{target:{value:'stale'}});h.setVisible(true);invoke(oldSubmit,'onSubmit',{preventDefault(){}});invoke(oldEdit,'onChange',{target:{value:'stale-again'}});invoke(oldProtocol,'onValueChange','chat_completions');h.render();assert.equal(h.find(`agent-settings-name-${custom}`).props.value,'Retained name');assert.equal(h.find(`agent-settings-protocol-${custom}`).props.value,'responses');assert.equal(f.calls.length,0);h.unmount();
});

test('actual accepted save stays attached while hidden; four-language rerenders preserve DOM, pending request and identity',async()=>{
 const held=deferred(),f=settingsUiFixture({write:()=>held.promise}),h=uiHarness(f.client);await ready(h);h.view(custom);h.change(`agent-settings-name-${custom}`,'Unchanged across locales');h.key(custom,'synthetic-secret');const input=h.find(`agent-settings-key-${custom}`).props.ref;
 for(const locale of i18n.LOCALES){h.setLocale(locale);assert.equal(h.find('agent-settings-page').props['aria-label'],i18n.translate(locale,'agent.settings.title'));assert.equal(h.keyValue(custom),'synthetic-secret');assert.equal(h.find(`agent-settings-key-${custom}`).props.ref,input);assert.equal(h.find(`agent-settings-name-${custom}`).props.value,'Unchanged across locales');assert.equal(f.reads,1);assert.equal(f.calls.length,0);}
 h.save();const request=structuredClone(f.calls[0]);for(const locale of i18n.LOCALES){h.setLocale(locale);assert.equal(h.find('agent-settings-page').props['data-phase'],'saving');assert.deepEqual(f.calls,[request]);assert.equal(f.reads,1);}h.setVisible(false);held.resolve(f.saved());await flush();h.setVisible(true);assert.equal(h.find('agent-settings-page').props['data-phase'],'saved');assert.equal(h.find(`agent-settings-name-${custom}`).props.value,'Unchanged across locales');assert.equal(h.keyValue(custom),'');assert.equal(f.calls.length,1);h.unmount();
});


test('discarding or adopting a fresh server collection retires a removed custom panel and returns to general',async()=>{
 const f=settingsUiFixture();await f.session.load();const key=f.session.addCustom('Not saved');assert.ok(key);assert.equal(f.session.getState().selectedKey,key);assert.equal(f.session.useLatest(),true);assert.equal(f.session.getState().selectedKey,'general');assert.equal(f.session.getState().draft?.services.some(entry=>entry.serviceKey===key),false);
});


test('whole-page metadata and multi-key byte limits clear DOM values and dispatch nothing',async()=>{
 for(const cause of ['metadata','keys']){const f=settingsUiFixture();await f.session.load();if(cause==='metadata')for(const entry of f.session.getState().draft!.services)for(let i=0;i<50;i++)f.session.addModel(entry.serviceKey,`${String(i).padStart(3,'0')}-${'m'.repeat(196)}`);let clears=0;assert.equal(await f.session.save({read:()=>cause==='keys'?'s'.repeat(8192):'',clear:()=>{clears++;}}),false);assert.equal(clears,1);assert.equal(f.calls.length,0);assert.equal(f.session.getState().phase,'error');}
});
