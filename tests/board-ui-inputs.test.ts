import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {build} from 'esbuild';
import {LOCALES, translate} from '../packages/i18n/src/index.ts';
import type {Locale} from '../packages/i18n/src/index.ts';

interface Render {
  inspector(locale: Locale, variant: 'full' | 'missing' | 'empty'): string;
  textOnly(locale: Locale): string;
  loading(locale: Locale): string;
}
const root = fileURLToPath(new URL('../', import.meta.url));
let loaded: Promise<Render> | undefined;
const entry = `import React from 'react';
  import {renderToStaticMarkup} from 'react-dom/server';
  import {I18nProvider,createLanguageStore} from './src/i18n/I18nProvider.tsx';
  import BoardInspector from './src/board-ui/BoardInspector.tsx';
  import {projectLiveBoard} from './src/board-ui/live.ts';
  const shotId='60000000-0000-4000-8000-000000000010', rootId='60000000-0000-4000-8000-000000000001';
  const imageA='60000000-0000-4000-8000-000000000020', edgeA='60000000-0000-4000-8000-000000000030';
  const board=projectLiveBoard({
    shots:[{id:shotId,title:'霓虹街头',position:{x:0,y:0},aspectRatio:'9:16',duration:2}],
    nodes:[{id:rootId,type:'sequence_root',name:'成片',position:{x:-300,y:0}},
      {id:imageA,type:'image',label:'参考图 · 街景',position:{x:0,y:300}}],
    edges:[{id:'60000000-0000-4000-8000-000000000040',kind:'sequence',source:rootId,target:shotId},
      {id:edgeA,kind:'reference',role:'reference_image',source:imageA,target:shotId}],
    versions:[],assets:[],jobs:[],clips:[]});
  const full={projectId:'60000000-0000-4000-8000-000000000001',shotId,shotRevision:1,mode:'references',
    service:{providerId:'ark',modelId:'doubao-seedance-2-5-260628',modelName:'Seedance 2.5',profileId:'p',profileVersion:'v'},
    usedCount:3,unsupportedCount:1,primaryEdgeId:edgeA,
    entries:[
      {source:'edge',edgeId:edgeA,sourceNodeId:imageA,sourceKind:'image',role:'reference_image',appliedRole:'reference_image',
       status:'used',label:'参考图 · 街景',orderIndex:0,primary:true},
      {source:'edge',edgeId:'60000000-0000-4000-8000-000000000031',sourceKind:'image',role:'reference_image',appliedRole:'reference_image',
       status:'used',label:'参考图 B',orderIndex:1},
      {source:'edge',edgeId:'60000000-0000-4000-8000-000000000032',sourceKind:'image',role:'composition',appliedRole:'reference_image',
       status:'used',label:'预演 C',orderIndex:2},
      {source:'edge',edgeId:'60000000-0000-4000-8000-000000000033',sourceKind:'audio',role:'reference_audio',
       status:'unsupported',reason:'EXCLUSIVE_MODE',label:'对白.wav',orderIndex:3},
      {source:'subject',bindingId:'60000000-0000-4000-8000-000000000034',sourceKind:'subject',role:'subject_reference',
       status:'used',label:'阿璃',subjectVersionNumber:3,orderIndex:4},
      {source:'previs',sourceNodeId:'60000000-0000-4000-8000-000000000035',sourceKind:'subject',role:'subject_reference',
       status:'used',label:'街口 · 阿璃',subjectVersionNumber:3,orderIndex:5}],
    referenceCount:4};
  const missing={...full,service:null,mode:'frames',usedCount:0,unsupportedCount:2,
    entries:full.entries.map(entry=>({...entry,status:'unsupported',reason:'SERVICE_NOT_SELECTED',primary:undefined})),
    primaryEdgeId:null};
  const empty={...full,usedCount:0,unsupportedCount:0,primaryEdgeId:null,entries:[]};
  const provider={id:'kling',connectionId:'60000000-0000-4000-8000-000000000099',configurationRevision:1,
    name:'Kling',status:'available',enabled:true,configured:true,mock:false,
    models:[{id:'kling-3.0',modelId:'kling-3.0',modelEntryId:'60000000-0000-4000-8000-000000000098',
      name:'kling-3.0',inputModes:['text','image','reference'],aspectRatios:['9:16'],durations:[5]}]};
  const base={board,activeFilmId:rootId,mount:null,selectedNodeId:shotId,versions:[],
    shots:[{id:shotId,title:'霓虹街头',duration:2}],busy:false,
    onSelectVersion:()=>{},onDelete:()=>{},onRestore:()=>{},onSetBindingMode:()=>{},onDetachBinding:()=>{},
    onRestoreBinding:()=>{},onDeleteSubjectCard:()=>{},providers:[provider],
    generationOptions:{connectionId:provider.connectionId,configurationRevision:1,
      modelEntryId:'60000000-0000-4000-8000-000000000098',model:'kling-3.0'},
    onInputRoleChange:()=>{},onInputDetach:()=>{},onInputPrimary:()=>{}};
  function inspector(locale,variant){
    return renderToStaticMarkup(<I18nProvider store={createLanguageStore({systemLanguages:[locale]})}>
      <BoardInspector {...base} inputs={variant==='missing'?missing:variant==='empty'?empty:full}/></I18nProvider>);
  }
  function textOnly(locale){
    const zero={...full,mode:'text',usedCount:0,unsupportedCount:0,primaryEdgeId:null,
      entries:full.entries.map(entry=>({...entry,status:'unsupported',reason:'EXCLUSIVE_MODE',primary:undefined})),
      service:{...full.service,modelId:'doubao-seedance-2-5-260628'}};
    return renderToStaticMarkup(<I18nProvider store={createLanguageStore({systemLanguages:[locale]})}>
      <BoardInspector {...base} inputs={zero}/></I18nProvider>);
  }
  function loading(locale){
    return renderToStaticMarkup(<I18nProvider store={createLanguageStore({systemLanguages:[locale]})}>
      <BoardInspector {...base} inputs={null}/></I18nProvider>);
  }
  export {inspector, textOnly, loading};`;

