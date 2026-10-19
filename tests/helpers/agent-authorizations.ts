import {randomUUID} from 'node:crypto';
import {ownsStoreLock,getWorkspaceRestoreContext} from '../../packages/business/src/db.ts';
import {deriveAgentEndpoint} from '../../packages/contracts/src/agent-protocol.ts';
import {readPrivateFile,writePrivateFileAtomic,validatePrivateDirectory,validateManagedFile} from '@mioon/contracts/private-storage';
import {createAgentAuthorizations} from '../../packages/business/src/agent/authorizations.ts';

/** Runtime fixtures use actual private sidecar grants, not an always-allow
 * authorizer. Only explicit approved-input construction grants a scope. */
interface AuthorizationsStore {readonly root: string; readonly db: unknown; readonly [key: string]: unknown}
type StoreOrRead = AuthorizationsStore | (() => AuthorizationsStore)
interface SettingsSnapshot {readonly configuration: unknown; readonly revision: number}
interface SettingsReader {get(): Promise<SettingsSnapshot>}
type Authorizations = ReturnType<typeof createAgentAuthorizations>
export function createTestAuthorizations(storeOrRead: StoreOrRead, settings: SettingsReader): Authorizations {
  const read=typeof storeOrRead==='function'?storeOrRead:()=>storeOrRead;
  return createAgentAuthorizations({root:read().root,
    storage:{readPrivateFile,writePrivateFileAtomic,validatePrivateDirectory,validateManagedFile},
    guards:{ownsLock:()=>ownsStoreLock(read() as never),isRestored:()=>Boolean(getWorkspaceRestoreContext(read() as never))},
    readCurrentTarget:async()=>{const current=await settings.get();return {
      destination:deriveAgentEndpoint(current.configuration as never),model:(current.configuration as {model: string}).model,settingsRevision:current.revision,
    };},
  });
}
export async function authorizeTestScope(authorizations: Authorizations,scope='typed_chat_only'): Promise<void> {
  const current=await authorizations.list();
  if(current.authorizations.some((row: {destination: string; model: string; scope: string})=>row.destination===current.currentTarget.destination&&row.model===current.currentTarget.model&&row.scope===scope))return;
  await authorizations.grant({requestId:randomUUID(),expectedRevision:current.revision,expectedSettingsRevision:current.currentTarget.settingsRevision,
    destination:current.currentTarget.destination,model:current.currentTarget.model,scope});
}
interface HttpRequest { (route: string, options: {method: string; input: unknown}): Promise<{status: number; body?: unknown}> }
interface HttpSnapshot {authorization: {scopes: readonly string[]; revision: number}; settings: {revision: number; configuration: unknown}}
export async function authorizeHttpSnapshot(request: HttpRequest, snapshot: HttpSnapshot, scope='typed_chat_only'): Promise<void> {
  if(snapshot.authorization.scopes.includes(scope))return;
  const result=await request('/api/rpc',{method:'POST',input:{operation:'agent.authorization.grant',input:{requestId:randomUUID(),
    expectedRevision:snapshot.authorization.revision,expectedSettingsRevision:snapshot.settings.revision,
    destination:deriveAgentEndpoint(snapshot.settings.configuration),model:snapshot.settings.configuration.model,scope}}});
  if(result.status!==200||(result.body as {ok?: unknown}|null|undefined)?.ok!==true)throw new Error(`Synthetic authorization failed: ${result.status}`);
}
