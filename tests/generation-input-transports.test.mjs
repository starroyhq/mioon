import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {openStore} from '../packages/business/src/db.mjs';
import {createServices} from '../packages/business/src/services.mjs';
import {createProviderRegistry} from '../packages/business/src/provider-registry.mjs';
const repo=fileURLToPath(new URL('..',import.meta.url)),token='profile-parity-local-synthetic-token';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function environment(extra={}){const env={...process.env};for(const key of Object.keys(env))if(/^(MIOON_|ARK_|VEO_|RUNWAY|MINIMAX_|VIDU_|GEMINI_|GOOGLE_)/.test(key))delete env[key];return {...env,MIOON_ENABLE_LIVE_PROVIDER:'0',...extra};}
async function cli(args,env){
 const child=spawn(process.execPath,[path.join(repo,'apps/cli/src/index.mjs'),...args],{cwd:repo,env:environment(env),stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);
 const timer=setTimeout(()=>child.kill('SIGKILL'),10000);let code,signal;try{[code,signal]=await once(child,'close');}finally{clearTimeout(timer);}
 assert.equal(signal,null,stderr);const response=JSON.parse(stdout);assert.equal(code,response.ok?0:6,stderr);return response;
}

test('actual HTTP, CLI and official MCP expose identical dated profiles and reject complete oversized saved reference',{timeout:30000},async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'mioon-input-transport-')),store=openStore(root),registry=createProviderRegistry({db:store.db,root,env:{}}),services=createServices(store,registry,{env:{}});
 const project=await services.call('project.create',{name:'Offline profile parity'}),asset={id:randomUUID(),projectId:project.id,mimeType:'image/png',sha256:'a'.repeat(64),sizeBytes:31*1024*1024,width:360,height:640,relativePath:'media/inert-not-dispatched.png'};
 store.put('assets',asset);const shot=await services.call('shot.create',{projectId:project.id,title:'Oversized input',referenceAssetIds:[asset.id]});store.close();
 let child,url,stdout='',stderr='';
 t.after(async()=>{if(child?.exitCode===null){const ended=once(child,'exit');child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),10000);try{await ended;}finally{clearTimeout(timer);}}await rm(root,{recursive:true,force:true});});
 child=spawn(process.execPath,[path.join(repo,'apps/server/src/cli.mjs')],{cwd:repo,env:environment({MIOON_DATA_DIR:root,MIOON_TOKEN:token,PORT:'0'}),stdio:['ignore','pipe','pipe']});child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);
 const deadline=Date.now()+10000;while(Date.now()<deadline){assert.equal(child.exitCode,null,stderr);url=/Mioon ready at (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout)?.[1];if(url)break;await pause(20);}assert.ok(url,stderr);
 const env={MIOON_BASE_URL:url,MIOON_TOKEN:token},http=async(operation,input)=>{const response=await fetch(url+'/api/rpc',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({operation,input})});return response.json();};
 const client=new Client({name:'input-profile-parity',version:'1.0.0'},{capabilities:{}}),transport=new StdioClientTransport({command:process.execPath,args:[path.join(repo,'apps/mcp/src/index.mjs')],cwd:repo,env:environment(env),stderr:'pipe'});
 transport.stderr?.resume();t.after(()=>client.close());await client.connect(transport);
 const mcp=async(name,input={})=>{const response=await client.callTool({name,arguments:input});const body=JSON.parse(response.content.find(item=>item.type==='text').text);assert.deepEqual(response.structuredContent,body);return body;};
 const discovery=await http('provider.list',{}),command=await cli(['provider','list'],env),protocol=await mcp('provider_list');
 assert.equal(discovery.ok,true);assert.deepEqual(command,discovery);assert.deepEqual(protocol,discovery);
 for(const provider of discovery.data){assert.equal(provider.inputProfiles.length,1);assert.match(provider.profileEvaluationDate,/^\d{4}-\d{2}-\d{2}$/);assert.equal(provider.inputProfileEvaluations[0].evaluatedAsOf,provider.profileEvaluationDate);}
 const input={shotId:shot.id,expectedRevision:shot.revision,providerId:'mock',requestId:randomUUID()},failure=await http('generation.submit',input);
 assert.equal(failure.ok,false);assert.equal(failure.error.code,'REFERENCE_TOO_LARGE');
 assert.deepEqual(await cli(['generation','submit','--input',JSON.stringify(input)],env),failure);assert.deepEqual(await mcp('generation_submit',input),failure);
 assert.deepEqual((await http('job.list',{projectId:project.id})).data,[]);
 assert.ok(!JSON.stringify(discovery).includes(token)&&!JSON.stringify(failure).includes('relativePath'));
});
