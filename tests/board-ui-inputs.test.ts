import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {build} from 'esbuild';
import {LOCALES, translate} from '../packages/i18n/src/index.ts';
import type {Locale} from '../packages/i18n/src/index.ts';

interface Render {
  inspector(locale: Locale, variant: 'full' | 'missing'): string;
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
       status:'used',label:'阿璃',subjectVersionNumber:3,orderIndex:4}],
    referenceCount:4};
  const missing={...full,service:null,mode:'frames',usedCount:0,unsupportedCount:2,
    entries:full.entries.map(entry=>({...entry,status:'unsupported',reason:'SERVICE_NOT_SELECTED',primary:undefined})),
    primaryEdgeId:null};
  const props={board,activeFilmId:rootId,mount:null,selectedNodeId:shotId,versions:[],
    shots:[{id:shotId,title:'霓虹街头',duration:2}],busy:false,
    onSelectVersion:()=>{},onDelete:()=>{},onRestore:()=>{},providers:[],
    onInputRoleChange:()=>{},onInputDetach:()=>{},onInputPrimary:()=>{}};
  function inspector(locale,variant){
    return renderToStaticMarkup(<I18nProvider store={createLanguageStore({systemLanguages:[locale]})}>
      <BoardInspector {...props} inputs={variant==='missing'?missing:full}/></I18nProvider>);
  }
  function loading(locale){
    return renderToStaticMarkup(<I18nProvider store={createLanguageStore({systemLanguages:[locale]})}>
      <BoardInspector {...props} inputs={null}/></I18nProvider>);
  }
  export {inspector, loading};`;

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
    assert.ok(html.includes(translate(locale, 'boardUi.inputs.mode.references')), locale);
    assert.ok(html.includes(translate(locale, 'boardUi.inputs.used', {count: 3})), locale);
    assert.ok(html.includes('Seedance 2.5'), locale);
    assert.ok(html.includes(translate(locale, 'boardUi.inputs.primary')), locale);
    assert.ok(html.includes(translate(locale, 'boardUi.inputs.setPrimary')), locale);
    assert.ok(html.includes(translate(locale, 'boardUi.inputs.reason.exclusiveMode')), locale);
    assert.ok(html.includes('阿璃 · V3'), locale);
    assert.ok(html.includes(translate(locale, 'boardUi.inputs.changeRole')), locale);
    assert.ok(html.includes(translate(locale, 'boardUi.inputs.detach')), locale);
    // One row per connected input, including the unsupported audio line.
    assert.equal((html.match(/class="board-input-row/g) ?? []).length, 5);
    assert.equal((html.match(/data-status="unsupported"/g) ?? []).length, 1);
    assert.equal((html.match(/data-status="used"/g) ?? []).length, 4);
    assert.match(html, /data-mode="references"/);
    assert.match(html, /data-testid="board-input-primary-60000000-0000-4000-8000-000000000031"/);
    assert.match(html, /data-testid="board-input-role-60000000-0000-4000-8000-000000000030"/);
  }
  // User-owned names stay in their own language; the surrounding copy is
  // localized (the catalog integrity test pins the four locales).
  const english = render.inspector('en', 'full');
  for (const chinese of ['生成输入', '当前服务不支持', '主图', '用到', '未选择生成服务', '改角色', '断开']) {
    assert.equal(english.includes(chinese), false, chinese);
  }
});

test('the panel distinguishes the missing-service and loading states without explanatory prose', async () => {
  const render = await renderer();
  const missing = render.inspector('zh-Hans', 'missing');
  assert.ok(missing.includes(translate('zh-Hans', 'boardUi.inputs.serviceMissing')));
  assert.ok(missing.includes(translate('zh-Hans', 'boardUi.inputs.reason.serviceNotSelected')));
  assert.match(missing, /data-mode="frames"/);
  assert.doesNotMatch(missing, /href=|ⓘ/u);
  const loading = render.loading('zh-Hans');
  assert.ok(loading.includes(translate('zh-Hans', 'boardUi.inputs.loading')));
});
