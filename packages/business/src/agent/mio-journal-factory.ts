import type {AgentPolicyStore} from '../app-db/stores.ts';
import type {ProjectStore} from '../project-file/store.ts';
import {createAgentTaskJournal} from './task-journal-v2.ts';
import {createMioJournal} from './mio-journal.ts';

/** S0 owns the application policy CAS and immutable receipts. Reuse only
 * those methods of its facade; project records always use MioJournal. */
export function createMioProjectJournal(store: ProjectStore, policyStore: AgentPolicyStore | undefined) {
  if (!policyStore) throw Object.assign(new Error('The application policy port is required.'), {code: 'AGENT_TASK_POLICY_STORE_REQUIRED'});
  const policy = createAgentTaskJournal(store, {policyStore});
  return createMioJournal(store, {
    policy: () => policy.policy(),
    lookupPolicy: id => policy.lookupPolicy(id),
    updatePolicy: (input, id) => policy.updatePolicy(input, id),
  });
}
