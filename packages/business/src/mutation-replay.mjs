import {AppError,publicValue,LOCAL_MUTATION_OPERATIONS} from '@mioon/contracts';
import {isAsyncFunction,isPromise} from 'node:util/types';

const definite=new Set(['NOT_FOUND','REVISION_CONFLICT','INVALID_ORDER','ASSET_REQUIRED','INVALID_NODE_ASSET','REFERENCE_CONNECTED']);
function synchronous(callback,...args) {
 const result=callback(...args);
 if(result&&typeof result.then==='function'){
  if(isPromise(result))result.catch(()=>{});
  throw new TypeError('Mutation transactions require synchronous callbacks');
 }
 return result;
}

// A single global key space for the explicitly supported local mutations. Keep
// the canonical caller input, without inserting defaults or normalizing intent.
// resolve/validate/apply/replay are synchronous and run under one write lock.
export function createMutationReplay(store,{canonical}) {
 const {db,tx}=store;
 const conflict=requestId=>{throw new AppError('IDEMPOTENCY_CONFLICT','同一请求 ID 已用于不同操作、项目或内容',409,{requestId});};
 return function mutation(operation,input,{resolve,validate,apply,replay}) {
  if(!LOCAL_MUTATION_OPERATIONS.includes(operation))throw new AppError('UNKNOWN_OPERATION','此操作不支持本地变更重放',404);
  if([resolve,validate,apply,replay].some(callback=>callback&&isAsyncFunction(callback)))
   throw new TypeError('Mutation transactions require synchronous callbacks');
  const {requestId,...fields}=input;
  const canonicalInput=requestId===undefined?null:canonical(fields);
  let absent=false;
  try {
   return tx(()=>{
    const prior=requestId===undefined?null:db.prepare('SELECT operation,projectId,canonicalInput,response FROM mutation_requests WHERE requestId=?').get(requestId);
    absent=requestId!==undefined&&!prior;
    if(prior&&(prior.operation!==operation||prior.canonicalInput!==canonicalInput))conflict(requestId);
    const context=synchronous(resolve);
    if(prior&&prior.projectId!==context.projectId)conflict(requestId);
    if(validate)synchronous(validate,context);
    if(prior){
     const response=JSON.parse(prior.response);
     // Recheck current target ownership, including targets created by this key.
     // A retained receipt cannot authorize returning a deleted or foreign row.
     synchronous(replay,response,context);
     return response;
    }
    const response=synchronous(apply,context);
    if(requestId===undefined)return response;
    const serialized=JSON.stringify(publicValue(response));
    db.prepare('INSERT INTO mutation_requests(requestId,operation,projectId,canonicalInput,response) VALUES(?,?,?,?,?)')
     .run(requestId,operation,context.projectId,canonicalInput,serialized);
    return JSON.parse(serialized);
   });
  }catch(error){
   // Only definite, fresh-key business rejections may release a client receipt.
   // No prior receipt, ownership/policy failure, or untyped database/network
   // error can be mistaken for proof that an earlier attempt never committed.
   if(absent&&!db.isTransaction&&error instanceof AppError&&definite.has(error.code))
    error.details={...error.details,mutationOutcome:'not_applied',requestId};
   throw error;
  }
 };
}
