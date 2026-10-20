import {z} from 'zod';

export const AGENT_AUTHORIZATION_SCOPES = Object.freeze([
  'project_agent', 'typed_chat_only', 'project_inspection', 'selected_shot_edit',
  'selected_timeline_clip_move', 'selected_timeline_clip_gain',
] as const);
export const AGENT_AUTHORIZATION_LIMITS = Object.freeze({fileBytes:1024*1024,grants:256,requests:2048});
export const agentAuthorizationScopeSchema = z.enum(AGENT_AUTHORIZATION_SCOPES);
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const requestId = z.string().min(8).max(200);
const model = z.string().min(1).max(200).refine(value=>value.trim()===value&&!/[\u0000-\u001f\u007f-\u009f]/u.test(value));
// Endpoints are already normalized by Agent settings. This syntax check never
// resolves a host, reads a credential, or authorizes network access.
const destination = z.string().min(1).max(2080).refine(value=>{
  if(/[\s\\%?#@\u0000-\u001f\u007f-\u009f]/u.test(value))return false;
  try{
    const url=new URL(value);
    return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password&&!url.search&&!url.hash&&
      `${url.origin}${url.pathname}`===value&&/^\/[A-Za-z0-9/_~.\-]*$/u.test(url.pathname)&&
      !/\/{2}|(?:^|\/)\.{1,2}(?:\/|$)/u.test(url.pathname)&&
      /\/(?:responses|chat\/completions)$/u.test(url.pathname);
  }catch{return false;}
});
export const agentAuthorizationTargetSchema=z.object({destination,model,scope:agentAuthorizationScopeSchema}).strict();
export const agentAuthorizationCurrentTargetSchema=z.object({destination,model,settingsRevision:revision}).strict();
export const agentAuthorizationRecordSchema=agentAuthorizationTargetSchema.extend({id:z.string().uuid(),createdAt:z.string().datetime()}).strict();
export const agentAuthorizationSnapshotSchema=z.object({revision,scopes:z.array(agentAuthorizationScopeSchema).max(6)}).strict();
export const agentAuthorizationListSchema=z.object({revision,currentTarget:agentAuthorizationCurrentTargetSchema,
  authorizations:z.array(agentAuthorizationRecordSchema).max(AGENT_AUTHORIZATION_LIMITS.grants)}).strict();
export const agentAuthorizationSchemas={
  'agent.authorization.list':z.object({}).strict(),
  'agent.authorization.grant':agentAuthorizationTargetSchema.extend({requestId,expectedRevision:revision,expectedSettingsRevision:revision}).strict(),
  'agent.authorization.revoke':z.object({requestId,expectedRevision:revision,authorizationId:z.string().uuid()}).strict(),
};
export const agentAuthorizationDescriptions={
  'agent.authorization.list':'List this workspace\'s persistent Agent destination/model/scope authorizations and current safe target; no provider call or credential access.',
  'agent.authorization.grant':'Explicitly authorize the current Agent destination, model and one closed sending scope on this local workspace. Requires settings and authorization revisions plus a stable requestId; does not send a message.',
  'agent.authorization.revoke':'Revoke one persistent Agent authorization under revision control and a stable requestId. Stops future model requests for this scope; does not recall an already sent request.',
};
export type AgentAuthorizationScope=z.infer<typeof agentAuthorizationScopeSchema>;
export type AgentAuthorizationTarget=z.infer<typeof agentAuthorizationTargetSchema>;
export type AgentAuthorizationRecord=z.infer<typeof agentAuthorizationRecordSchema>;
export type AgentAuthorizationCurrentTarget=z.infer<typeof agentAuthorizationCurrentTargetSchema>;
export type AgentAuthorizationSnapshot=z.infer<typeof agentAuthorizationSnapshotSchema>;
export type AgentAuthorizationGrant=z.infer<typeof agentAuthorizationSchemas['agent.authorization.grant']>;
export type AgentAuthorizationRevoke=z.infer<typeof agentAuthorizationSchemas['agent.authorization.revoke']>;
export type AgentAuthorizationList=z.infer<typeof agentAuthorizationListSchema>;
export interface AgentAuthorizationReceipt{operation:'grant'|'revoke';requestId:string;revision:number;authorizationId:string}
export const agentAuthorizationReceiptSchema=z.object({operation:z.enum(['grant','revoke']),requestId,revision:revision.min(1),authorizationId:z.string().uuid()}).strict();
export const agentAuthorizationDiskSchema=z.object({version:z.literal(1),workspaceScope:z.string().regex(/^[a-f0-9]{64}$/u),revision,
  authorizations:z.array(agentAuthorizationRecordSchema).max(AGENT_AUTHORIZATION_LIMITS.grants),
  requests:z.array(z.object({requestId,digest:z.string().regex(/^[a-f0-9]{64}$/u),receipt:agentAuthorizationReceiptSchema}).strict()).max(AGENT_AUTHORIZATION_LIMITS.requests)}).strict();
export type AgentAuthorizationDisk=z.infer<typeof agentAuthorizationDiskSchema>;
