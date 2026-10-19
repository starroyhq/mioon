import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,symlink,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {openStore} from '../packages/business/src/db.ts';
import {createAgentSettings,AGENT_CREDENTIAL_ACQUIRE} from '../packages/business/src/agent/settings.ts';
import {createChatRuntime} from '../packages/business/src/agent/chat-runtime.ts';
import {AGENT_AUTHORIZATION_FILENAME} from '../packages/business/src/agent/authorizations.ts';
import {AGENT_AUTHORIZATION_SCOPES,agentAuthorizationSchemas} from '../packages/contracts/src/agent-authorization.ts';
import {deriveAgentEndpoint} from '../packages/contracts/src/agent-protocol.ts';
import {createTestAuthorizations,authorizeTestScope} from './helpers/agent-authorizations.ts';

async function fixture(t: TestContext){
  const root=await mkdtemp(path.join(tmpdir(),'mioon-authorizations-'));let store=openStore(root);
  const settings=await createAgentSettings({persistence:{load:async()=>null,save:async()=>{}}});
  const initial=await settings.get();
  await settings.put({expectedRevision:0,configuration:initial.configuration,secret:{action:'replace',storage:'session',value:'synthetic-authorization-secret'}});
  const authorizations=createTestAuthorizations((()=>store) as never,settings);
  t.after(async()=>{store.close();await settings.close();await rm(root,{recursive:true,force:true});});
  return {root,settings,authorizations,get store(){return store;},file:path.join(root,AGENT_AUTHORIZATION_FILENAME),
    reopen(){store.close();store=openStore(root);},
    async input(scope='typed_chat_only'){
      const current=await authorizations.list();return {requestId:randomUUID(),expectedRevision:current.revision,
        expectedSettingsRevision:current.currentTarget.settingsRevision,destination:current.currentTarget.destination,model:current.currentTarget.model,scope};
    },
  };
}
const target=(input: Record<string, unknown>)=>({destination:input.destination,model:input.model,scope:input.scope});

test('closed scopes reject arbitrary authority fields and distinguish move from gain',()=>{
  assert.equal(AGENT_AUTHORIZATION_SCOPES.length,5);
  const base={requestId:randomUUID(),expectedRevision:0,expectedSettingsRevision:0,destination:'https://api.openai.com/v1/responses',model:'gpt-test'};
  for(const scope of AGENT_AUTHORIZATION_SCOPES)assert.ok(agentAuthorizationSchemas['agent.authorization.grant'].safeParse({...base,scope}).success);
  for(const patch of [{scope:'all'},{scope:'project_inspection',secret:'never'},{scope:'typed_chat_only',destination:'https://user:secret@api.openai.com/v1/responses'},{scope:'typed_chat_only',destination:'https://api.openai.com/v1/../responses'}])
    assert.equal(agentAuthorizationSchemas['agent.authorization.grant'].safeParse({...base,...patch}).success,false);
});

test('first send is denied; grants persist by exact endpoint/model/scope across restart',async t=>{
  const f=await fixture(t),input=await f.input();
  assert.throws(()=>f.authorizations.assertAuthorized(target(input)),{code:'AGENT_AUTHORIZATION_REQUIRED'});
  await f.authorizations.grant(input);f.reopen();
  f.authorizations.assertAuthorized(target(input));
  for(const patch of [{model:'changed'},{destination:'https://other.example.com/v1/chat/completions'},{scope:'project_inspection'}])
    assert.throws(()=>f.authorizations.assertAuthorized({...target(input),...patch}),{code:'AGENT_AUTHORIZATION_REQUIRED'});
  const disk=await readFile(f.file,'utf8');assert.doesNotMatch(disk,/synthetic-authorization-secret|userText|assistantText|projectId/);
  assert.equal((await stat(f.file)).mode&0o777,0o600);
});

test('CAS, exact receipts and revocation cannot revive an old grant',async t=>{
  const f=await fixture(t),input=await f.input(),receipt=await f.authorizations.grant(input);
  assert.deepEqual(await f.authorizations.grant(input),receipt);
  await assert.rejects(f.authorizations.grant({...input,scope:'project_inspection'}),{code:'AGENT_AUTHORIZATION_IDEMPOTENCY_CONFLICT'});
  await assert.rejects(f.authorizations.grant({...input,requestId:randomUUID()}),{code:'AGENT_AUTHORIZATION_CONFLICT'});
  const revoke={requestId:randomUUID(),expectedRevision:receipt.revision,authorizationId:receipt.authorizationId};
  const removed=await f.authorizations.revoke(revoke);assert.deepEqual(await f.authorizations.revoke(revoke),removed);
  assert.deepEqual(await f.authorizations.grant(input),receipt);
  assert.throws(()=>f.authorizations.assertAuthorized(target(input)),{code:'AGENT_AUTHORIZATION_REQUIRED'});
  await f.authorizations.grant(await f.input());f.authorizations.assertAuthorized(target(input));
});

