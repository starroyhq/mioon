import assert from 'node:assert/strict';
import {agentServiceInput,agentSettingsSnapshotSchema,agentSettingsUpdateSchema} from '../../packages/contracts/src/agent-connection-settings.ts';
import type {AgentSettingsSnapshot,AgentSettingsUpdate} from '../../packages/contracts/src/agent-connection-settings.ts';
import {adapterSettings,ADAPTER_CUSTOM_SERVICE_KEY} from './agent-adapter-fixture.ts';
import {agentServiceBindingChanged,agentServiceConfiguration,createAgentSettingsSession} from '../../apps/web/src/agent-settings.ts';
import type {AgentSettingsClient,AgentSettingsState} from '../../apps/web/src/agent-settings.ts';
export {ADAPTER_CUSTOM_SERVICE_KEY};
export const uiSettings=():AgentSettingsSnapshot=>adapterSettings(undefined,{revision:0});
export function savedUiSettings(before:AgentSettingsSnapshot,raw:unknown):AgentSettingsSnapshot {
 const input=agentSettingsUpdateSchema.parse(raw),services=input.services.map(entry=>{
  const previous=before.services.find(saved=>saved.serviceKey===entry.serviceKey),action=input.secretActions.find(action=>action.serviceKey===entry.serviceKey);
  const secret=action?.action==='replace'?{configured:true,storage:action.storage}:action?.action==='remove'||agentServiceBindingChanged(previous,entry,before.presets)?{configured:false,storage:'none' as const}:previous!.secret;
  const changed=!previous||JSON.stringify(agentServiceInput(previous))!==JSON.stringify(entry)||JSON.stringify(previous.secret)!==JSON.stringify(secret)||action?.action==='replace';
  return {...entry,revision:(previous?.revision??0)+(changed?1:0),secret};
 });
 const selected=services.find(entry=>entry.serviceKey===input.mioSelection?.serviceKey),selectionChanged=JSON.stringify(input.mioSelection)!==JSON.stringify(before.mioSelection),selectionRevision=before.mioSelectionRevision+(selectionChanged?1:0);
 const configuration=selected&&input.mioSelection?agentServiceConfiguration(selected,input.mioSelection.modelId,before.presets):null;
 return agentSettingsSnapshotSchema.parse({...before,revision:before.revision+1,services,mioSelection:input.mioSelection,mioSelectionRevision:selectionRevision,
  execution:configuration&&selected?{revision:(before.execution?.revision??0)+1,binding:{serviceKey:selected.serviceKey,entryRevision:selected.revision,selectionRevision},configuration,secret:selected.secret}:null,notices:[]});
}
export function settingsUiFixture(options:{initial?:AgentSettingsSnapshot;read?:(count:number,saved:AgentSettingsSnapshot)=>Promise<unknown>|unknown;write?:(input:AgentSettingsUpdate,saved:AgentSettingsSnapshot)=>Promise<unknown>|unknown}={}) {
 let saved=options.initial??uiSettings(),reads=0;const calls:AgentSettingsUpdate[]=[],emitted:AgentSettingsState[]=[];
 const client:AgentSettingsClient={read:()=>{reads++;return Promise.resolve(options.read?options.read(reads,saved):structuredClone(saved));},write:raw=>{
  const input=agentSettingsUpdateSchema.parse(raw);calls.push(structuredClone(input));saved=savedUiSettings(saved,input);return Promise.resolve(options.write?options.write(input,saved):structuredClone(saved));
 }};
 const session=createAgentSettingsSession({client,onChange:value=>emitted.push(structuredClone(value)),newServiceKey:()=> 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'});
 return {client,calls,emitted,session,get reads(){return reads;},saved:()=>saved};
}
export const flushSettingsUi=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
export function deferredSettingsUi(){let resolve!:(value:unknown)=>void,reject!:(error:unknown)=>void;const promise=new Promise<unknown>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
export function assertNoSecrets(value:unknown){assert.doesNotMatch(JSON.stringify(value),/synthetic-secret|reflected-secret/);}
