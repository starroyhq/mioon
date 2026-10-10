import {AppError,publicValue,LOCAL_MUTATION_OPERATIONS} from '@mioon/contracts';
import {isAsyncFunction,isPromise} from 'node:util/types';

const definite=new Set(['NOT_FOUND','REVISION_CONFLICT','INVALID_ORDER','ASSET_REQUIRED','INVALID_NODE_ASSET','REFERENCE_CONNECTED','SOURCE_BOUNDS','SOURCE_RANGE_UNSUPPORTED','RANGE_REVISION_LIMIT','DISPOSITION_REVISION_LIMIT']);
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
 return function mutation(operation,input,{resolve,validate,apply,replay,verify}) {
  if(!LOCAL_MUTATION_OPERATIONS.includes(operation))throw new AppError('UNKNOWN_OPERATION','此操作不支持本地变更重放',404);
  if([resolve,validate,apply,replay,verify].some(callback=>callback&&isAsyncFunction(callback)))
   throw new TypeError('Mutation transactions require synchronous callbacks');
  const {requestId,...fields}=input;
  const receiptTable=operation==='asset.disposition.set'?'asset_disposition_requests':operation==='asset.range.set'?'asset_range_requests':'mutation_requests';
  if(operation==='asset.range.set'&&requestId===undefined)throw new AppError('VALIDATION_ERROR','素材范围保存需要稳定请求 ID');
  if(operation==='asset.disposition.set'&&requestId===undefined)throw new AppError('VALIDATION_ERROR','素材标记保存需要稳定请求 ID');
  const canonicalInput=requestId===undefined?null:canonical(fields);
  let absent=false;
  try {
   return tx(()=>{
    const receipts=requestId===undefined?[]:db.prepare(`
     SELECT 'mutation_requests' AS receiptTable,operation,projectId,canonicalInput,response FROM mutation_requests WHERE requestId=?
     UNION ALL
     SELECT 'asset_range_requests' AS receiptTable,operation,projectId,canonicalInput,response FROM asset_range_requests WHERE requestId=?
     UNION ALL
     SELECT 'asset_disposition_requests' AS receiptTable,operation,projectId,
      CASE WHEN length(CAST(canonicalInput AS BLOB)) BETWEEN 1 AND 4096 THEN canonicalInput END AS canonicalInput,
      CASE WHEN length(CAST(response AS BLOB)) BETWEEN 1 AND 4096 THEN response END AS response
      FROM asset_disposition_requests WHERE requestId=?
    `).all(requestId,requestId,requestId);
    absent=requestId!==undefined&&receipts.length===0;
    // Duplicate presence and a receipt in the wrong companion fail closed even
    // if a damaged database presents otherwise identical operation/input bytes.
    if(receipts.length>1)conflict(requestId);
    const prior=receipts[0];
    if(prior&&(prior.receiptTable!==receiptTable||prior.operation!==operation||prior.canonicalInput!==canonicalInput))conflict(requestId);
    const context=synchronous(resolve);
    if(prior&&prior.projectId!==context.projectId)conflict(requestId);
    if(validate)synchronous(validate,context);
    if(prior){
     let response;
     try{response=JSON.parse(prior.response);}catch(error){
      if(operation==='asset.disposition.set')throw new AppError('INVALID_ASSET_DISPOSITION_RECORD','素材标记或关联状态不一致，请先检查项目',409);
      throw error;
     }
     // Recheck current target ownership, including targets created by this key.
     // A retained receipt cannot authorize returning a deleted or foreign row.
     synchronous(replay,response,context);
     return response;
    }
    const response=synchronous(apply,context);
    if(requestId===undefined)return response;
    const serialized=JSON.stringify(publicValue(response));
    db.prepare(`INSERT INTO ${receiptTable}(requestId,operation,projectId,canonicalInput,response) VALUES(?,?,?,?,?)`)
     .run(requestId,operation,context.projectId,canonicalInput,serialized);
    // New metadata aggregates can recheck retained ownership after both writes
    // (including database triggers), before the same transaction commits.
    if(verify)synchronous(verify,JSON.parse(serialized),context);
    return JSON.parse(serialized);
   });
  }catch(error){
   // Only definite, fresh-key business rejections may release a client receipt.
   // No prior receipt, ownership/policy failure, or untyped database/network
   // error can be mistaken for proof that an earlier attempt never committed.
   // An asset metadata scope denial is deliberately indistinguishable from absence. Keep
   // client recovery state on that error; preserve the original six semantics.
   if(absent&&!db.isTransaction&&error instanceof AppError&&definite.has(error.code)&&
      !(['asset.range.set','asset.disposition.set'].includes(operation)&&error.code==='NOT_FOUND'))
    error.details={...error.details,mutationOutcome:'not_applied',requestId};
   throw error;
  }
 };
}
