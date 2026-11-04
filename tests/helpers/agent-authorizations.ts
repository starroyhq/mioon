import {randomUUID} from 'node:crypto';
import {ownsStoreLock} from '../../packages/business/src/store-runtime.ts';
import {deriveAgentEndpoint} from '../../packages/contracts/src/agent-protocol.ts';
import {readPrivateFile,writePrivateFileAtomic,validatePrivateDirectory,validateManagedFile} from '@mioon/contracts/private-storage';
import {createAgentAuthorizations} from '../../packages/business/src/agent/authorizations.ts';
import {testStoreForConnection} from '../../packages/business/src/project-file/test-store.ts';
import {testProjectAppLibrary} from '../../packages/business/src/project-service-application.ts';
import {isAppLibraryHeld} from '../../packages/business/src/app-db/connection.ts';
import {lstatSync} from 'node:fs';

/** Runtime fixtures use actual private sidecar grants, not an always-allow
 * authorizer. Only explicit approved-input construction grants a scope. */
interface AuthorizationsStore {readonly root: string; readonly db: unknown}
type StoreOrRead = AuthorizationsStore | (() => AuthorizationsStore)
interface SettingsSnapshot {readonly execution: {readonly configuration: {readonly model:string};readonly revision:number}|null}
interface SettingsReader {get(): Promise<SettingsSnapshot>}
type Authorizations = ReturnType<typeof createAgentAuthorizations>
export function createTestAuthorizations(storeOrRead: StoreOrRead, settings: SettingsReader): Authorizations {
  const read=typeof storeOrRead==='function'?storeOrRead:()=>storeOrRead;
  const initial=read(),owner=testStoreForConnection(initial.db,initial.root),library=owner?testProjectAppLibrary(owner):undefined;
  const root=library?.dataDir??initial.root,databaseFile=library?.databaseFile;
  return createAgentAuthorizations({root,...(databaseFile?{databaseFile}:{}),
    storage:{readPrivateFile,writePrivateFileAtomic,validatePrivateDirectory,validateManagedFile},
    guards:{ownsLock:()=>{
      if(!databaseFile)return ownsStoreLock(read() as never);
      const current=read(),actual=testStoreForConnection(current.db,current.root),app=actual?testProjectAppLibrary(actual):undefined;
      if(!app||app.databaseFile!==databaseFile||app.dataDir!==root)return false;
      const info=lstatSync(databaseFile,{bigint:true});
      return isAppLibraryHeld({dev:String(info.dev),ino:String(info.ino)},app.db);
    }},
    readCurrentTarget:async()=>{const {execution:current}=await settings.get();return current? {
      destination:deriveAgentEndpoint(current.configuration as never),model:(current.configuration as {model: string}).model,settingsRevision:current.revision,
    }:null;},
  });
}
export async function authorizeTestScope(authorizations: Authorizations,scope='typed_chat_only'): Promise<void> {
  const current=await authorizations.list();
  const target=current.currentTarget;if(!target)throw new Error('No selected Mio connection');
  if(current.authorizations.some((row: {destination: string; model: string; scope: string})=>row.destination===target.destination&&row.model===target.model&&row.scope===scope))return;
  await authorizations.grant({requestId:randomUUID(),expectedRevision:current.revision,expectedSettingsRevision:target.settingsRevision,
    destination:target.destination,model:target.model,scope});
}
interface HttpRequest { (route: string, options: {method: string; input: unknown}): Promise<{status: number; body?: unknown}> }
interface HttpSnapshot {authorization: {scopes: readonly string[]; revision: number}; settings: SettingsSnapshot}
export async function authorizeHttpSnapshot(request: HttpRequest, snapshot: HttpSnapshot, scope='typed_chat_only'): Promise<void> {
  if(snapshot.authorization.scopes.includes(scope))return;
  const execution=snapshot.settings.execution;if(!execution)throw new Error('No selected Mio connection');
  const result=await request('/api/rpc',{method:'POST',input:{operation:'agent.authorization.grant',input:{requestId:randomUUID(),
    expectedRevision:snapshot.authorization.revision,expectedSettingsRevision:execution.revision,
    destination:deriveAgentEndpoint(execution.configuration as never),model:(execution.configuration as {model: string}).model,scope}}});
  if(result.status!==200||(result.body as {ok?: unknown}|null|undefined)?.ok!==true)throw new Error(`Synthetic authorization failed: ${result.status}`);
}
