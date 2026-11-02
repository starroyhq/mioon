import type {DatabaseSync} from 'node:sqlite';

/** The ordinary format-72 derivation imports the row validator. Keep this
 * routing leaf independent of kernel manifests, openers and application DDL. */
export interface AgentTaskRowValidationContext {
  readonly application: DatabaseSync;
  readonly assertAvailable: () => void;
  readonly foreignKeysValid: () => boolean;
  readonly validateRows: (options: {readonly maxBytes?: number}) => void;
}
const contexts = new WeakMap<DatabaseSync, AgentTaskRowValidationContext>();

/** Internal assembly entry point; the source guard restricts it to the actual
 * project/application adapter. No map or mutable registry entry escapes. */
export function registerAgentTaskRowValidationContext(db: DatabaseSync, context: AgentTaskRowValidationContext): () => void {
  if (contexts.has(db)) throw new TypeError('Agent task row validation is already bound');
  const held = Object.freeze({...context});
  contexts.set(db, held);
  return () => {if (contexts.get(db) === held) contexts.delete(db);};
}
export function agentTaskRowValidationContext(db: DatabaseSync): AgentTaskRowValidationContext | undefined {
  const context = contexts.get(db);
  context?.assertAvailable();
  return context;
}
