import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import {catalogs} from '../packages/i18n/src/index.ts';
import {LOCALES} from '../packages/i18n/src/locale.ts';
import {agentTaskErrorKey} from '../apps/web/src/agent-task-errors.ts';
import type {AgentConnectionTestState} from '../apps/web/src/agent-connection-test.ts';

interface Element {type:unknown;props:{children?:unknown[]}}
function text(value:unknown):string {
  if(Array.isArray(value))return value.map(text).join('');
  if(value&&typeof value==='object'&&'props' in value)return text((value as Element).props.children);
  return value===null||value===undefined||typeof value==='boolean'?'':String(value);
}
function render(state:AgentConnectionTestState,locale:(typeof LOCALES)[number]='zh-Hans',blocked=false) {
  const dates:string[]=[],translationKeys:string[]=[];
  const React={createElement:(type:unknown,props:object|null,...children:unknown[]):Element=>({type,props:{...props,children}}),Fragment:'fragment',
    useMemo:(fn:()=>unknown)=>fn(),useLayoutEffect:()=>{},useRef:()=>({current:null}),useState:()=>[state,()=>{}]};
  const module:{exports:{default?:(props:unknown)=>unknown}}={exports:{}};
  const translate=(key:string,values:Record<string,unknown>={})=>{
    translationKeys.push(key);
    const entry=catalogs[key as keyof typeof catalogs];
    const translated=entry?.[locale];let value=typeof translated==='string'?translated:key;
    for(const [name,replacement] of Object.entries(values))value=value.replaceAll(`{${name}}`,String(replacement));
    return value;
  };
  const source=transformSync(readFileSync(new URL('../apps/web/src/AgentConnectionTest.tsx',import.meta.url),'utf8'),{loader:'tsx',format:'cjs',jsx:'transform'}).code;
  Function('require','module','exports',source)((id:string)=>{
    if(id==='react')return {__esModule:true,default:React,...React};
    if(id==='./i18n/I18nProvider.tsx')return {useI18n:()=>({t:translate,locale,formatDate:(date:string)=>{dates.push(date);return '已记录时间';}})};
    if(id==='./agent-task-errors.ts')return {agentTaskErrorKey};
    if(id==='./agent-connection-test.ts')return {createAgentConnectionTestSession:()=>assert.fail('Rendering a summary cannot open or poll a project')};
    if(id==='@mioon/ui/components/dialog')return {Dialog:'Dialog'};
    if(id==='@mioon/ui/components/workbench-controls')return {WorkbenchButton:'Button',WorkbenchDialogContent:'DialogContent'};
    if(id==='./icons.tsx')return {__esModule:true,default:'Icon'};
    throw Error(`Unexpected test dependency ${id}`);
  },module,module.exports);
  return {text:text(module.exports.default!({visible:true,configuration:{protocol:'responses',baseUrl:'https://a-different-endpoint.example',model:'another-model'},settingsRevision:3,blocked})),dates,translationKeys};
}

test('settings shows the global five-field summary as a diagnostic summary without claiming a current endpoint match',()=>{
  const completedAt='2026-11-02T08:00:00.000Z',latest={completedAt,status:'completed' as const,protocol:'chat_completions' as const,model:'diagnostic-model',errorCode:null};
  const result=render({phase:'idle',latest,review:null,error:null});
  assert.match(result.text,/最近诊断摘要（chat_completions · diagnostic-model）/);assert.match(result.text,/已记录时间/);assert.match(result.text,/连接正常/);assert.match(result.text,/历史诊断；不代表当前设置已通过测试/);
  assert.deepEqual(result.dates,[completedAt]);assert.doesNotMatch(result.text,/a-different-endpoint|another-model|undefined/);
  const failed=render({phase:'idle',latest:{...latest,status:'failed',errorCode:'AGENT_TASK_SETTINGS_CHANGED'},review:null,error:null});
  assert.ok(failed.translationKeys.includes(agentTaskErrorKey('AGENT_TASK_SETTINGS_CHANGED')));
});

test('connection test shows actionable HTTP, network and timeout reasons in every locale, with safe details only for a visible failure',()=>{
  const latest={completedAt:'2026-11-02T08:00:00.000Z',status:'failed' as const,protocol:'responses' as const,model:'diagnostic-model',errorCode:'AGENT_CHAT_HTTP_ERROR'};
  const idle={phase:'idle',review:null,error:null} as const;
  const httpCases=[[401,'invalidKey'],[403,'permissionDenied'],[404,'notFound'],[429,'rateLimited'],[503,'serverError']] as const;
  for(const locale of LOCALES){
    const reasons=new Set<string>();
    for(const [status,reason] of httpCases){
      const summary={...latest,diagnostic:{kind:'http' as const,status}};
      const result=render({...idle,latest:summary},locale);
      assert.ok(result.text.includes(`HTTP ${status}`));
      const reasonKey=`mio.settings.test.reason.${reason}` as keyof typeof catalogs;
      const copy=catalogs[reasonKey]?.[locale];
      assert.equal(typeof copy,'string',`${locale} ${reason}`);
      assert.ok(result.text.includes(String(copy)),`${locale} ${reason}`);
      reasons.add(String(copy));
    }
    for(const [errorCode,reason] of [['AGENT_CHAT_CONNECT_FAILED','connectionFailed'],['AGENT_CHAT_TIMEOUT','timeout'],['AGENT_CHAT_NETWORK_DENIED','networkDenied']] as const){
      const reasonKey=`mio.settings.test.reason.${reason}` as keyof typeof catalogs;
      const copy=catalogs[reasonKey]?.[locale];
      assert.equal(typeof copy,'string',`${locale} ${reason}`);
      assert.ok(render({...idle,latest:{...latest,errorCode}},locale).text.includes(String(copy)));
      reasons.add(String(copy));
    }
    assert.equal(reasons.size,httpCases.length+3);
  }
  const diagnostic={kind:'http',status:404,providerType:'not_found_error',providerCode:'model_not_found'} as const;
  const failed={...idle,latest:{...latest,diagnostic}};
  assert.match(render(failed).text,/HTTP 404.*not_found_error.*model_not_found/);
  assert.match(render({...idle,latest:{...latest,diagnostic:{...diagnostic,providerCode:404}}}).text,/错误代码[^0-9]*404/);
  assert.doesNotMatch(render(failed,'zh-Hans',true).text,/HTTP 404|not_found_error|model_not_found/);
  assert.doesNotMatch(render({...failed,phase:'testing'}).text,/HTTP 404|not_found_error|model_not_found/);
});
