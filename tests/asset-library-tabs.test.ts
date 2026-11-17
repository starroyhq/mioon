import type {ElementModule} from './helpers/strict-timeline-audio-harness-types.ts';
import type {ElementTree, ElementNode} from './helpers/strict-timeline-audio-harness-types.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import {i18nTestModule} from './helpers/i18n.ts';
import {LOCALES, translate} from '../packages/i18n/src/index.ts';
const nodes=(value: ElementTree): ElementNode[]=>Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'?[value,...nodes(value.props?.children)]:[];
function fixture(locale: (typeof LOCALES)[number] = 'zh-Hans'){
  const slots: unknown[]=[],calls: unknown[]=[];let cursor=0,visible=true;
  let mediaGate: unknown = null;
  const react={createElement:(type: unknown,props: Record<string, unknown> | null,...children: ElementTree[])=>({type,props:{...props,children}}),useState(initial: unknown){const index=cursor++;if(!(index in slots))slots[index]=initial;return[slots[index],(value: (arg0: unknown) => unknown)=>{slots[index]=typeof value==='function'?value(slots[index]):value;}];}};(react as typeof react & {default: unknown}).default=react;
  const module=({exports:{}} as ElementModule);
  Function('require','module','exports',transformSync(readFileSync(new URL('../apps/web/src/AssetLibrary.tsx',import.meta.url),'utf8'),{loader:'tsx',format:'cjs'}).code)((name: string)=>{
    if (name === './project-media-read-gate.tsx') return {useProjectMediaReadGate: () => mediaGate, ProjectMediaImage: 'img'}; if (name === './project-file/MediaStatus.tsx') return {MediaStatusBadge: 'MediaStatusBadge', MediaStatusNote: 'MediaStatusNote', MediaAttentionBanner: 'MediaAttentionBanner'}; if(name==='react')return react;if(name.endsWith('I18nProvider.tsx'))return i18nTestModule(locale);if(name.endsWith('.css'))return{};
    if(name==='./AssetDispositionControls.tsx')return{default:'AssetDispositionControls',useDispositionInteraction:()=>({visible,admit:(action: () => void)=>{if(visible)action();}})};
    if(name==='./asset-disposition-state.ts')return{dispositionCounts:()=>({}),dispositionFilters:[],filterLibraryAssets:(assets: unknown)=>assets};
    if(name==='./asset-annotation-state.ts')return{annotationTags:()=>[],annotationMatches:()=>true,annotationRow:()=>null};
    if(name==='./AssetTimelineUsage.tsx')return{default:'AssetTimelineUsage',AssetTimelineUsageFilters:'AssetTimelineUsageFilters',useAssetTimelineUsageFilter:()=>({visibleAssets:[],filter:'all',reset(){}})};
    if(name==='./AssetLibraryToolbar.tsx')return{default:'AssetLibraryToolbar',useAssetLibraryLayout:()=>({layout:'grid',setLayout(){}})};
    if(name==='./SubjectLibrary.tsx')return{default:'SubjectLibrary'};
    return new Proxy({},{get:(_,key)=>String(key)});
  },module,module.exports);
  let props={assets:[],filter:'all',search:'',busy:{},collapsed:false,onCollapse(){},onFilter(){},onSearch(){},onPreview(){},project:{id:'project-a'},subjects:{state:null,controller:{}}},tree: ElementTree;
  return {calls, setVisible(value: boolean){visible=value;}, setMediaGate(value: unknown){mediaGate=value;},
    render(patch={}){props={...props,...patch};cursor=0;tree=module.exports.default(props);return tree;},
    tabs(){const tabs=nodes(tree).find(node=>node.props.className==='panel-header-tabs');assert.ok(tabs);return tabs.props;}
  };
}
test('uncontrolled library keeps existing tab state and resets it for a different project',()=>{
  const h=fixture();h.render();assert.equal(h.tabs().value,'assets');
  h.tabs().onValueChange('subjects');h.render();assert.equal(h.tabs().value,'subjects');
  h.render({project:{id:'project-b'}});assert.equal(h.tabs().value,'assets');
});
test('controlled library delegates tab intent and waits for the parent to accept it',()=>{
  const h=fixture();h.render({activeTab:'assets',onTabChange:(value: unknown)=>h.calls.push(value)});
  h.tabs().onValueChange('subjects');h.render();assert.deepEqual(h.calls,['subjects']);assert.equal(h.tabs().value,'assets');
  h.render({activeTab:'subjects'});assert.equal(h.tabs().value,'subjects');
  h.tabs().onValueChange('assets');h.tabs().onValueChange('all');assert.deepEqual(h.calls,['subjects','assets']);
});
test('hidden tab callbacks retain the existing interaction fence and unavailable subjects never become the view',()=>{
  const h=fixture();h.render({activeTab:'assets',onTabChange:(value: unknown)=>h.calls.push(value)});const {onValueChange}=h.tabs();
  h.setVisible(false);onValueChange('subjects');assert.deepEqual(h.calls,[]);
  const tree=h.render({activeTab:'subjects',subjects:undefined});const fallback=nodes(tree).find(node=>node.props.id==='library-assets-pane');
  assert.ok(fallback);assert.equal(fallback.props.hidden,false);assert.equal(fallback.props.role,undefined);assert.equal(fallback.props['aria-labelledby'],undefined);
  assert.equal(nodes(tree).some(node=>node.props['data-testid']==='library-subjects-tab'),false);
  assert.ok(nodes(tree).some(node=>node.props.className==='asset-panel-heading'));
});

