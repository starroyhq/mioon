import {usesAssetAnnotationSchema} from './workspace-schema-dispatch.ts';
import {refuseRestoredOperation} from './workspace-restore-policy.ts';
import {AppError,publicValue,LOCAL_MUTATION_OPERATIONS,SUBJECT_MUTATION_OPERATIONS} from '@mioon/contracts';
import {isAsyncFunction,isPromise} from 'node:util/types';
import type {DatabaseSync} from 'node:sqlite';

const definite=new Set(['NOT_FOUND','REVISION_CONFLICT','INVALID_ORDER','ASSET_REQUIRED','INVALID_NODE_ASSET','INVALID_NODE_PATCH','REFERENCE_CONNECTED','SOURCE_BOUNDS','SOURCE_RANGE_UNSUPPORTED','RANGE_REVISION_LIMIT','DISPOSITION_REVISION_LIMIT','ANNOTATION_REVISION_LIMIT','SUBJECT_NO_CHANGE','SUBJECT_REVISION_LIMIT','SUBJECT_BINDING_LIMIT','SUBJECT_ROLE_MISMATCH','SUBJECT_VERSION_HIDDEN']);
export interface MutationReplayStore {
 readonly db: DatabaseSync;
 tx<T>(callback: () => T): T;
}
export interface MutationContext { readonly projectId: string; readonly [key: string]: unknown }
export interface MutationCallbacks<T extends MutationContext, R> {
 readonly resolve: () => T;
 readonly validate?: (context: T) => void;
 readonly apply: (context: T) => R;
 readonly replay: (response: unknown, context: T) => unknown;
 readonly verify?: (response: unknown, context: T) => void;
}
export type MutationInput=object;
export type MutationReplay=(operation: string, input: MutationInput, callbacks: MutationCallbacks<MutationContext, unknown>) => unknown;

function synchronous<T>(callback: () => T): T;
function synchronous<T, A>(callback: (argument: A) => T, argument: A): T;
function synchronous<T, A, B>(callback: (first: A, second: B) => T, first: A, second: B): T;
function synchronous<T>(callback: (...args: unknown[]) => T, ...args: unknown[]): T {
 const result=callback(...args);
 if(isThenable(result)){
  if(isPromise(result))Promise.resolve(result).catch(()=>{});
  throw new TypeError('Mutation transactions require synchronous callbacks');
 }
 return result;
}
const isThenable=(value: unknown): value is PromiseLike<unknown>=>value!==null&&(typeof value==='object'||typeof value==='function')&&typeof (value as {then?: unknown}).then==='function';
const includesString=(list: readonly string[],value: string): boolean=>(list as readonly string[]).includes(value);
const detailObject=(value: unknown): object=>value!==null&&typeof value==='object'?value:Object(value);

