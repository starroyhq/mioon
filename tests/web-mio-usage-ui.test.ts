import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import type {MioUsageRowProps,MioUsageDetailsProps} from '../apps/web/src/MioUsage.tsx';
import type {MioUsageView} from '../apps/web/src/mio-usage-state.ts';
import type {MioRunUsage} from '../packages/contracts/src/mio-run-usage.ts';
import {mioRunUsageSchema} from '../packages/contracts/src/mio-run-usage.ts';
import {mioUsageUiMessages} from '../packages/i18n/src/catalogs/mio-usage-ui.ts';
import {validateCatalogs} from '../packages/i18n/src/index.ts';
import type {Locale} from '../packages/i18n/src/types.ts';
import {usageFixture,USAGE_RUN_ID as runId} from './helpers/mio-usage-fixture.ts';
const root=fileURLToPath(new URL('../',import.meta.url));
interface Ui {row(props:MioUsageRowProps,locale:Locale):string;details(props:MioUsageDetailsProps,locale:Locale):string;detailsTree(props:MioUsageDetailsProps):unknown}
const result=await build({stdin:{contents:`import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';import {MioUsageRow,MioUsageDetails} from './src/MioUsage.tsx';import {fixtureLocale} from './src/i18n/I18nProvider.tsx';export const row=(props,locale)=>{fixtureLocale(locale);return renderToStaticMarkup(<MioUsageRow {...props}/>)};export const details=(props,locale)=>{fixtureLocale(locale);return renderToStaticMarkup(<MioUsageDetails {...props}/>)};export const detailsTree=props=>MioUsageDetails(props);`,loader:'tsx',resolveDir:path.join(root,'apps/web')},bundle:true,platform:'node',format:'cjs',write:false,jsx:'automatic',loader:{'.css':'empty'},plugins:[{name:'controlled-dialog-and-locale',setup(build){
  build.onLoad({filter:/apps\/web\/src\/i18n\/I18nProvider\.tsx$/},()=>({contents:`import {createI18nTestContext} from ${JSON.stringify(path.join(root,'tests/helpers/i18n.ts'))};let locale='zh-Hans';export const fixtureLocale=value=>{locale=value};export const useI18n=()=>createI18nTestContext(locale);`,loader:'ts'}));
  build.onLoad({filter:/packages\/ui\/src\/components\/dialog\.tsx$/},()=>({contents:`import React from 'react';export const Dialog=({open,children})=>open?<section role="dialog">{children}</section>:null;export const DialogContent=({children,finalFocus,...props})=><div {...props}>{children}</div>;export const DialogTitle=({children})=><h2>{children}</h2>;export const DialogDescription=({children})=><p>{children}</p>;`,loader:'tsx'}));
}}]});
const module:{exports:Ui}={exports:{} as Ui};Function('require','module','exports',result.outputFiles[0]!.text)(createRequire(import.meta.url),module,module.exports);const ui=module.exports;
const ready=(value:MioRunUsage=usageFixture()):MioUsageView=>({phase:'ready',value:mioRunUsageSchema.parse(value),stale:false,code:null,final:true});
const row=(value:MioUsageView,locale:Locale='zh-Hans')=>ui.row({runId,view:value,onOpen(){}},locale);
const details=(value:MioUsageView,locale:Locale='zh-Hans')=>ui.details({open:true,runId,view:value,onClose(){},onRetry(){}},locale);
const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);

