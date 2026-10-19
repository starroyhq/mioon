import {AsyncLocalStorage} from 'node:async_hooks';
// A private coordinator dispatch context, never RPC input or a caller option.
// The domain re-reads and validates this exact durable claim before exemption.
const executing=new AsyncLocalStorage();
export function withTimelineFormatTaskDispatch(db,row,dispatch){
 return executing.run(Object.freeze({db,id:row.id,claim:row.claim,claimInstance:row.claimInstance}),dispatch);
}
export const executingTimelineFormatTask=db=>{const value=executing.getStore();return value?.db===db?value:null;};
