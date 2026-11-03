import {isDeepStrictEqual} from 'node:util';
import {mioRuleWriteSchema} from '../../../contracts/src/mio-rule-writes.ts';
import type {MioRuleWrite} from '../../../contracts/src/mio-rule-writes.ts';
import {mioIdentitySchemas} from '../../../contracts/src/mio-records.ts';
import {isProjectStore} from '../project-file/store.ts';
import type {ProjectStore} from '../project-file/store.ts';

const identities=['requestId','projectId','actor','runId','stepId','digest','approvalReceiptId','expectedExists','beforeHash','afterHash','beforeBlobHash','afterBlobHash','fixedRelativeName','createdAt'] as const;
const states:Readonly<Record<MioRuleWrite['state'],readonly MioRuleWrite['state'][]>>={
 prepared:['publication_unknown','published','not_applied'],publication_unknown:['published','not_applied'],published:['trust_pending','completed'],trust_pending:['completed'],completed:[],not_applied:[],
};
function fail(code:string):never{throw Object.assign(new Error(code),{code});}

/** The caller commits each checkpoint before touching the file or B1. No
 * arbitrary connection, cross-project lookup or implicit transaction escapes. */
export function createMioRuleWriteRepository(store:ProjectStore){
 if(!isProjectStore(store))throw new TypeError('Rule writes require a kernel project store');
 const {db,projectId}=store;let sequence=0;
 function write<T>(apply:()=>T):T{
  if(!db.isTransaction)return fail('AGENT_TASK_TRANSACTION_REQUIRED');
  const savepoint=`mio_rules_${++sequence}`;db.exec(`SAVEPOINT ${savepoint}`);
  try{const result=apply();db.exec(`RELEASE ${savepoint}`);return result;}
  catch(error){if(db.isTransaction)db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);throw error;}
 }
 function decode(row:Record<string,unknown>):MioRuleWrite{
  let fileIdentity:unknown=null;
  try{fileIdentity=row.fileIdentity===null?null:JSON.parse(String(row.fileIdentity));}catch{return fail('AGENT_TASK_STORAGE_CORRUPT');}
  if(row.expectedExists!==0&&row.expectedExists!==1)return fail('AGENT_TASK_STORAGE_CORRUPT');
  const parsed=mioRuleWriteSchema.safeParse({...row,expectedExists:row.expectedExists===1,fileIdentity});
  return parsed.success?parsed.data:fail('AGENT_TASK_STORAGE_CORRUPT');
 }
 function get(requestId:string):MioRuleWrite|null{
  mioIdentitySchemas.requestId.parse(requestId);
  const row=db.prepare('SELECT * FROM mio_rule_writes WHERE projectId=? AND requestId=?').get(projectId,requestId);
  return row?decode(row):null;
 }
 function listPending():MioRuleWrite[]{
  return db.prepare("SELECT * FROM mio_rule_writes WHERE projectId=? AND state NOT IN ('completed','not_applied') ORDER BY createdAt,requestId").all(projectId).map(decode);
 }
 function prepare(input:MioRuleWrite):MioRuleWrite{
  const record=mioRuleWriteSchema.parse(input);
  if(record.projectId!==projectId||record.state!=='prepared')return fail('MIO_RULES_INVALID');
  return write(()=>{
   const previous=get(record.requestId);
   if(previous){
    if(identities.some(key=>!isDeepStrictEqual(previous[key],record[key]))||previous.fileIdentity!==null&&record.fileIdentity!==null&&(previous.fileIdentity.candidateName!==record.fileIdentity.candidateName||previous.fileIdentity.backupName!==record.fileIdentity.backupName))return fail('MIO_RULES_REQUEST_CONFLICT');
    return previous;
   }
   const columns=[...identities,'fileIdentity','state','updatedAt'] as const;
   const values=columns.map(key=>key==='fileIdentity'?(record.fileIdentity===null?null:JSON.stringify(record.fileIdentity)):key==='expectedExists'?(record.expectedExists?1:0):record[key]);
   db.prepare(`INSERT INTO mio_rule_writes(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).run(...values);
   return get(record.requestId)!;
  });
 }
 function transition(requestId:string,expectedState:MioRuleWrite['state'],nextState:MioRuleWrite['state'],checkpoint:{readonly fileIdentity?:MioRuleWrite['fileIdentity'];readonly updatedAt:string}):MioRuleWrite{
  return write(()=>{
   const current=get(requestId);if(!current)return fail('AGENT_TASK_NOT_FOUND');
   if(current.state!==expectedState||['completed','not_applied'].includes(current.state)||current.state!==nextState&&!states[current.state].includes(nextState))return fail('MIO_RULES_STATE_CONFLICT');
   const updated=mioRuleWriteSchema.parse({...current,state:nextState,updatedAt:checkpoint.updatedAt,...(checkpoint.fileIdentity===undefined?{}:{fileIdentity:checkpoint.fileIdentity})});
   if(current.fileIdentity!==null&&(updated.fileIdentity===null||current.fileIdentity.candidateName!==updated.fileIdentity.candidateName||current.fileIdentity.backupName!==updated.fileIdentity.backupName||current.fileIdentity.directoryIdentity.dev!==updated.fileIdentity.directoryIdentity.dev||current.fileIdentity.directoryIdentity.ino!==updated.fileIdentity.directoryIdentity.ino))return fail('MIO_RULES_REQUEST_CONFLICT');
   db.prepare('UPDATE mio_rule_writes SET state=?,fileIdentity=?,updatedAt=? WHERE projectId=? AND requestId=? AND state=?').run(nextState,updated.fileIdentity===null?null:JSON.stringify(updated.fileIdentity),updated.updatedAt,projectId,requestId,expectedState);
   return get(requestId)!;
  });
 }
 return Object.freeze({get,listPending,prepare,transition});
}
export type MioRuleWriteRepository=ReturnType<typeof createMioRuleWriteRepository>;
