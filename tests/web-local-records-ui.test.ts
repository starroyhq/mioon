import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {build} from 'esbuild';
import type {LocalRecordsState} from '../apps/web/src/local-records-state.ts';
import {LOCALES,translate} from '../packages/i18n/src/index.ts';
import type {Locale} from '../packages/i18n/src/index.ts';

const root=fileURLToPath(new URL('../',import.meta.url)),fixtures=join(root,'tests/fixtures/project-file-ui');
// Reuse the existing in-place overlay/locale stand-ins. All actual rows,
// warnings, buttons and localized copy come from the production view.
const result=await build({stdin:{contents:`import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';import {LocalRecordsView} from './src/LocalRecordsPanel.tsx';import {setLocale} from ${JSON.stringify(join(fixtures,'ssr-i18n.tsx'))};export function render(state,locale){setLocale(locale);return renderToStaticMarkup(<LocalRecordsView active={state.active} state={state} controller={{refresh:async()=>{},select(){},cancel(){},confirm:async()=>{}}}/>);}`,loader:'tsx',resolveDir:join(root,'apps/web')},bundle:true,platform:'node',format:'cjs',write:false,jsx:'automatic',loader:{'.css':'empty'},define:{'process.env.NODE_ENV':'"production"'},nodePaths:[join(root,'apps/web/node_modules')],plugins:[{name:'existing-ssr-overlays',setup(build){build.onResolve({filter:/^@mioon\/ui\/components\/dialog$/},()=>({path:join(fixtures,'ssr-overlays.tsx')}));build.onResolve({filter:/\/i18n\/I18nProvider\.tsx$/},()=>({path:join(fixtures,'ssr-i18n.tsx')}));}}]});
const module={exports:{} as {render(state:LocalRecordsState,locale:Locale):string}};Function('require','module','exports',result.outputFiles[0]!.text)(createRequire(import.meta.url),module,module.exports);
const item={projectId:randomUUID(),name:'访谈 <raw>',projectFile:'/private/very-long-location/source.mioon',sizeBytes:320000000,hasSuperJournal:false,hasUnfinishedTasks:false};
const base:LocalRecordsState={active:true,loading:false,list:{version:1,appLibraryScope:'a'.repeat(64),instanceId:randomUUID(),records:[item]},readError:null,selected:null,deleting:false,notice:null};
const render=(patch:Partial<LocalRecordsState>={},locale:Locale='zh-Hans')=>module.exports.render({...base,...patch},locale);
const deleteTag=(html:string)=>html.match(/<button\b[^>]*data-variant="danger-ghost"[^>]*>/u)?.[0]??'';

test('local records render real metadata, escaped names, confirmation copy and both independent blockers in all locales',()=>{
  for(const locale of LOCALES){
    const records=[item,{...item,projectId:randomUUID(),name:null,projectFile:null,hasSuperJournal:true,hasUnfinishedTasks:true}];
    const html=render({list:{...base.list!,records}},locale);assert.ok(html.includes(translate(locale,'localRecords.title')));assert.ok(html.includes(translate(locale,'localRecords.unknownName')));assert.ok(html.includes(translate(locale,'localRecords.noLocation')));assert.ok(html.includes(translate(locale,'localRecords.journalTag')));assert.ok(html.includes(translate(locale,'localRecords.tasksTag')));assert.ok(html.includes(translate(locale,'localRecords.journalHelp')));assert.ok(html.includes(translate(locale,'localRecords.tasksHelp')));assert.ok(html.includes('访谈 &lt;raw&gt;'));assert.ok(!html.includes('<raw>'));assert.match(html,/title="\/private\/very-long-location\/source.mioon"/u);
    const confirmation=render({selected:item},locale);assert.ok(confirmation.includes(translate(locale,'localRecords.confirmTitle',{name:item.name}).replace('<raw>','&lt;raw&gt;')));assert.match(confirmation,/data-variant="danger"/u);
  }
});
test('either blocker disables deletion; both explanations survive together and unblocked rows can confirm',()=>{
  assert.doesNotMatch(deleteTag(render()),/\sdisabled=""/u);
  for(const flags of [{hasSuperJournal:true,hasUnfinishedTasks:false},{hasSuperJournal:false,hasUnfinishedTasks:true},{hasSuperJournal:true,hasUnfinishedTasks:true}]){
    const html=render({list:{...base.list!,records:[{...item,...flags}]}});assert.match(deleteTag(html),/\sdisabled=""/u);assert.equal(html.includes(translate('zh-Hans','localRecords.journalHelp')),flags.hasSuperJournal);assert.equal(html.includes(translate('zh-Hans','localRecords.tasksHelp')),flags.hasUnfinishedTasks);
  }
  assert.match(deleteTag(render({active:false})),/\sdisabled=""/u);
});
test('loading, empty, error and unknown states remain distinct without implying an absent row was deleted',()=>{
  const loading=render({loading:true,list:null});assert.ok(loading.includes('正在统计'));assert.ok(!loading.includes('没有需要清理'));
  const empty=render({list:{...base.list!,records:[]}});assert.ok(empty.includes('没有需要清理'));assert.ok(!empty.includes('已删除本机记录'));
  const failed=render({readError:'BACKEND_UNAVAILABLE',list:null});assert.ok(failed.includes('无法读取本机记录'));assert.ok(failed.includes('刷新列表'));
  const unknown=render({list:{...base.list!,records:[]},notice:{code:'TIMEOUT',outcomeUnknown:true}});assert.ok(unknown.includes('不会自动再次删除'));assert.ok(unknown.includes('也不能据此确认刚才的删除成功'));assert.ok(!unknown.includes('已删除本机记录'));
});
test('server guard and identity errors keep their specific explanations after a list refresh',()=>{
  for(const [code,key] of [['LOCAL_RECORDS_IN_USE','localRecords.inUse'],['LOCAL_RECORDS_SUPER_JOURNAL','localRecords.journalHelp'],['LOCAL_RECORDS_NOT_FOUND','localRecords.notFound'],['LOCAL_RECORDS_IDENTITY_CHANGED','localRecords.identityChanged']] as const){
    const html=render({notice:{code,outcomeUnknown:false}});assert.ok(html.includes(translate('zh-Hans',key)),code);assert.ok(!html.includes('已删除本机记录'));
  }
});