test('token units are localized rather than appended as a fixed English suffix',()=>{
  const units={'zh-Hans':'词元','zh-Hant':'詞元',en:'tokens',ja:'トークン'} as const;
  for(const locale of ['zh-Hans','zh-Hant','en','ja'] as const){const html=details(ready(),locale);assert.ok(html.includes(`1,000 ${units[locale]}`),locale);if(locale!=='en')assert.doesNotMatch(html,/1,000 tokens/);}
});
test('English request and token counts use singular and plural forms',()=>{
  const single=usageFixture({dispatchedModelSteps:1,modelOutcomes:{completed:1,failed:0,unknown:0,inflight:0},knownTotals:{inputTokens:1,outputTokens:1,cacheReadTokens:1,cacheWriteTokens:0},cacheReadRate:1,
    coverage:{fields:Object.fromEntries(['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens'].map(field=>[field,{reportedSteps:1,missingSteps:0,complete:true,overflow:false}])) as MioRunUsage['coverage']['fields']}});
  const html=details(ready(single),'en');assert.match(html,/1 model request:/);assert.doesNotMatch(html,/1 model requests/);assert.match(html,/1 token</);assert.match(html,/Including 1 cache-read token \(100%\)/);assert.doesNotMatch(html,/1 cache-read tokens/);assert.match(details(ready(),'en'),/2 model requests:/);
});
test('the usage footer explicitly disclaims displayed costs in all four languages',()=>{
  const statements={'zh-Hans':'这里不显示费用','zh-Hant':'這裡不顯示費用',en:'Costs are not shown here',ja:'ここでは料金を表示しません'} as const;
  for(const locale of ['zh-Hans','zh-Hant','en','ja'] as const)assert.ok(details(ready(),locale).includes(statements[locale]),locale);
});
test('inflight-only requests are described as changing without claiming provider omission',()=>{
  const value=usageFixture({dispatchedModelSteps:1,modelOutcomes:{completed:0,failed:0,unknown:0,inflight:1},knownTotals:{inputTokens:null,outputTokens:null,cacheReadTokens:null,cacheWriteTokens:null},cacheReadRate:null,
    coverage:{fields:Object.fromEntries(['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens'].map(field=>[field,{reportedSteps:0,missingSteps:1,complete:false,overflow:false}])) as MioRunUsage['coverage']['fields']}});
  const html=details(ready(value));assert.match(html,/进行中 1/);assert.match(html,/还有请求在进行/);assert.doesNotMatch(html,/服务商没有报告|没有报告这项用量/);
});
test('partial coverage counts only finished missing requests in the provider omission explanation',()=>{
  const value=usageFixture({dispatchedModelSteps:3,modelOutcomes:{completed:2,failed:0,unknown:0,inflight:1},cacheReadRate:null,
    coverage:{fields:Object.fromEntries(['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens'].map(field=>[field,{reportedSteps:2,missingSteps:1,complete:false,overflow:false}])) as MioRunUsage['coverage']['fields']}});
  value.coverage.fields.inputTokens={reportedSteps:1,missingSteps:2,complete:false,overflow:false};
  const html=details(ready(value));assert.match(html,/有 1 次请求服务商没有报告/);assert.doesNotMatch(html,/有 2 次请求服务商没有报告/);assert.match(html,/还有请求在进行/);assert.match(html,/≥1,000/);assert.equal([...html.matchAll(/请求服务商没有报告这项用量/g)].length,1);
});

test('usage summary and real shared controls render exact complete measurements in four languages',()=>{
  assert.deepEqual(validateCatalogs(mioUsageUiMessages),[]);
  for(const locale of ['zh-Hans','zh-Hant','en','ja'] as const){
    const summary=row(ready(),locale),html=details(ready(),locale);
    assert.match(summary,/1k/);assert.match(summary,/100/);assert.match(summary,/60%/);assert.match(html,/1,000/);assert.match(html,/600/);assert.match(html,/data-field="cacheWriteTokens"/);assert.match(html,new RegExp('0 '+({'zh-Hans':'词元','zh-Hant':'詞元',en:'tokens',ja:'トークン'} as const)[locale]));
    for(const button of html.matchAll(/<button[^>]*>/gu))assert.match(button[0],/type="button"/);
    assert.doesNotMatch(html,/NaN|undefined|rawUsage|requestHash|apiKey/);
  }
});

