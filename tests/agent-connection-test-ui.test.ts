import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import {catalogs} from '../packages/i18n/src/index.ts';
import {agentTaskErrorKey} from '../apps/web/src/agent-task-errors.ts';
import type {AgentConnectionTestState} from '../apps/web/src/agent-connection-test.ts';

interface Element {type:unknown;props:{children?:unknown[]}}
function text(value:unknown):string {
  if(Array.isArray(value))return value.map(text).join('');
  if(value&&typeof value==='object'&&'props' in value)return text((value as Element).props.children);
  return value===null||value===undefined||typeof value==='boolean'?'':String(value);
}
function render(state:AgentConnectionTestState) {
  const dates:string[]=[],translationKeys:string[]=[];
  const React={createElement:(type:unknown,props:object|null,...children:unknown[]):Element=>({type,props:{...props,children}}),Fragment:'fragment',
    useMemo:(fn:()=>unknown)=>fn(),useLayoutEffect:()=>{},useRef:()=>({current:null}),useState:()=>[state,()=>{}]};
  const module:{exports:{default?:(props:unknown)=>unknown}}={exports:{}};
  const translate=(key:string,values:Record<string,unknown>={})=>{
    translationKeys.push(key);
    const entry=catalogs[key as keyof typeof catalogs];
    const translated=entry?.['zh-Hans'];let value=typeof translated==='string'?translated:key;
    for(const [name,replacement] of Object.entries(values))value=value.replaceAll(`{${name}}`,String(replacement));
    return value;
  };
  const source=transformSync(readFileSync(new URL('../apps/web/src/AgentConnectionTest.tsx',import.meta.url),'utf8'),{loader:'tsx',format:'cjs',jsx:'transform'}).code;
  Function('require','module','exports',source)((id:string)=>{
    if(id==='react')return {__esModule:true,default:React,...React};
    if(id==='./i18n/I18nProvider.tsx')return {useI18n:()=>({t:translate,locale:'zh-Hans',formatDate:(date:string)=>{dates.push(date);return '已记录时间';}})};
    if(id==='./agent-task-errors.ts')return {agentTaskErrorKey};
    if(id==='./agent-connection-test.ts')return {createAgentConnectionTestSession:()=>assert.fail('Rendering a summary cannot open or poll a project')};
    if(id==='@mioon/ui/components/dialog')return {Dialog:'Dialog'};
    if(id==='@mioon/ui/components/workbench-controls')return {WorkbenchButton:'Button',WorkbenchDialogContent:'DialogContent'};
    if(id==='./icons.tsx')return {__esModule:true,default:'Icon'};
    throw Error(`Unexpected test dependency ${id}`);
  },module,module.exports);
  return {text:text(module.exports.default!({visible:true,configuration:{protocol:'responses',baseUrl:'https://a-different-endpoint.example',model:'another-model'},settingsRevision:3,blocked:false})),dates,translationKeys};
}

test('settings shows the global five-field summary as a diagnostic summary without claiming a current endpoint match',()=>{
  const completedAt='2026-11-02T08:00:00.000Z',latest={completedAt,status:'completed' as const,protocol:'chat_completions' as const,model:'diagnostic-model',errorCode:null};
  const result=render({phase:'idle',latest,review:null,error:null});
  assert.match(result.text,/最近诊断摘要（chat_completions · diagnostic-model）/);assert.match(result.text,/已记录时间/);assert.match(result.text,/连接正常/);assert.match(result.text,/历史诊断；不代表当前设置已通过测试/);
  assert.deepEqual(result.dates,[completedAt]);assert.doesNotMatch(result.text,/a-different-endpoint|another-model|undefined/);
  const failed=render({phase:'idle',latest:{...latest,status:'failed',errorCode:'AGENT_TASK_SETTINGS_CHANGED'},review:null,error:null});
  assert.ok(failed.translationKeys.includes(agentTaskErrorKey('AGENT_TASK_SETTINGS_CHANGED')));
});
