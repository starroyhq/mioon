import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {readFile, realpath, mkdtemp, rm, mkdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {build} from 'esbuild';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {toolingEnvironment, verifySourceLanguages} from '../scripts/lib/local-tooling.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const env=toolingEnvironment(process.env);
function command(args){
 const result=spawnSync(process.execPath,args,{cwd:root,env,encoding:'utf8',timeout:30000,maxBuffer:2*1024*1024,windowsHide:true});
 assert.equal(result.error,undefined,result.error?.message);assert.equal(result.signal,null,result.stderr);assert.equal(result.status,0,result.stderr);return result.stdout;
}
test('repository source policy and genuine compiler check all current included runtime sources', {timeout:60000}, async()=>{
 await verifySourceLanguages(root);
 command(['scripts/tooling.mjs','typecheck']);
});
test('real CLI resolves the pnpm workspace TS implementation and retains version and schema output', async()=>{
 const resolved=fileURLToPath(import.meta.resolve('@mioon/contracts'));
 assert.equal(await realpath(resolved),await realpath(path.join(root,'packages/contracts/src/index.mjs')));
 assert.equal((await realpath(resolved)).split(path.sep).includes('node_modules'),false,'Node strips the actual workspace source, not TS physically installed under node_modules');
 const version=JSON.parse(await readFile(path.join(root,'package.json'),'utf8')).version;
 assert.match(command(['apps/cli/src/index.mjs','--version']),new RegExp(version.replaceAll('.','\\.')));
 const schema=JSON.parse(command(['apps/cli/src/index.mjs','schema','timeline.render']));
 assert.equal(schema.ok,true);assert.equal(schema.data.operation,'timeline.render');
});
test('official MCP actually initializes and discovers shared operations through the typed workspace graph', {timeout:30000}, async t=>{
 const client=new Client({name:'mioon-typecheck-runtime',version:'1.0.0'},{capabilities:{}});
 const transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,'apps/mcp/src/index.mjs')],cwd:root,env,stderr:'pipe'});
 let stderr='';transport.stderr.setEncoding('utf8').on('data',text=>{stderr=(stderr+text).slice(-16000);});
 t.after(()=>client.close());await client.connect(transport);
 const version=JSON.parse(await readFile(path.join(root,'package.json'),'utf8')).version;
 assert.equal(client.getServerVersion().version,version,stderr);
 const tools=await client.listTools();assert.ok(tools.tools.some(x=>x.name==='timeline_render'));
 const result=await client.callTool({name:'mioon_schema',arguments:{operation:'timeline.render'}});
 assert.equal(result.isError,false);assert.equal(result.structuredContent.ok,true);assert.equal(result.structuredContent.data.operation,'timeline.render');
});
test('real React TSX consumer bundles erased types and renders through the installed React implementation', async t=>{
 const parent=path.join(root,'evidence');await mkdir(parent,{recursive:true});const directory=await mkdtemp(path.join(parent,'typecheck-react-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));const outfile=path.join(directory,'consumer.cjs');
 const result=await build({entryPoints:[path.join(root,'tests/typecheck/browser.consumer.tsx')],outfile,absWorkingDir:path.join(root,'apps/web'),
  nodePaths:[path.join(root,'apps/web/node_modules')],bundle:true,platform:'node',format:'cjs',target:'node24',jsx:'automatic',metafile:true,logLevel:'silent'});
 assert.ok(Object.keys(result.metafile.inputs).some(x=>x.endsWith('agent-protocol.ts')));
 assert.ok(Object.keys(result.metafile.inputs).some(x=>x.endsWith('browser.consumer.tsx')));
 const output=await import(pathToFileURL(outfile).href);
 assert.equal(output.renderProtocolProof(),'<span data-protocol="responses">https://api.example.test/v1/responses</span>');
});
test('ordinary Web and direct Desktop build entries cannot omit the compiler gate', async()=>{
 const web=JSON.parse(await readFile(path.join(root,'apps/web/package.json'),'utf8'));
 assert.equal(web.scripts.build,'node ../../scripts/tooling.mjs typecheck && vite build');
 const source=await readFile(path.join(root,'apps/desktop/scripts/build.mjs'),'utf8');
 assert.ok(source.includes("import {main as checkTypes} from '../../../scripts/tooling.mjs';"));
 const checkIndex=source.indexOf("await checkTypes(['typecheck'])"), removeIndex=source.indexOf('await rm(output');
 assert.ok(checkIndex>=0);assert.ok(removeIndex>=0);assert.ok(checkIndex<removeIndex);
 assert.ok(source.includes("throw new Error('Type checking failed; desktop staging was not replaced.')"));
});
