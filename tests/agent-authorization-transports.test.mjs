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
import {startServer} from '../apps/server/src/index.ts';
import {parseReadToolArguments} from '../packages/business/src/agent/read-tool-policy.ts';
import {parseEditToolArguments} from '../packages/business/src/agent/edit-tool-policy.ts';
import {parseTimelineEditToolArguments} from '../packages/business/src/agent/timeline-edit-tool-policy.ts';
import {parseTimelineGainEditToolArguments} from '../packages/business/src/agent/timeline-gain-tool-policy.ts';

const repo=fileURLToPath(new URL('../',import.meta.url)),run=promisify(execFile);
test('HTTP, CLI and MCP share grant/revoke state without granting built-in model tools authority',{timeout:30000},async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'mioon-authorization-wire-')),token='synthetic-authorization-wire-token';let calls=0;
  const server=await startServer({dataDir:root,port:0,token,chatGateway:async function*(){calls++;yield {type:'done',finishReason:'stop'};}});
  const client=new Client({name:'authorization-offline-test',version:'1'},{capabilities:{}});
  t.after(async()=>{await client.close();await server.close();await rm(root,{recursive:true,force:true});});
  const env={PATH:process.env.PATH||'',MIOON_BASE_URL:server.url,MIOON_TOKEN:token,MIOON_ENABLE_LIVE_PROVIDER:'0'};
  const transport=new StdioClientTransport({command:process.execPath,args:[path.join(repo,'apps/mcp/src/index.ts')],cwd:repo,env,stderr:'pipe'});transport.stderr?.resume();
  await client.connect(transport);
  const http=async(operation,input={})=>{
    const response=await fetch(server.url+'/api/rpc',{method:'POST',headers:{authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({operation,input})});
    const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));assert.equal(body.ok,true);return body.data;
  };
  const cli=async(operation,input={})=>{
    const result=await run(process.execPath,[path.join(repo,'apps/cli/src/index.ts'),...operation.split('.'),'--input',JSON.stringify(input)],{cwd:repo,env,timeout:15000});
    const body=JSON.parse(result.stdout);assert.equal(body.ok,true);return body.data;
  };
  const mcp=async(operation,input={})=>{
    const result=await client.callTool({name:operation.replaceAll('.','_'),arguments:input});assert.equal(result.isError,false,JSON.stringify(result));return result.structuredContent.data;
  };
  const listed=await cli('agent.authorization.list');assert.deepEqual(listed,await http('agent.authorization.list'));assert.deepEqual(listed,await mcp('agent.authorization.list'));
  const target=listed.currentTarget,input={requestId:randomUUID(),expectedRevision:listed.revision,expectedSettingsRevision:target.settingsRevision,
    destination:target.destination,model:target.model,scope:'typed_chat_only'};
  const granted=await mcp('agent.authorization.grant',input);assert.deepEqual(await http('agent.authorization.grant',input),granted);
  let state=await http('agent.authorization.list');assert.equal(state.authorizations.length,1);
  const project=await http('project.create',{name:'No message is sent by authorization management'});
  const snapshot=await (await fetch(server.url+`/api/agent/chat/${project.id}`,{headers:{authorization:`Bearer ${token}`}})).json();
  assert.deepEqual(snapshot.data.authorization.scopes,['typed_chat_only']);assert.equal(snapshot.data.runs.length,0);
  await cli('agent.authorization.revoke',{requestId:randomUUID(),expectedRevision:state.revision,authorizationId:granted.authorizationId});
  await mcp('agent.authorization.grant',input);state=await cli('agent.authorization.list');assert.equal(state.authorizations.length,0);assert.equal(calls,0);
  const tools=(await client.listTools()).tools;assert.ok(tools.some(tool=>tool.name==='agent_authorization_grant'));assert.ok(tools.some(tool=>tool.name==='agent_authorization_revoke'));
  for(const parser of [parseReadToolArguments,parseEditToolArguments,parseTimelineEditToolArguments,parseTimelineGainEditToolArguments]){
    for(const name of ['agent_authorization_grant','agent_authorization_revoke','mioon_agent_authorization_grant'])assert.throws(()=>parser(name,'{}'));
  }
});