function renderer(): Promise<Render> {
  return loaded ??= (async () => {
    const result = await build({stdin: {contents: entry, loader: 'tsx', resolveDir: path.join(root, 'apps/web')},
      bundle: true, format: 'cjs', platform: 'node', write: false, jsx: 'automatic',
      loader: {'.css': 'empty'}, define: {'process.env.NODE_ENV': '"production"'}});
    const module = {exports: {}};
    Function('require', 'module', 'exports', result.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
    return module.exports as Render;
  })();
}

test('the property panel shows the resolved mode, used inputs, primary image and unsupported reason', async () => {
  const render = await renderer();
  for (const locale of LOCALES) {
    const html = render.inspector(locale, 'full');
    assert.ok(html.includes(translate(locale, 'boardUi.inputs.title')), locale);
    assert.ok(html.includes(translate(locale, 'boardUi.inspector.shotHeading', {number: '01', title: '霓虹街头'})), locale);
    assert.match(html, /class="board-shot-heading"/);
    assert.match(html, /class="board-shot-duration-row"/);
    assert.ok(html.includes(translate(locale, 'boardUi.inputs.mode.references')), locale);
    assert.ok(html.includes(translate(locale, 'boardUi.inputs.used', {count: 3})), locale);
    assert.match(html, /data-service="selected"/);
    assert.ok(html.includes('Kling'), locale);
    assert.equal(html.includes('doubao-seedance-2-5-260628'), false);
    assert.ok(html.includes(translate(locale, 'boardUi.inputs.primary')), locale);
    assert.ok(html.includes(translate(locale, 'boardUi.inputs.reason.exclusiveMode')), locale);
    assert.ok(html.includes('阿璃 · V3'), locale);
    // 21-10b: a row is one menu trigger; role/primary/detach actions are not
    // rendered until the row is opened.
    assert.equal(html.includes(translate(locale, 'boardUi.inputs.setPrimary')), false, locale);
    assert.equal(html.includes(translate(locale, 'boardUi.inputs.changeRole')), false, locale);
    assert.equal(html.includes(translate(locale, 'boardUi.inputs.detach')), false, locale);
    assert.match(html, /class="board-input-button"/);
    assert.doesNotMatch(html, /board-input-menu-/);
    // One row per connected input, including the unsupported audio line.
    assert.equal((html.match(/class="board-input-row/g) ?? []).length, 6);
    assert.equal((html.match(/data-status="unsupported"/g) ?? []).length, 1);
    assert.equal((html.match(/data-status="used"/g) ?? []).length, 5);
    // G's previs scene subject is evidence only: no menu or action controls.
    const previsIndex = html.indexOf('data-testid="board-input-previs-subject_reference-5"');
    assert.ok(previsIndex >= 0, locale);
    const previsRow = html.slice(previsIndex, previsIndex + 500);
    assert.match(previsRow, /board-input-button is-static/);
    assert.doesNotMatch(previsRow, /board-input-menu-|board-input-primary-|board-input-detach-/);
    assert.ok(html.includes('街口 · 阿璃 · V3'), locale);
    assert.match(html, /data-mode="references"/);
    assert.doesNotMatch(html, /data-testid="board-input-primary-60000000-0000-4000-8000-000000000031"/);
    assert.doesNotMatch(html, /data-testid="board-input-role-60000000-0000-4000-8000-000000000030"/);
  }
  // User-owned names stay in their own language; the surrounding copy is
  // localized (the catalog integrity test pins the four locales).
  const english = render.inspector('en', 'full');
  for (const chinese of ['生成输入', '当前服务不支持', '主图', '用到', '未选择生成服务', '改角色', '断开']) {
    assert.equal(english.includes(chinese), false, chinese);
  }
});

test('no service selected shows only the footer state: no dimming and no per-line reason', async () => {
  const render = await renderer();
  const missing = render.inspector('zh-Hans', 'missing');
  assert.ok(missing.includes(translate('zh-Hans', 'boardUi.inputs.serviceMissing')));
  // The projection still marks every entry unsupported, but with no service the
  // panel must not dim rows or repeat a reason on each line.
  assert.doesNotMatch(missing, /board-input-row is-unsupported/u);
  assert.doesNotMatch(missing, /board-input-unsupported-/u);
  // The footer's missing-service text and the per-line reason have the same
  // copy, so assert on the absence of the reason span instead of the string.
  assert.equal((missing.match(/未选择生成服务/gu) ?? []).length, 1);
  assert.ok(missing.includes(translate('zh-Hans', 'boardUi.inputs.mode.references')) === false);
  assert.match(missing, /data-service="missing"/);
  assert.doesNotMatch(missing, /href=|ⓘ/u);
  const loading = render.loading('zh-Hans');
  assert.ok(loading.includes(translate('zh-Hans', 'boardUi.inputs.loading')));
  const english = render.inspector('en', 'missing');
  assert.equal(english.includes('生成输入'), false);
});

test('the panel uses the confirmed copy: 未连接参考, 文生视频 and no count when nothing is used', async () => {
  const render = await renderer();
  const empty = render.inspector('zh-Hans', 'empty');
  assert.ok(empty.includes('未连接参考'));
  const text = render.textOnly('zh-Hans');
  assert.ok(text.includes('文生视频'));
  assert.ok(text.includes('Kling · 文生视频'));
  assert.equal(text.includes('用到'), false);
  const emptyEnglish = render.inspector('en', 'empty');
  assert.ok(emptyEnglish.includes('No reference connected'));
});
