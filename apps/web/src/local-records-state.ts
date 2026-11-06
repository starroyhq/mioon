import type {LocalRecord, LocalRecordsDeleteInput, LocalRecordsListResponse} from '../../../packages/contracts/src/local-record-operations.ts';
import {LocalRecordsRequestError} from './local-records-client.ts';
import type {LocalRecordsClient} from './local-records-client.ts';

export interface LocalRecordsState {
  readonly active: boolean;
  readonly loading: boolean;
  readonly list: LocalRecordsListResponse | null;
  readonly readError: string | null;
  readonly selected: LocalRecord | null;
  readonly deleting: boolean;
  readonly notice: {readonly code:string; readonly outcomeUnknown:boolean} | null;
}
/** A confirmation owns the exact list snapshot. Reading a new snapshot or
 * hiding the panel cancels that confirmation; it never repairs its identity. */
export function createLocalRecordsController(client: LocalRecordsClient) {
  let state: LocalRecordsState = {active:false,loading:false,list:null,readError:null,selected:null,deleting:false,notice:null};
  let epoch = 0, read: AbortController | undefined, disposed = false;
  let intent: LocalRecordsDeleteInput | undefined;
  let notice: {identity:LocalRecordsDeleteInput;value:NonNullable<LocalRecordsState['notice']>} | undefined;
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<LocalRecordsState>): void => {if (!disposed) {state = {...state,...patch}; for (const listener of listeners) listener();}};
  async function refresh(): Promise<void> {
    if (disposed || !state.active || state.deleting) return;
    read?.abort(); read = new AbortController(); const owner = ++epoch, signal = read.signal;
    intent = undefined; publish({loading:true,readError:null,selected:null,notice:null});
    try {const list = await client.list({signal}); if (!disposed && state.active && owner === epoch) publish({list,loading:false,notice:notice&&notice.identity.expectedAppLibraryScope===list.appLibraryScope&&notice.identity.expectedInstanceId===list.instanceId?notice.value:null});}
    catch (error) {if (!disposed && state.active && owner === epoch) publish({list:null,loading:false,readError:error instanceof LocalRecordsRequestError ? error.code : 'BACKEND_UNAVAILABLE'});}
  }
  return {
    getSnapshot: (): LocalRecordsState => state,
    subscribe(listener: () => void): () => void {listeners.add(listener);return () => {listeners.delete(listener);};},
    activate(active: boolean): void {
      if (disposed || active === state.active) return;
      ++epoch;read?.abort();intent = undefined;publish({active,loading:false,selected:null});
      if (active) void refresh();
    },
    refresh,
    select(projectId: string): void {
      if (!state.active || state.loading || state.deleting || state.readError || !state.list) return;
      const selected = state.list.records.find(item => item.projectId === projectId);
      if (!selected || selected.hasSuperJournal || selected.hasUnfinishedTasks) return;
      intent = {projectId,expectedAppLibraryScope:state.list.appLibraryScope,expectedInstanceId:state.list.instanceId};
      publish({selected});
    },
    cancel(): void {if (!state.deleting) {intent = undefined;publish({selected:null});}},
    async confirm(): Promise<void> {
      if (!state.active || state.deleting || !state.selected || !intent) return;
      const original = intent, owner = epoch;intent = undefined;notice = undefined;publish({deleting:true,notice:null});
      let outcome: NonNullable<LocalRecordsState['notice']>;
      try {await client.delete(original);outcome = {code:'DELETED',outcomeUnknown:false};}
      catch (error) {outcome = {code:error instanceof LocalRecordsRequestError ? error.code : 'BACKEND_UNAVAILABLE',outcomeUnknown:error instanceof LocalRecordsRequestError ? error.outcomeUnknown : true};}
      // A hidden/replaced page cannot inherit a late success or rejection. An
      // uncertain attempt may reappear only after a fresh list proves its pair.
      if (owner === epoch && state.active || outcome.outcomeUnknown) notice = {identity:original,value:outcome};
      if (owner === epoch && state.active) publish({notice:outcome});
      publish({deleting:false,selected:null});if (state.active) await refresh();
    },
    dispose(): void {disposed = true;++epoch;read?.abort();intent = undefined;listeners.clear();},
  };
}
