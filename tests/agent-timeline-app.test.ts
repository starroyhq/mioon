import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

import { lenientFunction } from './helpers/eval-source.ts';
import { message as msg, renderMessage as renderCoreMessage } from './helpers/i18n.ts';
const Function = lenientFunction;
const source=readFileSync(new URL('../apps/web/src/App.tsx',import.meta.url),'utf8');
function expression(name: string): string {const value=source.match(new RegExp(`const ${name} = ([\\s\\S]*?);\\n`))?.[1];assert.ok(value,`actual App ${name} expression`);return value;}
type SelectionFn = (mode: string, page: string, quick: string | null, make: (...args: unknown[]) => unknown, saved: unknown, selectedClipId: string, data: unknown) => unknown;
type ReasonFn = (online: boolean, auth: boolean, loading: boolean, inspectorDirty: boolean, timelineBusy: boolean, msg: (...args: unknown[]) => unknown, renderCoreMessage: (...args: unknown[]) => unknown) => string;
const selection=Function('workspaceMode','propertiesPage','quickAssetId','makeAgentTimelineClipSelection','timeline','selectedClipId','data',`return (${expression('agentTimelineSelection')});`) as SelectionFn;
const reason=Function('online','auth','loading','inspectorDirty','timelineBusy','msg','renderCoreMessage',`const agentTimelineBlockedDescriptor = ${expression('agentTimelineBlockedDescriptor')}; return (${expression('agentTimelineBlockedReason')});`) as ReasonFn;

test('actual App passes only the selected saved clip in the editing inspector to Agent',()=>{
 const calls: unknown[][]=[],saved={revision:7},sentinel=Object.freeze({clipId:'selected'}),make=(...args: unknown[])=>{calls.push(args);return sentinel;};
 assert.equal(selection('editing','inspector',null,make,saved,'selected',{project:{id:'project'}}),sentinel);
 assert.deepEqual(calls,[[saved,'selected','project']]);
 for(const [mode,page,quick] of [['canvas','inspector',null],['editing','subtitle',null],['editing','format',null],['editing','inspector','source']] as Array<[string,string,string|null]>)assert.equal(selection(mode,page,quick,make,saved,'selected',{project:{id:'project'}}),null);
 assert.equal(calls.length,1,'hidden stale selection must not become an active Agent target');
 assert.match(source,/selectedTimelineClip=\{agentTimelineSelection\} timelineEditBlockedReason=\{agentTimelineBlockedReason(?: as never)?\}/);
});

test('actual App blocks timeline proposals on every draft, offline/loading or unresolved timeline state',()=>{
 const dirty=Function('shotDirty','clipDirty','sourceDirty','subjectDirty','subtitleDirty',`return (${expression('inspectorDirty')});`) as (...flags: unknown[]) => unknown;
 const blocked=(...flags: unknown[]): string =>reason(flags[0] as boolean, flags[1] as boolean, flags[2] as boolean, flags[3] as boolean, flags[4] as boolean, msg as never, renderCoreMessage as never);
 for(let i=0;i<5;i++){const flags=Array(5).fill(false);flags[i]=true;assert.equal(dirty(...flags),true);assert.match(blocked(true,true,false,dirty(...flags),false),/草稿/);}
 for(const inputs of [[false,true,false,false,false],[true,false,false,false,false],[true,null,false,false,false],[true,true,true,false,false]] as Array<Array<boolean | null>>)assert.match(blocked(...inputs),/连接与数据加载/);
 assert.match(blocked(true,true,false,false,true),/待确认/);
 assert.equal(blocked(true,true,false,false,false),'');
});

test('actual applied receipt callback rereads only current project and never applies historical timeline or clears drafts',()=>{
 const body=source.match(/onApplied=\{\(projectId: string\) => \{([^}]+)\}\}/)?.[1];assert.ok(body);
 assert.doesNotMatch(body,/setData|setClipDirty|setSubtitleDirty|setSourceDirty|setInspectorEpoch|setSelected|rpc|proposal|outcome/);
 const calls: string[]=[],apply=Function('currentProject','refresh',`return projectId=>{${body}}`)({current:'current'},(id: string)=>calls.push(id)) as (id: string) => void;
 apply('foreign');apply('current');assert.deepEqual(calls,['current']);
 const liveKey=source.match(/key: `\$\{data\.project\?\.id\}:\$\{chosenClip\.id\}:\$\{inspectorEpoch\}`/)?.[0];
 assert.equal(liveKey,'key: `${data.project?.id}:${chosenClip.id}:${inspectorEpoch}`','inspector identity excludes timeline revision');
 assert.match(source,/key=\{displayedClipInspector\.key\}/);
 assert.doesNotMatch(String(liveKey),/revision/,'new timeline revision must not remount and discard a dirty Inspector');
});
