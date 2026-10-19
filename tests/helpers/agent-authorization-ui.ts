import {randomUUID} from 'node:crypto';
import {deriveAgentEndpoint} from '../../packages/contracts/src/agent-protocol.ts';

/** Transport-only mock: retained destination/model/scope metadata follows the
 * same grant identity. Domain/runtime tests use the real private sidecar. */
interface AgentSettingsConfiguration {readonly model?: string; readonly [key: string]: unknown}
interface AgentAuthorizationSnapshot {readonly settings?: {readonly configuration?: AgentSettingsConfiguration; readonly [key: string]: unknown}; readonly authorization?: {readonly scopes?: readonly string[]; readonly [key: string]: unknown}; readonly [key: string]: unknown}
type AgentRead = (...args: unknown[]) => Promise<AgentAuthorizationSnapshot|unknown>
export function createAgentAuthorizationUiMock(read: AgentRead) {
  const granted=new Map();let revision=0;
  const key=(snapshot: AgentAuthorizationSnapshot): string=>JSON.stringify([deriveAgentEndpoint(snapshot.settings?.configuration as never),snapshot.settings?.configuration?.model]);
  return {
    async read(...args: unknown[]){
      const snapshot=(await read(...args)) as AgentAuthorizationSnapshot;if(!snapshot?.settings?.configuration)return snapshot;
      const scopes=granted.get(key(snapshot))||snapshot.authorization?.scopes||[];
      return {...snapshot,authorization:{revision,scopes:[...scopes]}};
    },
    async authorize(snapshot: AgentAuthorizationSnapshot,scope: string,requestId: string){
      const target=key(snapshot),scopes=granted.get(target)||[];
      granted.set(target,[...new Set([...scopes,scope])]);
      return {operation:'grant',requestId,revision:++revision,authorizationId:randomUUID()};
    },
  };
}
