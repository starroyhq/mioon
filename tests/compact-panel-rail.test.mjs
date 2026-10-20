import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import {createI18nTestContext} from './helpers/i18n.ts';

const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value, ...nodes(value.props?.children)] : [];
function fixture() {
  const hooks = [], effects = [], frames = [], calls = [], targets = new Map(); let cursor = 0, locale = 'zh-Hans';
  const document = {body:{}, activeElement:null, getElementById: () => panel}; document.activeElement = document.body;
  const panel = {isConnected:true, dataset:{panelScope:'p:canvas', visible:'false'}, querySelector: selector => targets.get(selector) || null};
  const react = {Fragment:'Fragment', createElement:(type, props, ...children) => ({type, props:{...props, children}}),
    useRef(value) {const index=cursor++; return hooks[index] ??= {current:value};},
    useMemo(factory, deps) {const index=cursor++, old=hooks[index]; if (!old || deps.some((value, offset) => !Object.is(value, old.deps[offset]))) hooks[index]={deps,value:factory()}; return hooks[index].value;},
    useLayoutEffect(run, deps) {const index=cursor++, old=hooks[index]; if (!old || deps.some((value, offset) => !Object.is(value, old.deps[offset]))) {hooks[index]={deps,cleanup:old?.cleanup}; effects.push(() => {hooks[index].cleanup?.(); hooks[index].cleanup=run();});}},
  }; react.default=react;
  const module={exports:{}};
  Function('require','module','exports','document','requestAnimationFrame',transformSync(readFileSync(new URL('../apps/web/src/CompactPanelRail.tsx',import.meta.url),'utf8'),{loader:'tsx',format:'cjs'}).code)(name => {
    if(name==='react')return react;
    if(name==='@mioon/ui/components/workbench-controls')return{WorkbenchButton:'WorkbenchButton'};
    if(name==='./WorkspaceControls.tsx')return{WorkbenchTooltip:'WorkbenchTooltip'};
    if(name==='./workspace-visibility.tsx')return{WorkspaceVisibilityProvider:'WorkspaceVisibilityProvider'};
    if(name==='./i18n/I18nProvider.tsx')return{useI18n:()=>createI18nTestContext(locale)};
    if(name.endsWith('.css'))return{};
    assert.fail(`Unexpected rail dependency: ${name}`);
  },module,module.exports,document,run=>frames.push(run));
  let props={name:'assets',label:'素材库',scope:'p:canvas',expanded:false,onToggle:()=>calls.push('toggle'),actions:[{id:'assets',label:'素材',icon:'assets',selected:true,onClick:()=>{calls.push('assets');panel.dataset.visible='true';},focusSelector:'[data-testid=library-assets-tab]'},{id:'subjects',label:'主体',icon:'subjects',onClick:()=>calls.push('subjects')}],bottomAction:{id:'import',label:'导入素材',icon:'import',onClick:()=>calls.push('import')}};
  let tree;
  return {calls,panel,document,targets,frames,setLocale: value=>{locale=value;},render(patch={}){props={...props,...patch};cursor=0;tree=module.exports.default(props);for(const run of effects.splice(0))run();return tree;},find(id){const node=nodes(tree).find(node=>node.props?.['data-testid']===id);assert.ok(node,id);return node;},click(id,trigger={}){document.activeElement=trigger;this.find(id).props.onClick({currentTarget:trigger});},flush(){for(const run of frames.splice(0))run();},unmount(){for(const hook of hooks)hook?.cleanup?.();}};
}

test('rail exposes real supplied destinations, stable recall IDs and labelled native button intent',()=>{
  const h=fixture(),tree=h.render();assert.deepEqual(h.calls,[]);
  assert.equal(nodes(tree).find(node=>node.type==='nav').props['aria-label'],'素材库');
  for(const id of ['reopen-assets','rail-assets-assets','rail-assets-subjects','rail-assets-import']){const button=h.find(id);assert.equal(button.props.type,'button');assert.ok(button.props['aria-label']);}
  assert.equal(h.find('reopen-assets').props['aria-controls'],'dock-assets');
  assert.equal(h.find('rail-assets-assets').props['aria-pressed'],false);
  h.render({expanded:true});assert.equal(h.find('rail-assets-assets').props['aria-pressed'],true);
  h.click('rail-assets-subjects');h.click('rail-assets-import');assert.deepEqual(h.calls,['subjects','import']);
  assert.equal(h.frames.length,0,'Import and actions without focus destinations do not schedule focus changes');
  h.render({actions:[]});assert.equal(nodes(h.render()).some(node=>node.props?.['data-testid']==='rail-assets-subjects'),false);
});

test('disabled, removed, hidden and superseded rail actions cannot invoke retained callbacks',()=>{
  const h=fixture();h.render();const first=h.find('rail-assets-assets'),toggle=h.find('reopen-assets');
  h.render({disabled:true});first.props.onClick({currentTarget:{}});toggle.props.onClick({currentTarget:{}});assert.deepEqual(h.calls,[]);
  h.render({disabled:false,actions:[{id:'assets',label:'素材',icon:'assets',disabled:true,onClick:()=>h.calls.push('forbidden')}]});first.props.onClick({currentTarget:{}});assert.deepEqual(h.calls,[]);
  h.render({visible:false});first.props.onClick({currentTarget:{}});assert.equal(h.find('reopen-assets').props.disabled,true);
  h.render({visible:true,actions:[]});first.props.onClick({currentTarget:{}});assert.deepEqual(h.calls,[]);
  h.render({scope:'other:editing'});toggle.props.onClick({currentTarget:{}});assert.deepEqual(h.calls,[]);
  const current=h.find('reopen-assets');h.unmount();current.props.onClick({currentTarget:{}});assert.deepEqual(h.calls,[]);
});

test('revealing a pane transfers focus only to its current visible owner and preserves newer focus',()=>{
  for(const reason of ['accepted','new-focus','changed-panel','hidden','changed-scope']){
    const h=fixture(),target={focuses:0,focus(){this.focuses++;}};h.targets.set('[data-testid=library-assets-tab]',target);h.render();h.click('rail-assets-assets');
    if(reason==='new-focus')h.document.activeElement={};
    if(reason==='changed-panel')h.panel.dataset.panelScope='other:canvas';
    if(reason==='hidden')h.panel.dataset.visible='false';
    if(reason==='changed-scope')h.render({scope:'other:canvas'});
    h.flush();assert.equal(target.focuses,reason==='accepted'?1:0,reason);
  }
});

test('rail recall prefers the visible overlay pin control and locale changes keep IDs and command identity',()=>{
  const h=fixture(),pin={focuses:0,focus(){this.focuses++;}};h.targets.set('[data-testid=pin-assets]',pin);
  for(const locale of ['zh-Hans','zh-Hant','en','ja']){h.setLocale(locale);h.render({onToggle:()=>{h.calls.push('toggle');h.panel.dataset.visible='true';}});assert.ok(h.find('reopen-assets').props['aria-label']);}
  h.click('reopen-assets');h.flush();assert.equal(pin.focuses,1);assert.deepEqual(h.calls,['toggle']);
  const css=readFileSync(new URL('../apps/web/src/compact-panel-rail.css',import.meta.url),'utf8');
  assert.match(css,/width: var\(--wb-panel-rail\)/);assert.match(css,/\.compact-panel-rail-bottom \{ margin-top: auto/);
  assert.doesNotMatch(css,/\.timeline|^body|^button/m,'The rail must not change timeline or global layout');
});
