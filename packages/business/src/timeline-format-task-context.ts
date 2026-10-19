import {AsyncLocalStorage} from 'node:async_hooks';
import type {DatabaseSync} from 'node:sqlite';

interface TimelineFormatTaskRow {id: string; claim: string|null; claimInstance: string|null}
interface TimelineFormatTaskDispatch {readonly db: DatabaseSync; readonly id: string; readonly claim: string|null; readonly claimInstance: string|null}
// A private coordinator dispatch context, never RPC input or a caller option.
// The domain re-reads and validates this exact durable claim before exemption.
const executing=new AsyncLocalStorage<TimelineFormatTaskDispatch>();
export function withTimelineFormatTaskDispatch<T>(db: DatabaseSync,row: TimelineFormatTaskRow,dispatch: ()=>T): T{
 return executing.run(Object.freeze({db,id:row.id,claim:row.claim,claimInstance:row.claimInstance}),dispatch);
}
export const executingTimelineFormatTask=(db: DatabaseSync): TimelineFormatTaskDispatch|null=>{const value=executing.getStore();return value?.db===db?value:null;};
