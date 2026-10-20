import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import {i18nTestModule} from './helpers/i18n.ts';
const nodes=value=>Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'?[value,...nodes(value.props?.children)]:[];
function fixture(){
  const slots=[],calls=[];let cursor=0,visible=true;
  const react={createElement:(type,props,...children)=>({type,props:{...props,children}}),useState(initial){const index=cursor++;if(!(index in slots))slots[index]=initial;return[slots[index],value=>{slots[index]=typeof value==='function'?value(slots[index]):value;}];}};react.default=react;
  const module={exports:{}};
  Function('require','module','exports',transformSync(readFileSync(new URL('../apps/web/src/AssetLibrary.tsx',import.meta.url),'utf8'),{loader:'tsx',format:'cjs'}).code)(name=>{
    if(name==='react')return react;if(name.endsWith('I18nProvider.tsx'))return i18nTestModule();if(name.endsWith('.css'))return{};
    if(name==='./AssetDispositionControls.tsx')return{default:'AssetDispositionControls',useDispositionInteraction:()=>({visible,admit:action=>{if(visible)action();}})};
    if(name==='./asset-disposition-state.ts')return{dispositionCounts:()=>({}),dispositionFilters:[],filterLibraryAssets:assets=>assets};
    if(name==='./asset-annotation-state.ts')return{annotationTags:()=>[],annotationMatches:()=>true,annotationRow:()=>null};
    if(name==='./AssetTimelineUsage.tsx')return{default:'AssetTimelineUsage',AssetTimelineUsageFilters:'AssetTimelineUsageFilters',useAssetTimelineUsageFilter:()=>({visibleAssets:[],filter:'all',reset(){}})};
    if(name==='./AssetLibraryToolbar.tsx')return{default:'AssetLibraryToolbar',useAssetLibraryLayout:()=>({layout:'grid',setLayout(){}})};
    if(name==='./SubjectLibrary.tsx')return{default:'SubjectLibrary'};
    return new Proxy({},{get:(_,key)=>String(key)});
  },module,module.exports);
  let props={assets:[],filter:'all',search:'',busy:{},collapsed:false,onCollapse(){},onFilter(){},onSearch(){},onPreview(){},project:{id:'project-a'},subjects:{state:null,controller:{}}},tree;
  return{calls,setVisible(value){visible=value;},render(patch={}){props={...props,...patch};cursor=0;tree=module.exports.default(props);return tree;},find(id){const node=nodes(tree).find(node=>node.props?.['data-testid']===id);assert.ok(node,id);return node;}};
}
test('uncontrolled library keeps existing tab state and resets it for a different project',()=>{
  const h=fixture();h.render();assert.equal(h.find('library-assets-tab').props['aria-selected'],true);
  h.find('library-subjects-tab').props.onClick();h.render();assert.equal(h.find('library-subjects-tab').props['aria-selected'],true);
  h.render({project:{id:'project-b'}});assert.equal(h.find('library-assets-tab').props['aria-selected'],true);
});
test('controlled library delegates tab intent and waits for the parent to accept it',()=>{
  const h=fixture();h.render({activeTab:'assets',onTabChange:value=>h.calls.push(value)});
  h.find('library-subjects-tab').props.onClick();h.render();assert.deepEqual(h.calls,['subjects']);assert.equal(h.find('library-assets-tab').props['aria-selected'],true);
  h.render({activeTab:'subjects'});assert.equal(h.find('library-subjects-tab').props['aria-selected'],true);
  h.find('library-assets-tab').props.onClick();assert.deepEqual(h.calls,['subjects','assets']);
});
test('hidden tab callbacks retain the existing interaction fence and unavailable subjects never become the view',()=>{
  const h=fixture();h.render({activeTab:'assets',onTabChange:value=>h.calls.push(value)});const retained=h.find('library-subjects-tab');
  h.setVisible(false);retained.props.onClick();assert.deepEqual(h.calls,[]);
  const tree=h.render({activeTab:'subjects',subjects:undefined});assert.equal(nodes(tree).find(node=>node.props?.id==='library-assets-pane').props.hidden,false);
  assert.equal(nodes(tree).some(node=>node.props?.['data-testid']==='library-subjects-tab'),false);
});
