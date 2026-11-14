import {testEnv} from './helpers/test-env.ts';
import test from 'node:test';
import {rpcPathFor} from '../packages/contracts/src/project-addressing.ts';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import type {ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {createServerProject} from './helpers/project-database.ts';
import {openAppLibrary} from '../packages/business/src/app-db/index.ts';
import {createProjectServiceApplication} from '../packages/business/src/project-service-application.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createProviderRegistry} from '../packages/business/src/provider-registry.ts';
import {defaultVideoModels,VIDEO_PROVIDER_NAMES} from '../packages/contracts/src/video-providers.ts';
import type {VideoConnectionConfigurationV2} from '../packages/contracts/src/generation-video-settings.ts';
const repo=fileURLToPath(new URL('..',import.meta.url)),token='profile-parity-local-synthetic-token';
const pause=(ms: number): Promise<void>=>new Promise(resolve=>setTimeout(resolve,ms));
type EnvMap = Record<string, string|undefined>;
function environment(extra: EnvMap = {}): EnvMap {const env: EnvMap = {...testEnv()};for(const key of Object.keys(env))if(/^MIOON_/.test(key))delete env[key];return {...env,...extra};}
async function cli(args: string[], env: EnvMap,failureExit=6): Promise<{ok?: boolean; [key: string]: unknown}>{
 const child=spawn(process.execPath,[path.join(repo,'apps/cli/src/index.ts'),...args],{cwd:repo,env:environment(env),stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.setEncoding('utf8').on('data',(data: string)=>stdout+=data);child.stderr.setEncoding('utf8').on('data',(data: string)=>stderr+=data);
 const timer=setTimeout(()=>child.kill('SIGKILL'),10000);let code,signal;try{[code,signal]=await once(child,'close') as [number|null, string|null];}finally{clearTimeout(timer);}
 assert.equal(signal,null,stderr);const response=JSON.parse(stdout);assert.equal(code,response.ok?0:failureExit,stderr);return response;
}

test('actual HTTP, CLI and official MCP expose identical dated profiles and reject complete oversized saved reference',{timeout:30000},async (t: unknown)=>{
 const root=await mkdtemp(path.join(tmpdir(),'mioon-input-transport-')),created=createServerProject(root,{name:'Offline profile parity'}),store=created.store,library=openAppLibrary({dataDir:root}),registry=createProviderRegistry({db:store.db,root:store.projectDir,env:{}}),services=createServices(store,registry,{env:{},application:createProjectServiceApplication(library,undefined,{})});
 interface IdRecord {id: string; revision: number; [key: string]: unknown}
 const project=store.get('projects',created.projectId) as unknown as IdRecord,asset={id:randomUUID(),projectId:project.id,mimeType:'image/png',sha256:'a'.repeat(64),sizeBytes:31*1024*1024,width:360,height:640,relativePath:'media/inert-not-dispatched.png'};
 store.put('assets',asset as never);const shot=await services.call('shot.create',{projectId:project.id,title:'Oversized input',referenceAssetIds:[asset.id]}) as unknown as IdRecord;await services.drain();store.close();library.close();
 let child: ChildProcess|undefined,url:string|undefined,stdout='',stderr='';
 (t as {after(callback: ()=>Promise<void>): void}).after(async()=>{const running=child;if(running?.exitCode===null){const ended=once(running,'exit');running.kill('SIGTERM');const timer=setTimeout(()=>running.kill('SIGKILL'),10000);try{await ended;}finally{clearTimeout(timer);}}await rm(root,{recursive:true,force:true});});
 child=spawn(process.execPath,[path.join(repo,'apps/server/src/cli.ts')],{cwd:repo,env:environment({MIOON_DATA_DIR:root,MIOON_TOKEN:token,PORT:'0'}),stdio:['ignore','pipe','pipe']}); child.stdout!.setEncoding('utf8').on('data',(data: string)=>stdout+=data);child.stderr!.setEncoding('utf8').on('data',(data: string)=>stderr+=data);
 const deadline=Date.now()+20000;while(Date.now()<deadline){assert.equal(child!.exitCode,null,stderr);url=/Mioon ready at (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout)?.[1];if(url)break;await pause(20);}assert.ok(url,stderr);
 const env: EnvMap={MIOON_BASE_URL:url,MIOON_TOKEN:token},http=async(operation: string,input: Record<string, unknown>): Promise<{ok?: boolean; data?: unknown; error?: {code?: string}; [key: string]: unknown}>=>{const response=await fetch(url!+rpcPathFor(operation,input,project.id),{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({operation,input})});return response.json() as Promise<{ok?: boolean; data?: unknown; error?: {code?: string}; [key: string]: unknown}>;};
 const client=new Client({name:'input-profile-parity',version:'1.0.0'},{capabilities:{}}),transport=new StdioClientTransport({command:process.execPath,args:[path.join(repo,'apps/mcp/src/index.ts')],cwd:repo,env:environment(env) as Record<string,string>,stderr:'pipe'});
 (transport.stderr as unknown as import('node:stream').Readable|undefined)?.resume();(t as {after(callback: ()=>Promise<void>): void}).after(()=>client.close());await client.connect(transport);
 const mcp=async(name: string,input: Record<string, unknown>={}): Promise<Record<string, unknown>>=>{const response=await client.callTool({name,arguments:input}) as {content: {type: string; text: string}[]; structuredContent: unknown}; const match=response.content.find((item: {type: string})=>item.type==='text'); assert.ok(match); const body=JSON.parse(match!.text) as Record<string, unknown>;assert.deepEqual(response.structuredContent,body);return body;};
 const discovery=await http('provider.list',{}),command=await cli(['provider','list'],env),protocol=await mcp('provider_list');
 assert.equal(discovery.ok,true);assert.deepEqual(command,discovery);assert.deepEqual(protocol,discovery);
 for(const provider of discovery.data as {inputProfiles: unknown[]; profileEvaluationDate: string; inputProfileEvaluations: {evaluatedAsOf: string}[]}[]){assert.equal(provider.inputProfiles.length,1);assert.match(provider.profileEvaluationDate,/^\d{4}-\d{2}-\d{2}$/);assert.equal(provider.inputProfileEvaluations[0]!.evaluatedAsOf,provider.profileEvaluationDate);}
 const input: Record<string, unknown>={shotId:shot.id,expectedRevision:shot.revision,providerId:'mock',requestId:randomUUID()},failure=await http('generation.submit',input);
 assert.equal(failure.ok,false);assert.equal(failure.error?.code,'REFERENCE_TOO_LARGE');
 // CLI and MCP give the shot's project beside the shared input.
 assert.deepEqual(await cli(['generation','submit','--input',JSON.stringify({projectId:project.id,...input})],env),failure);assert.deepEqual(await mcp('generation_submit',{projectId:project.id,...input}),failure);
 assert.deepEqual((await http('job.list',{projectId:project.id})).data,[]);
 assert.ok(!JSON.stringify(discovery).includes(token)&&!JSON.stringify(failure).includes('relativePath'));
 // A configured Wan model is discoverable through every transport, while the
 // a deliberately mismatched model prevents this parity test from dispatching any media.
 const connection:VideoConnectionConfigurationV2={id:randomUUID(),providerId:'wan',name:VIDEO_PROVIDER_NAMES.wan,region:'cn-beijing',workspaceId:'test-workspace',enabled:true,outputHosts:['output.example'],models:defaultVideoModels('wan').filter(model=>model.templateId==='wan30-v1')};
 const saved=await fetch(url!+'/api/video-providers/settings',{method:'PUT',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({action:'save',expectedRevision:0,configuration:connection,secret:{action:'replace',value:'synthetic-wan-parity-key',storage:'session'}})});
 assert.equal(saved.status,200);
 const directory=await http('video.connection.list',{});
 assert.equal(directory.ok,true);assert.deepEqual(await cli(['video','connection','list'],env),directory);assert.deepEqual(await mcp('video_connection_list'),directory);
 assert.equal((await http('workspace.settings.set',{expectedRevision:0,liveGeneration:false})).ok,true);
 const wanInput={shotId:shot.id,expectedRevision:shot.revision,providerId:'wan',model:'synthetic-mismatched-model',requestId:randomUUID(),connectionId:connection.id,configurationRevision:1,modelEntryId:connection.models[0]!.id,videoInput:{version:1,mode:'text',images:[],prompt:'No network generation.'},parameters:{durationSeconds:-1,aspectRatio:'adaptive',resolution:'480P',generateAudio:false,promptExtend:false,watermark:true}};
 const refused=await http('generation.submit',wanInput);assert.equal(refused.error?.code,'VIDEO_BINDING_INVALID');
 assert.deepEqual(await cli(['generation','submit','--input',JSON.stringify({projectId:project.id,...wanInput})],env),refused);assert.deepEqual(await mcp('generation_submit',{projectId:project.id,...wanInput}),refused);
 const schema=await cli(['schema','generation.submit'],env);assert.match(JSON.stringify(schema),/videoInput/);assert.match(JSON.stringify(schema),/durationSeconds/);
 assert.deepEqual((await http('job.list',{projectId:project.id})).data,[]);
});