// A single global key space for the explicitly supported local mutations. Keep
// the canonical caller input, without inserting defaults or normalizing intent.
// resolve/validate/apply/replay are synchronous and run under one write lock.
export const NO_MUTATION_REPLAY=Symbol('no-mutation-replay');
export function createMutationReplay(store: MutationReplayStore,{canonical,readOnly=false}: {canonical: (value: unknown) => string; readOnly?: boolean}) {
 const {db,tx}=store;
 const conflict=(requestId: unknown): never=>{throw new AppError('IDEMPOTENCY_CONFLICT','同一请求 ID 已用于不同操作、项目或内容',409,{requestId});};
 const transaction: <T>(callback: () => T) => T=readOnly?callback=>{if(db.isTransaction)return callback();db.exec('BEGIN');try{const value=callback();db.exec('COMMIT');return value;}catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}}:tx;
 return function mutation<T extends MutationContext, R>(operation: string, input: MutationInput, {resolve,validate,apply,replay,verify}: MutationCallbacks<T,R>): R | unknown {
  if(!readOnly)refuseRestoredOperation(store,operation,input as Record<string, unknown>);
  if(!includesString(LOCAL_MUTATION_OPERATIONS,operation))throw new AppError('UNKNOWN_OPERATION','此操作不支持本地变更重放',404);
  if([resolve,validate,apply,replay,verify].some(callback=>callback&&isAsyncFunction(callback)))
   throw new TypeError('Mutation transactions require synchronous callbacks');
  const record=input as Record<string, unknown>,requestId=record.requestId,fields: Record<string, unknown>=Object.fromEntries(Object.entries(record).filter(([key])=>key!=='requestId'));
  const subjectMutation=includesString(SUBJECT_MUTATION_OPERATIONS,operation);
  const receiptTable=operation==='asset.annotation.set'?'asset_annotation_requests':subjectMutation?'subject_requests':operation==='asset.disposition.set'?'asset_disposition_requests':operation==='asset.range.set'?'asset_range_requests':'mutation_requests';
  if(operation==='asset.range.set'&&requestId===undefined)throw new AppError('VALIDATION_ERROR','素材范围保存需要稳定请求 ID');
  if(operation==='asset.disposition.set'&&requestId===undefined)throw new AppError('VALIDATION_ERROR','素材标记保存需要稳定请求 ID');
  if(operation==='asset.annotation.set'&&requestId===undefined)throw new AppError('VALIDATION_ERROR','素材备注保存需要稳定请求 ID');
  if(subjectMutation&&requestId===undefined)throw new AppError('VALIDATION_ERROR','主体变更需要稳定请求 ID');
  const canonicalInput=requestId===undefined?null:canonical(fields);
  let absent=false;
  try {
   return transaction((): R | unknown=>{
    // Subject replay must pass ownership gates before any retained receipt is used.
    const subjectContext: T | null=subjectMutation?synchronous(resolve):null;
    const receiptIdentity=(subjectMutation||operation==='asset.annotation.set')?`CASE WHEN length(CAST(operation AS BLOB)) BETWEEN 1 AND 80 THEN operation END AS operation,CASE WHEN length(CAST(projectId AS BLOB))=36 THEN projectId END AS projectId`:'operation,projectId';
    const legacyReceiptColumns=(subjectMutation||operation==='asset.annotation.set')?`
     CASE WHEN length(CAST(operation AS BLOB)) BETWEEN 1 AND 80 THEN operation END AS operation,
     CASE WHEN length(CAST(projectId AS BLOB))=36 THEN projectId END AS projectId,
     CASE WHEN length(CAST(canonicalInput AS BLOB)) BETWEEN 1 AND 8192 THEN canonicalInput END AS canonicalInput,
     CASE WHEN length(CAST(response AS BLOB)) BETWEEN 1 AND 16384 THEN response END AS response`:'operation,projectId,canonicalInput,response';
    const annotations=usesAssetAnnotationSchema(db);
    const requestKey=requestId as string;
    const receipts=requestId===undefined?[]:db.prepare(`
     SELECT 'mutation_requests' AS receiptTable,${legacyReceiptColumns} FROM mutation_requests WHERE requestId=?
     UNION ALL
     SELECT 'asset_range_requests' AS receiptTable,${legacyReceiptColumns} FROM asset_range_requests WHERE requestId=?
     UNION ALL
     SELECT 'asset_disposition_requests' AS receiptTable,${receiptIdentity},
      CASE WHEN length(CAST(canonicalInput AS BLOB)) BETWEEN 1 AND 4096 THEN canonicalInput END AS canonicalInput,
      CASE WHEN length(CAST(response AS BLOB)) BETWEEN 1 AND 4096 THEN response END AS response
      FROM asset_disposition_requests WHERE requestId=?
     UNION ALL
     SELECT 'subject_requests' AS receiptTable,${receiptIdentity},
      CASE WHEN length(CAST(canonicalInput AS BLOB)) BETWEEN 1 AND 8192 THEN canonicalInput END AS canonicalInput,
      CASE WHEN length(CAST(response AS BLOB)) BETWEEN 1 AND 16384 THEN response END AS response
      FROM subject_requests WHERE requestId=?
     ${annotations?`UNION ALL SELECT 'asset_annotation_requests' AS receiptTable,
      CASE WHEN typeof(operation)='text' AND length(CAST(operation AS BLOB)) BETWEEN 1 AND 80 THEN operation END AS operation,
      CASE WHEN typeof(projectId)='text' AND length(CAST(projectId AS BLOB))=36 THEN projectId END AS projectId,
      CASE WHEN length(CAST(canonicalInput AS BLOB)) BETWEEN 1 AND 24576 THEN canonicalInput END AS canonicalInput,
      CASE WHEN length(CAST(response AS BLOB)) BETWEEN 1 AND 24576 THEN response END AS response
      FROM asset_annotation_requests WHERE requestId=?`:''}
    `).all(requestKey,requestKey,requestKey,requestKey,...annotations?[requestKey]:[]);
    absent=requestId!==undefined&&receipts.length===0;
    // Duplicate presence and a receipt in the wrong companion fail closed even
    // if a damaged database presents otherwise identical operation/input bytes.
    if(receipts.length>1)conflict(requestId);
    const prior=receipts[0];
    if(prior&&(prior.receiptTable!==receiptTable||prior.operation!==operation||prior.canonicalInput!==canonicalInput))conflict(requestId);
    const context: T=subjectContext||synchronous(resolve);
    if(prior&&prior.projectId!==context.projectId)conflict(requestId);
    if(validate)synchronous(validate,context);
    if(prior){
     let response: unknown;
     try{response=JSON.parse(String(prior.response));}catch(error){
      if(subjectMutation)throw new AppError('INVALID_SUBJECT_RECORD','主体或关联状态不一致，请先检查项目',409);
      if(operation==='asset.annotation.set')throw new AppError('INVALID_ASSET_ANNOTATION_RECORD','素材备注或关联状态不一致，请先检查项目',409);
      if(operation==='asset.disposition.set')throw new AppError('INVALID_ASSET_DISPOSITION_RECORD','素材标记或关联状态不一致，请先检查项目',409);
      throw error;
     }
     // Recheck current target ownership, including targets created by this key.
     // A retained receipt cannot authorize returning a deleted or foreign row.
     synchronous(replay,response,context);
     return response;
    }
    if(readOnly)return NO_MUTATION_REPLAY;
    refuseRestoredOperation(store,operation,input as Record<string, unknown>);
    const response=synchronous(apply,context);
    if(requestId===undefined)return response;
    const serialized=JSON.stringify(publicValue(response));
    db.prepare(`INSERT INTO ${receiptTable}(requestId,operation,projectId,canonicalInput,response) VALUES(?,?,?,?,?)`)
     .run(requestId as string,operation,context.projectId,canonicalInput,serialized);
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
   if(!readOnly&&absent&&!db.isTransaction&&error instanceof AppError&&definite.has(error.code)&&
      !((['asset.range.set','asset.disposition.set','asset.annotation.set'].includes(operation)||subjectMutation)&&error.code==='NOT_FOUND'))
    error.details={...detailObject(error.details),mutationOutcome:'not_applied',requestId,...(subjectMutation?{operation,projectId:(input as Record<string,unknown>).projectId}:{})};
   throw error;
  }
 };
}
