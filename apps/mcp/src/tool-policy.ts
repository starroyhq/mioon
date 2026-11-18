/** These operations require a user-owned entry, never a model tool call. Keep
 * explicit names: a new operation must be classified by the parity audit. */
export const MCP_USER_ONLY_OPERATIONS = Object.freeze([
  'agent.authorization.list','agent.authorization.grant','agent.authorization.revoke',
  'asset.media.outside.confirm','asset.media.outside.revoke',
  'project.create','project.list','project.get','project.summary.list','project.delete',
  'project.backup.restore','project.version.restore',
] as const);
export function isMcpOperationAllowed(operation:string):boolean{
  return !(MCP_USER_ONLY_OPERATIONS as readonly string[]).includes(operation);
}
export function mcpOperationCatalog<C extends {operations:readonly {operation:string}[]}>(catalog:C):C{
  return {...catalog,operations:catalog.operations.filter(item=>isMcpOperationAllowed(item.operation))};
}
