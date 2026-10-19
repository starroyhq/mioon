import {randomUUID} from 'node:crypto';
import {ownsStoreLock,getWorkspaceRestoreContext} from '../../packages/business/src/db.mjs';
import {deriveAgentEndpoint} from '../../packages/contracts/src/agent-protocol.ts';
import {readPrivateFile,writePrivateFileAtomic,validatePrivateDirectory,validateManagedFile} from '@mioon/contracts/private-storage';
import {createAgentAuthorizations} from '../../packages/business/src/agent/authorizations.ts';

/** Runtime fixtures use actual private sidecar grants, not an always-allow
 * authorizer. Only explicit approved-input construction grants a scope. */
export function createTestAuthorizations(storeOrRead,settings){
  const read=typeof storeOrRead==='function'?storeOrRead:()=>storeOrRead;
  return createAgentAuthorizations({root:read().root,
    storage:{readPrivateFile,writePrivateFileAtomic,validatePrivateDirectory,validateManagedFile},
    guards:{ownsLock:()=>ownsStoreLock(read()),isRestored:()=>Boolean(getWorkspaceRestoreContext(read()))},
    readCurrentTarget:async()=>{const current=await settings.get();return {
      destination:deriveAgentEndpoint(current.configuration),model:current.configuration.model,settingsRevision:current.revision,
    };},
  });
}
export async function authorizeTestScope(authorizations,scope='typed_chat_only'){
  const current=await authorizations.list();
  if(current.authorizations.some(row=>row.destination===current.currentTarget.destination&&row.model===current.currentTarget.model&&row.scope===scope))return;
  await authorizations.grant({requestId:randomUUID(),expectedRevision:current.revision,expectedSettingsRevision:current.currentTarget.settingsRevision,
    destination:current.currentTarget.destination,model:current.currentTarget.model,scope});
}
export async function authorizeHttpSnapshot(request,snapshot,scope='typed_chat_only'){
  if(snapshot.authorization.scopes.includes(scope))return;
  const result=await request('/api/rpc',{method:'POST',input:{operation:'agent.authorization.grant',input:{requestId:randomUUID(),
    expectedRevision:snapshot.authorization.revision,expectedSettingsRevision:snapshot.settings.revision,
    destination:deriveAgentEndpoint(snapshot.settings.configuration),model:snapshot.settings.configuration.model,scope}}});
  if(result.status!==200||result.body?.ok!==true)throw new Error(`Synthetic authorization failed: ${result.status}`);
}
