import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {startServer} from './helpers/test-server.ts';
import {agentAuthorizationListSchema} from '../packages/contracts/src/agent-authorization.ts';
import {agentServiceInput,agentSettingsSnapshotSchema} from '../packages/contracts/src/agent-connection-settings.ts';
import {defaultTestAgentConfiguration} from './helpers/agent-preset-configurations.ts';

const repo=fileURLToPath(new URL('../',import.meta.url)),run=promisify(execFile);
test('HTTP, CLI and MCP share grant/revoke state without granting built-in model tools authority',{timeout:30000},async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'mioon-authorization-wire-')),token='synthetic-authorization-wire-token';let calls=0;
  const server=await startServer({dataDir:root,port:0,token,chatGateway:async function*(){calls++;yield {type:'done',finishReason:'stop'};}});
  const client=new Client({name:'authorization-offline-test',version:'1'},{capabilities:{}});
  t.after(async()=>{await client.close();await server.close();await rm(root,{recursive:true,force:true});});
  const env={PATH:process.env.PATH||'',MIOON_BASE_URL:server.url,MIOON_TOKEN:token,};
  const transport=new StdioClientTransport({command:process.execPath,args:[path.join(repo,'apps/mcp/src/index.ts')],cwd:repo,env,stderr:'pipe'});(transport.stderr as {resume?: () => void} | null | undefined)?.resume?.();
  await client.connect(transport);
  const http=async(operation: string,input: Record<string, unknown>={})=>{
    const response=await fetch(server.url+'/api/rpc',{method:'POST',headers:{authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({operation,input})});
    const body=await response.json() as {ok?: boolean; data?: Record<string, unknown>};assert.equal(response.status,200,JSON.stringify(body));assert.equal(body.ok,true);return body.data as Record<string, unknown>;
  };
  const cli=async(operation: string,input: Record<string, unknown>={})=>{
    const result=await run(process.execPath,[path.join(repo,'apps/cli/src/index.ts'),...operation.split('.'),'--input',JSON.stringify(input)],{cwd:repo,env,timeout:15000});
    const body=JSON.parse(result.stdout) as {ok?: boolean; data?: Record<string, unknown>};assert.equal(body.ok,true);return body.data as Record<string, unknown>;
  };
  const mcp=async(operation: string,input: Record<string, unknown>={})=>{
    const result=await client.callTool({name:operation.replaceAll('.','_'),arguments:input});assert.equal(result.isError,false,JSON.stringify(result));return (result.structuredContent as {data: Record<string, unknown>}).data;
  };
  const initial=agentAuthorizationListSchema.parse(await cli('agent.authorization.list'));assert.equal(initial.currentTarget,null);
  assert.deepEqual(initial,await http('agent.authorization.list'));assert.deepEqual(initial,await mcp('agent.authorization.list'));
  const settingsResponse=await fetch(server.url+'/api/agent/settings',{headers:{authorization:`Bearer ${token}`}});assert.equal(settingsResponse.status,200);
  const settingsBody=await settingsResponse.json() as {ok?:boolean;data?:unknown};assert.equal(settingsBody.ok,true);
  const settings=agentSettingsSnapshotSchema.parse(settingsBody.data),configuration=defaultTestAgentConfiguration('chat_completions');
  const savedResponse=await fetch(server.url+'/api/agent/settings',{method:'PUT',headers:{authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({expectedRevision:settings.revision,services:settings.services.map(agentServiceInput),mioSelection:{serviceKey:configuration.presetId,modelId:configuration.model},secretActions:[]})});
  const savedBody=await savedResponse.json() as {ok?:boolean;data?:unknown};assert.equal(savedResponse.status,200,JSON.stringify(savedBody));assert.equal(savedBody.ok,true);agentSettingsSnapshotSchema.parse(savedBody.data);
  const listed=agentAuthorizationListSchema.parse(await cli('agent.authorization.list'));assert.ok(listed.currentTarget);
  assert.deepEqual(listed,await http('agent.authorization.list'));assert.deepEqual(listed,await mcp('agent.authorization.list'));
  const target=listed.currentTarget,input={requestId:randomUUID(),expectedRevision:listed.revision,expectedSettingsRevision:target.settingsRevision,
    destination:target.destination,model:target.model,scope:'typed_chat_only'};
  const granted=await mcp('agent.authorization.grant',input) as {authorizationId: string};assert.deepEqual(await http('agent.authorization.grant',input),granted);
  let state=await http('agent.authorization.list') as {authorizations: unknown[]; revision: number};assert.equal(state.authorizations.length,1);
  await cli('agent.authorization.revoke',{requestId:randomUUID(),expectedRevision:state.revision,authorizationId:granted.authorizationId});
  await mcp('agent.authorization.grant',input);state=await cli('agent.authorization.list') as {authorizations: unknown[]; revision: number};assert.equal(state.authorizations.length,0);assert.equal(calls,0);
  const tools=(await client.listTools()).tools;assert.ok(tools.some(tool=>tool.name==='agent_authorization_grant'));assert.ok(tools.some(tool=>tool.name==='agent_authorization_revoke'));
});