test('changed settings, unsafe files and corruption fail closed without overwriting evidence',async t=>{
  const f=await fixture(t),input=await f.input(),current=await f.settings.get();
  await f.settings.put({expectedRevision:current.revision,configuration:{...current.configuration,model:'changed-model'},secret:{action:'keep'}});
  await assert.rejects(f.authorizations.grant(input),{code:'AGENT_AUTHORIZATION_SETTINGS_CONFLICT'});
  await writeFile(f.file,'retained corrupt evidence',{mode:0o600});
  await assert.rejects(f.authorizations.list(),{code:'AGENT_AUTHORIZATION_UNAVAILABLE'});
  await assert.rejects(f.authorizations.grant(input),{code:'AGENT_AUTHORIZATION_UNAVAILABLE'});
  assert.equal(await readFile(f.file,'utf8'),'retained corrupt evidence');
  await rm(f.file);const outside=path.join(f.root,'outside-evidence');await writeFile(outside,'do not alter',{mode:0o600});await symlink(outside,f.file);
  await assert.rejects(f.authorizations.list(),{code:'AGENT_AUTHORIZATION_UNAVAILABLE'});
  assert.equal(await readFile(outside,'utf8'),'do not alter');
});

test('backend rejects ungranted requests before credentials and revocation fences async acquisition',async t=>{
  const f=await fixture(t);f.store.put('projects',{id:'p1'});let acquired=0,calls=0,release;
  const supplied={get:()=>f.settings.get(),[AGENT_CREDENTIAL_ACQUIRE](expected: unknown,options: unknown){acquired++;return new Promise<unknown>(resolve=>{release=async()=>resolve(await f.settings[AGENT_CREDENTIAL_ACQUIRE](expected as never,options as never));});}};
  const runtime=createChatRuntime({store:f.store,agentSettings:supplied as never,authorizations:f.authorizations,selfPort:()=>4318,
    gateway:async function*(){calls++;yield {type:'done',finishReason:'stop'};}});
  t.after(()=>runtime.close());
  const snapshot=await runtime.snapshot('p1') as unknown as {settings: {configuration: {protocol: 'chat_completions' | 'responses'; model: string; baseUrl: string}; revision: number}; instanceId: string; revision: number},configuration=snapshot.settings.configuration;
  const input={requestId:randomUUID(),instanceId:snapshot.instanceId,expectedSettingsRevision:snapshot.settings.revision,expectedConversationRevision:snapshot.revision,
    message:'Private content must never be authorized by its own text',consent:{destination:deriveAgentEndpoint(configuration),protocol:configuration.protocol,model:configuration.model,context:'typed_chat_only'}};
  await assert.rejects(runtime.send('p1',input),{code:'AGENT_CHAT_CONSENT_REQUIRED'});assert.equal(acquired,0);assert.equal(calls,0);
  await authorizeTestScope(f.authorizations);const sent=await runtime.send('p1',input) as unknown as {run: {id: string}; instanceId: string; replayed?: boolean};
  for(let i=0;i<100&&!release;i++)await new Promise(resolve=>setTimeout(resolve,2));assert.equal(acquired,1);
  const current=await f.authorizations.list();await f.authorizations.revoke({requestId:randomUUID(),expectedRevision:current.revision,authorizationId:current.authorizations[0].id});
  await release!();
  for(let i=0;i<100&&(runtime.get('p1',sent.run.id,sent.instanceId) as {run: {status: string}}).run.status==='running';i++)await new Promise(resolve=>setTimeout(resolve,2));
  const ended=runtime.get('p1',sent.run.id,sent.instanceId) as {run: {error: {code?: string}}};assert.equal(ended.run.error.code,'AGENT_CHAT_CONSENT_REQUIRED');assert.equal(calls,0);
  assert.equal((await runtime.send('p1',input) as {replayed?: boolean}).replayed,true);assert.equal(calls,0);
});
