import {agentAuthorizationSnapshotSchema,agentAuthorizationListSchema,agentAuthorizationReceiptSchema,
  agentAuthorizationScopeSchema} from '../../../packages/contracts/src/agent-authorization.ts';
import type {AgentAuthorizationScope,AgentAuthorizationSnapshot} from '../../../packages/contracts/src/agent-authorization.ts';
import {deriveAgentEndpoint} from '../../../packages/contracts/src/agent-protocol.ts';
import type {AgentEndpointConfiguration} from '../../../packages/contracts/src/agent-protocol.ts';

export function safeAgentAuthorizationSnapshot(value:unknown):AgentAuthorizationSnapshot{
  const parsed=agentAuthorizationSnapshotSchema.safeParse(value);
  if(!parsed.success||new Set(parsed.data.scopes).size!==parsed.data.scopes.length)throw new Error('Invalid authorization snapshot');
  return parsed.data;
}
export function agentAuthorizationKey(configuration:AgentEndpointConfiguration&{model:string},scope:unknown):string{
  return JSON.stringify([deriveAgentEndpoint(configuration),configuration.model,agentAuthorizationScopeSchema.parse(scope)]);
}
export function hasAgentAuthorization(snapshot:AgentAuthorizationSnapshot|undefined,scope:AgentAuthorizationScope):boolean{
  return Boolean(snapshot?.scopes.includes(scope));
}
export {agentAuthorizationListSchema,agentAuthorizationReceiptSchema};
