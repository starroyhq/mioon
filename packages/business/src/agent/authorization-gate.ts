import type {AgentConfiguration} from './config.ts';

export interface ChatAuthorizations {
  assertAuthorized(input: {destination: string; model: string; scope: string}): void;
  snapshot(configuration: AgentConfiguration): unknown;
}
