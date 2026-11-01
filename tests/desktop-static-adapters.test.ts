import {CURRENT_ORDINARY_SCHEMA} from './helpers/workspace-schema-current.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {build} from 'esbuild';
import {exposeLocalRequire,localRequireBundlePlugin} from '../apps/desktop/scripts/bundle-local-require.ts';
const run=promisify(execFile),repo=fileURLToPath(new URL('../',import.meta.url));
test('desktop adapter transform refuses dynamic or escaped require and preserves other source',()=>{
 const declaration='const require = createRequire(import.meta.url);';
 assert.equal(exposeLocalRequire('export const unrelated=1;','test.ts'),null);
 const exposed = exposeLocalRequire(declaration+"\nconst result:unknown=require('./media.ts');",'test.ts');
 assert.ok(exposed !== null); assert.match(exposed, /require\('\.\/media.ts'\)/u);
 for(const source of ["require(variable)","require('node:fs')",'const escape=require;',"require.resolve('./media.ts')"])assert.throws(()=>exposeLocalRequire(declaration+'\n'+source,'test.ts'),/Non-static/u);
});
test('a self-contained CJS bundle opens ordinary58 without source-tree runtime paths',{timeout:60000},async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'mioon-desktop-adapters-'));t.after(()=>rm(root,{recursive:true,force:true}));const output=path.join(root,'program.cjs');
 const source=`import assert from 'node:assert/strict';import path from 'node:path';
import {openStore,classifyCurrentWorkspaceSchema} from './packages/business/src/db.ts';
import {createServices} from './packages/business/src/services.ts';
(async()=>{const base=process.argv[2];let ordinary=openStore(path.join(base,'ordinary')),services=createServices(ordinary,new Map());assert.equal(classifyCurrentWorkspaceSchema(ordinary.db).schemaVersion,${CURRENT_ORDINARY_SCHEMA});await services.call('project.create',{name:'Bundled ordinary'});await services.drain();ordinary.close();
console.log(JSON.stringify({ordinary:62}));})().catch(error=>{console.error(error);process.exitCode=1;});`;
 await build({stdin:{contents:source,loader:'js',resolveDir:repo},outfile:output,bundle:true,platform:'node',format:'cjs',target:'node24',plugins:[localRequireBundlePlugin(repo)],define:{'import.meta.url':'__mioon_import_meta_url'},banner:{js:'const __mioon_import_meta_url = require("node:url").pathToFileURL(__filename).href;'},logLevel:'silent'});
 const result=await run(process.execPath,[output,path.join(root,'data')],{cwd:root,env:{PATH:process.env.PATH||'',TMPDIR:process.env.TMPDIR||root},timeout:45000,maxBuffer:1024*1024});assert.deepEqual(JSON.parse(result.stdout),{ordinary:62});
});