test('the shared heading precedes the retained, individually labelled asset and subject panes',()=>{
  const h=fixture(),tree=h.render({activeTab:'subjects'}) as ElementNode;
  const siblings=nodes(tree.props.children).filter(node=>node.type==='WorkbenchPanelHeader'||node.type==='CollapsibleContent');
  assert.deepEqual(siblings.map(node=>node.type),['WorkbenchPanelHeader','CollapsibleContent']);
  const [header,content]=siblings;
  assert.equal(header!.props.collapseTestId,'toggle-assets');assert.equal(content!.props.keepMounted,true);
  assert.ok(nodes(header!.props.children).some(node=>node.type==='WorkbenchPanelTabList'&&node.props['aria-label']));
  for(const view of ['assets','subjects']){
    const tab=nodes(header!.props.children).find(node=>node.props['data-testid']===`library-${view}-tab`);
    const pane=nodes(content!.props.children).find(node=>node.props.id===`library-${view}-pane`);
    assert.ok(tab);assert.ok(pane);
    assert.equal(tab.props.id,`library-${view}-tab`);assert.equal(tab.props['aria-controls'],pane.props.id);
    assert.equal(pane.props.role,'tabpanel');assert.equal(pane.props['aria-labelledby'],tab.props.id);
    assert.equal(pane.props.hidden,view==='assets');assert.equal(pane.props.inert,view==='assets');
  }
});

test('both library modes wait for the first media banner and count only verified unavailable assets', () => {
  const assets = ['known', 'new'].map(id => ({id, projectId: 'project-a', referenceRevision: 1}));
  for (const mode of ['canvas', 'editing']) {
    const h = fixture();
    const banner = (status: unknown, statusCheckDelayed: boolean) => {
      h.setMediaGate({state: {owner: {projectId: 'project-a'}, status, statusCheckDelayed}});
      return nodes(h.render({assets, mode})).find(node => node.type === 'MediaAttentionBanner');
    };
    assert.equal(banner({kind: 'loading'}, false), undefined);
    assert.deepEqual(banner({kind: 'loading'}, true)?.props.state, {kind: 'loading'});
    assert.equal(banner({kind: 'ready', value: {known: {referenceRevision: 1, status: 'online', readable: true}}}, false), undefined);
    assert.deepEqual(banner({kind: 'ready', value: {known: {referenceRevision: 1, status: 'missing', readable: false}}}, false)?.props.state,
      {kind: 'ready', value: 1});
  }
});

test('empty and filtered libraries show one line and keep import available in every locale', () => {
  for (const locale of LOCALES) {
    const library = fixture(locale);
    for (const mode of ['canvas', 'editing'] as const) for (const [filter, key] of [['all', 'assets.emptyTitle'], ['image', 'assets.noMatches']] as const) {
      const onImport = () => {};
      const tree = nodes(library.render({mode, filter, onImport}));
      const empty = tree.find(node => node.props.className === 'asset-empty');
      assert.ok(empty);
      const children = nodes(empty.props.children);
      const heading = children.find(node => node.type === 'h4');
      assert.deepEqual(heading?.props.children, [translate(locale, key)]);
      assert.ok(children.every(node => node.type !== 'p' && node.type !== 'span'));
      assert.ok(tree.every(node => node.props.className !== 'asset-bottom' && node.props.className !== 'asset-drag-help'));
      const button = tree.find(node => node.props['data-testid'] === 'import-button');
      assert.equal(button?.props.disabled, false);
      assert.equal(button?.props.title, undefined);
      assert.equal(button?.props.onClick, onImport);
    }
  }
});
