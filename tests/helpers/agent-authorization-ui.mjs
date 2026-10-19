import {randomUUID} from 'node:crypto';
import {deriveAgentEndpoint} from '../../packages/contracts/src/agent-protocol.ts';

/** Transport-only mock: retained destination/model/scope metadata follows the
 * same grant identity. Domain/runtime tests use the real private sidecar. */
export function createAgentAuthorizationUiMock(read){
  const granted=new Map();let revision=0;
  const key=snapshot=>JSON.stringify([deriveAgentEndpoint(snapshot.settings.configuration),snapshot.settings.configuration.model]);
  return {
    async read(...args){
      const snapshot=await read(...args);if(!snapshot?.settings?.configuration)return snapshot;
      const scopes=granted.get(key(snapshot))||snapshot.authorization?.scopes||[];
      return {...snapshot,authorization:{revision,scopes:[...scopes]}};
    },
    async authorize(snapshot,scope,requestId){
      const target=key(snapshot),scopes=granted.get(target)||[];
      granted.set(target,[...new Set([...scopes,scope])]);
      return {operation:'grant',requestId,revision:++revision,authorizationId:randomUUID()};
    },
  };
}