test('explicit zero stays zero while no dispatched requests and unreported cache writes are distinct',()=>{
  const zero=usageFixture({knownTotals:{inputTokens:0,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0},cacheReadRate:null});assert.match(details(ready(zero)),/0 词元/);assert.doesNotMatch(details(ready(zero)),/服务商没有报告/);
  const empty=usageFixture({dispatchedModelSteps:0,modelOutcomes:{completed:0,failed:0,unknown:0,inflight:0},knownTotals:{inputTokens:null,outputTokens:null,cacheReadTokens:null,cacheWriteTokens:null},coverage:{fields:Object.fromEntries(['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens'].map(field=>[field,{reportedSteps:0,missingSteps:0,complete:true,overflow:false}])) as MioRunUsage['coverage']['fields']},cacheReadRate:null});
  const html=details(ready(empty));assert.match(html,/尚无已发出的模型请求/);assert.doesNotMatch(html,/服务商没有报告|0 tokens|0 词元|data-field="cacheWriteTokens"/);
  const omitted=usageFixture();omitted.knownTotals.cacheWriteTokens=null;omitted.coverage.fields.cacheWriteTokens={reportedSteps:0,missingSteps:2,complete:false,overflow:false};
  assert.match(row(ready(omitted)),/60%/);assert.doesNotMatch(details(ready(omitted)),/data-field="cacheWriteTokens"/);
});

test('field-specific missing coverage uses lower bounds and never calls independent cache data part of known input',()=>{
  const value=usageFixture({cacheReadRate:null});value.coverage.fields.inputTokens={reportedSteps:1,missingSteps:1,complete:false,overflow:false};value.knownTotals.inputTokens=100;
  const html=details(ready(value));assert.match(row(ready(value)),/≥100/);assert.match(html,/≥100 词元/);assert.match(html,/有 1 次请求/);assert.match(html,/data-field="cacheReadTokens"/);assert.match(html,/独立报告的缓存读取量/);assert.doesNotMatch(html,/其中缓存命中|60%/);
  value.coverage.fields.outputTokens={reportedSteps:0,missingSteps:2,complete:false,overflow:false};value.knownTotals.outputTokens=null;assert.match(details(ready(value)),/服务商没有报告/);
});

test('overflow takes precedence, reported zero cache writes remain visible, and outcome counts never disappear',()=>{
  const value=usageFixture({cacheReadRate:null,modelOutcomes:{completed:0,failed:0,unknown:1,inflight:1}});value.knownTotals.inputTokens=null;value.coverage.fields.inputTokens={reportedSteps:1,missingSteps:1,complete:false,overflow:true};
  value.knownTotals.cacheWriteTokens=null;value.coverage.fields.cacheWriteTokens={reportedSteps:2,missingSteps:0,complete:false,overflow:true};
  const html=details(ready(value));assert.match(html,/数值太大/);assert.match(html,/data-field="cacheWriteTokens"/);assert.match(html,/结果未知 1/);assert.match(html,/进行中 1/);assert.match(html,/数字会变/);assert.doesNotMatch(row(ready(value)),/60%/);
});

test('read failure retains stale real values and passive buttons call only their supplied read and close actions',()=>{
  const failed={...ready(),phase:'error' as const,stale:true,code:'BACKEND_UNAVAILABLE',final:false};assert.match(row(failed),/读数尚未更新/);assert.match(details(failed),/未能确认本轮用量/);assert.match(details(failed),/1,000/);
  const calls:string[]=[],props={open:true,runId,view:failed,onRetry:()=>calls.push('read'),onClose:()=>calls.push('close')},tree=ui.detailsTree(props);
  assert.ok(record(tree)&&record(tree.props));const content=tree.props.children;assert.ok(record(content)&&record(content.props));assert.equal(content.props.finalFocus,false);
  const footer=content.props.footer;assert.ok(record(footer)&&record(footer.props));const buttons=footer.props.children;assert.ok(Array.isArray(buttons));
  for(const button of buttons){assert.ok(record(button)&&record(button.props));assert.equal(button.props.type,'button');assert.equal(typeof button.props.onClick,'function');(button.props.onClick as ()=>void)();}
  assert.deepEqual(calls,['read','close']);assert.equal(ui.details({...props,open:false},'zh-Hans'),'');
});
