import test from 'node:test';
import assert from 'node:assert/strict';
import {AGENT_TASK_CHECK_GROUPS,AGENT_TASK_CHECK_TYPES,AGENT_TASK_CHECK_STATUSES,AGENT_TASK_CHECK_REASONS} from '../packages/contracts/src/agent-task-checks-v2.ts';
import {LOCALES,catalogs,translate,validateCatalogs,message,renderMessage} from '../packages/i18n/src/index.ts';
import {mioCheckMessages} from '../packages/i18n/src/catalogs/mio-checks.ts';

test('completion wording covers every current group, type, status and reason in all four languages',()=>{
 assert.deepEqual(validateCatalogs(mioCheckMessages),[]);
 for(const group of AGENT_TASK_CHECK_GROUPS)for(const locale of LOCALES)assert.ok(translate(locale,`agent.checks.group.${group}`).trim());
 for(const type of AGENT_TASK_CHECK_TYPES)for(const locale of LOCALES)assert.ok(translate(locale,`agent.checks.type.${type}`).trim());
 for(const status of AGENT_TASK_CHECK_STATUSES)for(const locale of LOCALES)assert.ok(translate(locale,`agent.checks.status.${status}`).trim());
 for(const reason of AGENT_TASK_CHECK_REASONS)for(const locale of LOCALES)assert.ok(translate(locale,`agent.checks.reason.${reason}`).trim());
 for(const [key,entry] of Object.entries(mioCheckMessages)){
  assert.ok(key.startsWith('agent.checks.'));assert.equal(catalogs[key as keyof typeof mioCheckMessages],entry);
  for(const locale of LOCALES)assert.doesNotMatch(JSON.stringify(entry[locale]),/任务|任務|\btasks?\b|タスク|智能助理|智慧助理|アシスタント|エージェント/iu,`${key}/${locale}`);
  assert.doesNotMatch(JSON.stringify(entry.en),/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u,key);
 }
});

test('completion counts and English singular/plural forms retain their original numeric inputs',()=>{
 for(const count of [0,1,2]){
  const noun=count===1?'check':'checks';
  assert.equal(translate('en','agent.checks.titleCount',{count}),`Completion ${count} ${noun}`);
  assert.equal(translate('en','agent.checks.summary.failed',{count}),`${count} ${noun} failed`);
  assert.equal(translate('en','agent.checks.summary.pending',{count}),`${count} ${noun} pending`);
  assert.equal(translate('en','agent.checks.metadata.clips',{count}),`${count} ${count===1?'clip':'clips'}`);
  assert.equal(translate('en','agent.checks.reason.PREFLIGHT_BLOCKED.count',{count}),`${count} blocking ${count===1?'issue':'issues'}`);
  assert.equal(translate('en','agent.checks.reason.REFERENCES_UNAVAILABLE.count',{count}),`${count} referenced ${count===1?'source is':'sources are'} unavailable`);
  for(const locale of LOCALES){
   for(const key of ['agent.checks.titleCount','agent.checks.summary.failed','agent.checks.summary.pending','agent.checks.metadata.clips','agent.checks.reason.PREFLIGHT_BLOCKED.count','agent.checks.reason.REFERENCES_UNAVAILABLE.count'] as const)assert.ok(translate(locale,key,{count}).includes(String(count)));
  }
 }
 assert.equal(translate('zh-Hans','agent.checks.summary.allPassed'),'全部通过');
 assert.equal(translate('en','agent.checks.summary.allPassed'),'All passed');
});

test('completion title and summary leave their separating dot to the component in all four languages',()=>{
 for(const count of [1,5]){
  const expected=[`完成情况 ${count} 项`,`完成情況 ${count} 項`,`Completion ${count} ${count===1?'check':'checks'}`,`完了状況 ${count} 件`];
  assert.deepEqual(LOCALES.map(locale=>translate(locale,'agent.checks.titleCount',{count})),expected);
  for(const locale of LOCALES){
   assert.doesNotMatch(translate(locale,'agent.checks.titleCount',{count}),/·/u);
   assert.doesNotMatch(translate(locale,'agent.checks.summary.allPassed'),/·/u);
   assert.doesNotMatch(translate(locale,'agent.checks.summary.failed',{count}),/·/u);
   assert.doesNotMatch(translate(locale,'agent.checks.summary.pending',{count}),/·/u);
  }
 }
});

test('safe resolution, count and progress details render without fabricated provider or file facts',()=>{
 const resolution={expectedWidth:1080,expectedHeight:1920,currentWidth:720,currentHeight:1280};
 assert.equal(translate('en','agent.checks.reason.PARAMETERS_MISMATCH.resolution',resolution),'Expected 1080×1920; actual 720×1280');
 for(const locale of LOCALES){
  const detail=translate(locale,'agent.checks.reason.PARAMETERS_MISMATCH.resolution',resolution);assert.ok(detail.includes('1080×1920'));assert.ok(detail.includes('720×1280'));
  assert.ok(translate(locale,'agent.checks.generationProgress',{progress:62}).includes('62%'));
  assert.ok(translate(locale,'agent.checks.progress',{progress:0}).includes('0%'));
  assert.equal(translate(locale,'agent.checks.metadata.resolution',{width:1920,height:1080}),'1920×1080');
  assert.equal(translate(locale,'agent.checks.metadata.fps',{fps:30}),'30 fps');
  assert.doesNotMatch(translate(locale,'agent.checks.reason.ARTIFACT_UNAVAILABLE'),/已(?:被)?(?:移动|移動|删除|刪除)|was (?:moved|deleted)|削除されました/u);
 }
 assert.equal(translate('zh-Hans','agent.checks.generationProgress',{progress:62}),'生成中 62%');
});

test('completion actions, loading, errors and preflight work have localized accessible copy',()=>{
 for(const locale of LOCALES){
  const name='Mio · 04';assert.ok(translate(locale,'agent.checks.locate',{name}).includes(name));
  for(const key of ['agent.checks.justChecked','agent.checks.recheck','agent.checks.recheckTooltip','agent.checks.expand','agent.checks.collapse','agent.checks.loading','agent.checks.readFailed','agent.checks.empty','agent.checks.preflightRunning'] as const)assert.ok(translate(locale,key).trim());
  assert.equal(renderMessage(locale,message('agent.checks.locate',{name})),translate(locale,'agent.checks.locate',{name}));
  assert.equal(renderMessage(locale,message('agent.checks.summary.failed',{count:2})),translate(locale,'agent.checks.summary.failed',{count:2}));
 }
});
