import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

interface Element {type: unknown; props: Record<string, unknown> & {children?: unknown}}
const root=fileURLToPath(new URL('../',import.meta.url));
const bundle=await build({stdin:{contents:`import ProjectEntry from './src/ProjectEntry.tsx';import Home from './src/ProjectHomeDirectoryScreen.tsx';export {Home};export const render=props=>ProjectEntry(props);`,resolveDir:root+'apps/web',loader:'tsx'},bundle:true,platform:'node',format:'cjs',write:false,jsx:'automatic',loader:{'.css':'empty'},define:{'process.env.NODE_ENV':'"production"'},nodePaths:[root+'apps/web/node_modules'],plugins:[{name:'entry-native-bindings',setup(builder){
 builder.onResolve({filter:/\/ProjectHomeDirectoryScreen\.tsx$/},()=>({path:'home',namespace:'entry-capture'}));
 builder.onLoad({filter:/.*/,namespace:'entry-capture'},()=>({contents:'export default function Home(){return null}',loader:'js'}));
 builder.onResolve({filter:/\/i18n\/I18nProvider\.tsx$/},()=>({path:root+'tests/fixtures/project-file-ui/ssr-i18n.tsx'}));
}}]});
const target={exports:{}};
Function('require','module','exports',bundle.outputFiles[0]!.text)(createRequire(import.meta.url),target,target.exports);
const ui=target.exports as {Home:unknown;render(props:unknown):Element};
function nodes(value:unknown):Element[]{
 if(Array.isArray(value))return value.flatMap(nodes);
 if(!value||typeof value!=='object'||!('props'in value))return[];
 const node=value as Element;return[node,...nodes(node.props.children)];
}
const id='77000000-0000-4000-8000-000000000001',other='77000000-0000-4000-8000-000000000002';
function home(role:'editor'|'launcher'){
 const copies:string[]=[],rechecks:number[]=[],permit=()=>true,desktop={getState:()=>({capabilities:{ready:true,duplicate:true},busy:false,blocked:false}),readCloseSnapshot:()=>({unknown:false}),duplicate:(projectId:string)=>{copies.push(projectId);},bridge:{}};
 const controller={getState:()=>({shown:true,catalogReady:true,phase:'home',projects:[],mode:'open',creating:false,sealed:false,createUnknown:false,openUnknown:false,formIntent:0}),getContext:()=>({role,editorProjectId:role==='editor'?id:null,quitting:false}),identity:null,desktop,prepareHomeNativeRecheck:async(version:number)=>{rechecks.push(version);return permit;}};
 const entry=nodes(ui.render({controller,editor:role==='editor',onSettings(){}})).find(node=>node.type===ui.Home);assert.ok(entry);
 return {props:entry.props,copies,rechecks,permit};
}

test('production entry passes the current editor ID to cards',()=>{
 const editor=home('editor');assert.deepEqual(editor.props.openedProjectIds,[id]);
 assert.deepEqual(home('launcher').props.openedProjectIds,[]);
});

test('production entry omits duplicate actions the host cannot execute',()=>{
 const editor=home('editor');
 assert.equal(editor.props.onCopy,undefined,'An editor cannot duplicate another project, and its own source is already open');
 const launcher=home('launcher');
 assert.equal(typeof launcher.props.onCopy,'function');(launcher.props.onCopy as (id:string)=>void)(other);assert.deepEqual(launcher.copies,[other]);
});

test('production entry carries the exact home unknown version to its renewed-consent owner',async()=>{
 const entry=home('launcher');assert.equal(typeof entry.props.onPrepareNativeRecheck,'function');
 const permit=await (entry.props.onPrepareNativeRecheck as (version:number)=>Promise<()=>boolean>)(37);
 assert.equal(permit,entry.permit);assert.deepEqual(entry.rechecks,[37]);
});
