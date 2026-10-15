/** Dormant Node-only candidate admission. No package export, storage or dispatch. */
import {isProxy} from 'node:util/types';
import {createHash} from 'node:crypto';
import {schemas} from './index.mjs';
import {isEditTask, EDIT_TASK_LIMITS} from './edit-tasks.mjs';
import {validateVolumeEnvelope} from './timeline-volume-envelope.mjs';

const own = (v,k) => Object.hasOwn(v,k);
const fail = (code='INVALID_VOLUME_ENVELOPE_CANDIDATE') => {throw Object.assign(new Error('Invalid dormant envelope candidate.'),{code});};
const operations = ['timeline.clip.add','timeline.clip.update'];
// Deliberately NOT a generic array switch. The one permitted path is selected
// from the known operation, then the complete typed envelope is validated.
function capture(value, arrayPath, path=[], depth=0, budget={nodes:0,depth:0}) {
 if (++budget.nodes>128 || depth>8) fail();
 budget.depth=Math.max(budget.depth,depth);
 if(value===null || typeof value==='boolean')return value;
 if(typeof value==='number'){if(!Number.isFinite(value)||Object.is(value,-0))fail();return value;}
 if(typeof value==='string'){if(value.length>8192||!value.isWellFormed())fail();return value;}
 if(!value||typeof value!=='object'||isProxy(value))fail();
 if(Array.isArray(value)){
  if(!arrayPath || path.join('.')!==arrayPath || Object.getPrototypeOf(value)!==Array.prototype)fail();
  const length=Object.getOwnPropertyDescriptor(value,'length');
  if(!length||!own(length,'value')||length.value<1||length.value>16)fail();
  const keys=Reflect.ownKeys(value);
  if(keys.length!==length.value+1)fail();
  const out=[];
  for(let i=0;i<length.value;i++){
   const d=Object.getOwnPropertyDescriptor(value,String(i));
   if(!d?.enumerable||!own(d,'value'))fail();
   out.push(capture(d.value,arrayPath,[...path,String(i)],depth+1,budget));
  }
  return out;
 }
 if(![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail();
 const out={};
 for(const key of Reflect.ownKeys(value)){
  const d=Object.getOwnPropertyDescriptor(value,key);
  if(typeof key!=='string'||key==='__proto__'||!d?.enumerable||!own(d,'value'))fail();
  out[key]=capture(d.value,arrayPath,[...path,key],depth+1,budget);
 }
 return out;
}
function historicalProjection(operation,input){
 const projected={...input};
 const fields=operation==='timeline.clip.add'?projected:(projected.patch={...input.patch});
 delete fields.volumeEnvelope;
 // This sentinel is ONLY for the existing nonempty patch refinement. It is
 // never returned, hashed, stored, dispatched or used to change a clip.
 if(operation==='timeline.clip.update'&&own(input.patch,'volumeEnvelope')&&!Object.keys(fields).length)fields.gain=0;
 return projected;
}
export function captureVolumeEnvelopeCandidateIntent(operation,value,context={}){
 if(!operations.includes(operation))fail();
 const checkedContext=capture(context,null);
 if(!checkedContext||typeof checkedContext!=='object'||Object.keys(checkedContext).some(key=>key!=='durationFrames')||own(checkedContext,'durationFrames')&&(!Number.isSafeInteger(checkedContext.durationFrames)||checkedContext.durationFrames<1||checkedContext.durationFrames>18000))fail();
 const {durationFrames}=checkedContext;
 const budget={nodes:0,depth:0};
 const input=capture(value,operation==='timeline.clip.add'?'volumeEnvelope.points':'patch.volumeEnvelope.points',[],0,budget);
 const fields=operation==='timeline.clip.add'?input:input?.patch;
 if(!fields||typeof fields!=='object'||Array.isArray(fields))fail();
 const duration=own(fields,'durationFrames')?fields.durationFrames:durationFrames;
 if(own(fields,'volumeEnvelope')){
  // Null is shape-preserving clear; non-null update needs resulting duration.
  if(fields.volumeEnvelope!==null)validateVolumeEnvelope(fields.volumeEnvelope,duration);
 }
 if(!schemas[operation].safeParse(historicalProjection(operation,input)).success)fail();
 const text=JSON.stringify(input),bytes=Buffer.byteLength(text);
 if(bytes>EDIT_TASK_LIMITS.inputBytes)fail('VOLUME_ENVELOPE_CANDIDATE_INTENT_BUDGET');
 return {input,text,bytes,nodes:budget.nodes,depth:budget.depth};
}
// Candidate-specific digest domain prevents accidental historical ledger reuse.
function digest(operation,input){
 const canonical=JSON.stringify({profile:'dormant-volume-envelope-intent-v1',operation,input},(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
 return createHash('sha256').update(canonical).digest('hex');
}
export function volumeEnvelopeCandidateIntentDigest(operation,input,context){
 return digest(operation,captureVolumeEnvelopeCandidateIntent(operation,input,context).input);
}
/** Complete candidate task guard, NOT an admission gate for the live ledger.
 * Digest includes exact absent/null/value identity and all original input keys. */
export function isVolumeEnvelopeCandidateEditTask(value,context){
 try{
  // Inspect root before selecting input, including any hostile accessor/proxy.
  if(!value||typeof value!=='object'||isProxy(value)||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return false;
  const shell={};let input;
  for(const key of Reflect.ownKeys(value)){
   const d=Object.getOwnPropertyDescriptor(value,key);
   if(typeof key!=='string'||key==='__proto__'||!d?.enumerable||!own(d,'value'))return false;
   if(key==='input')input=d.value;else shell[key]=d.value;
  }
  const task=capture(shell,null);
  const captured=captureVolumeEnvelopeCandidateIntent(task.operation,input,context);
  task.input=captured.input;
  if(Buffer.byteLength(JSON.stringify(task))>EDIT_TASK_LIMITS.rowBytes||task.digest!==digest(task.operation,task.input))return false;
  return isEditTask({...task,input:historicalProjection(task.operation,task.input)});
 }catch{return false;}
}
