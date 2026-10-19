import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('../apps/web/src/App.tsx',import.meta.url),'utf8');
function expression(name){const value=source.match(new RegExp(`const ${name} = ([\\s\\S]*?);\\n`))?.[1];assert.ok(value,`actual App ${name} expression`);return value;}
const selection=Function('workspaceMode','propertiesPage','quickAssetId','makeAgentTimelineClipSelection','timeline','selectedClipId','data',`return (${expression('agentTimelineSelection')});`);
const reason=Function('online','auth','loading','inspectorDirty','timelineBusy',`return (${expression('agentTimelineBlockedReason')});`);

test('actual App passes only the selected saved clip in the editing inspector to Agent',()=>{
 const calls=[],saved={revision:7},sentinel=Object.freeze({clipId:'selected'}),make=(...args)=>{calls.push(args);return sentinel;};
 assert.equal(selection('editing','inspector',null,make,saved,'selected',{project:{id:'project'}}),sentinel);
 assert.deepEqual(calls,[[saved,'selected','project']]);
 for(const [mode,page,quick] of [['canvas','inspector',null],['editing','subtitle',null],['editing','format',null],['editing','inspector','source']])assert.equal(selection(mode,page,quick,make,saved,'selected',{project:{id:'project'}}),null);
 assert.equal(calls.length,1,'hidden stale selection must not become an active Agent target');
 assert.match(source,/selectedTimelineClip=\{agentTimelineSelection\} timelineEditBlockedReason=\{agentTimelineBlockedReason\}/);
});

test('actual App blocks timeline proposals on every draft, offline/loading or unresolved timeline state',()=>{
 const dirty=Function('shotDirty','clipDirty','sourceDirty','subjectDirty','subtitleDirty',`return (${expression('inspectorDirty')});`);
 for(let i=0;i<5;i++){const flags=Array(5).fill(false);flags[i]=true;assert.equal(dirty(...flags),true);assert.match(reason(true,true,false,dirty(...flags),false),/草稿/);}
 for(const inputs of [[false,true,false,false,false],[true,false,false,false,false],[true,null,false,false,false],[true,true,true,false,false]])assert.match(reason(...inputs),/连接与数据加载/);
 assert.match(reason(true,true,false,false,true),/待确认/);
 assert.equal(reason(true,true,false,false,false),'');
});

test('actual applied receipt callback rereads only current project and never applies historical timeline or clears drafts',()=>{
 const body=source.match(/onApplied=\{projectId => \{([^}]+)\}\}/)?.[1];assert.ok(body);
 assert.doesNotMatch(body,/setData|setClipDirty|setSubtitleDirty|setSourceDirty|setInspectorEpoch|setSelected|rpc|proposal|outcome/);
 const calls=[],apply=Function('currentProject','refresh',`return projectId=>{${body}}`)({current:'current'},id=>calls.push(id));
 apply('foreign');apply('current');assert.deepEqual(calls,['current']);
 const key=source.match(/<TimelineInspector\b[^>]*?\bkey=\{(`[^`]+`)\}/)?.[1];
 assert.equal(key,'`${data.project?.id}:${chosenClip.id}:${inspectorEpoch}`','new timeline revision must not remount and discard a dirty Inspector');
});
