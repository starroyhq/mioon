/** Dormant Node-only candidate admission. No package export, storage or dispatch. */
import {isProxy} from 'node:util/types';
import {createHash} from 'node:crypto';
import {schemas} from '../../packages/contracts/src/index.ts';
import {isEditTask, EDIT_TASK_LIMITS} from '../../packages/contracts/src/edit-tasks.ts';
import {validateVolumeEnvelope} from '../../packages/contracts/src/timeline-volume-envelope.ts';

const own = (v: unknown,k: PropertyKey): boolean => Object.hasOwn(v as object,k);
function fail(code='INVALID_VOLUME_ENVELOPE_CANDIDATE'): never {throw Object.assign(new Error('Invalid dormant envelope candidate.'),{code});}
const operations = ['timeline.clip.add','timeline.clip.update'];
// Deliberately NOT a generic array switch. The one permitted path is selected
// from the known operation, then the complete typed envelope is validated.
interface CaptureBudget {nodes: number; depth: number}
export interface CapturedCandidateIntent {readonly input: unknown; readonly text: string; readonly bytes: number; readonly nodes: number; readonly depth: number}
function wellFormed(value: string): boolean { for (let index=0;index<value.length;index++){const code=value.charCodeAt(index); if(code>=0xD800&&code<=0xDBFF){const next=value.charCodeAt(index+1); if(!(next>=0xDC00&&next<=0xDFFF))return false; index++;} else if(code>=0xDC00&&code<=0xDFFF)return false;} return true; }
function capture(value: unknown, arrayPath: string|null, path: string[]=[], depth=0, budget: CaptureBudget={nodes:0,depth:0}): unknown {
 if (++budget.nodes>128 || depth>8) fail();
 budget.depth=Math.max(budget.depth,depth);
 if(value===null || typeof value==='boolean')return value;
 if(typeof value==='number'){if(!Number.isFinite(value)||Object.is(value,-0))fail();return value;}
 if(typeof value==='string'){if(value.length>8192||!wellFormed(value))fail();return value;}
 if(!value||typeof value!=='object'||isProxy(value))fail();
 if(Array.isArray(value)){
  if(!arrayPath || path.join('.')!==arrayPath || Object.getPrototypeOf(value)!==Array.prototype)fail();
  const lengthDescriptor=Object.getOwnPropertyDescriptor(value,'length') as {value?: unknown}|undefined;
  if(!lengthDescriptor||!own(lengthDescriptor,'value')||typeof lengthDescriptor.value!=='number')fail();
  const count=lengthDescriptor.value;
  if(count<1||count>16)fail();
  const keys=Reflect.ownKeys(value);
  if(keys.length!==count+1)fail();
  const out: unknown[]=[];
  for(let i=0;i<count;i++){
   const d=Object.getOwnPropertyDescriptor(value,String(i));
   if(!d?.enumerable||!own(d,'value'))fail();
   out.push(capture(d.value,arrayPath,[...path,String(i)],depth+1,budget));
  }
  return out;
 }
 if(![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail();
 const out: Record<string, unknown>={};
 for(const key of Reflect.ownKeys(value)){
  const d=Object.getOwnPropertyDescriptor(value,key);
  if(typeof key!=='string'||key==='__proto__'||!d?.enumerable||!own(d,'value'))fail();
  out[key]=capture(d.value,arrayPath,[...path,key],depth+1,budget);
 }
 return out;
}
function historicalProjection(operation: string,input: Record<string, unknown>): Record<string, unknown>{
 const projected: Record<string, unknown>={...input};
 const fields: Record<string, unknown> = operation==='timeline.clip.add'?projected:(projected.patch={...(input.patch as Record<string, unknown>)});
 delete fields.volumeEnvelope;
 // This sentinel is ONLY for the existing nonempty patch refinement. It is
 // never returned, hashed, stored, dispatched or used to change a clip.
 if(operation==='timeline.clip.update'&&own(input.patch,'volumeEnvelope')&&!Object.keys(fields).length)fields.gain=0;
 return projected;
}
export function captureVolumeEnvelopeCandidateIntent(operation: string,value: unknown,context: Record<string, unknown>={}): CapturedCandidateIntent{
 if(!operations.includes(operation))fail();
 const checkedContext=capture(context,null) as Record<string, unknown>|null;
 if(!checkedContext||typeof checkedContext!=='object'||Object.keys(checkedContext).some(key=>key!=='durationFrames')||own(checkedContext,'durationFrames')&&(!Number.isSafeInteger(checkedContext.durationFrames)||(checkedContext.durationFrames as number)<1||(checkedContext.durationFrames as number)>18000))fail();
 const {durationFrames}=checkedContext;
 const budget={nodes:0,depth:0};
 const input=capture(value,operation==='timeline.clip.add'?'volumeEnvelope.points':'patch.volumeEnvelope.points',[],0,budget);
 const inputRecord=input as Record<string, unknown>|null;
 const fields=(operation==='timeline.clip.add'?inputRecord:inputRecord?.patch) as Record<string, unknown>|null|undefined;
 if(!fields||typeof fields!=='object'||Array.isArray(fields))fail();
 const duration=(own(fields,'durationFrames')?fields.durationFrames:durationFrames) as number;
 if(own(fields,'volumeEnvelope')){
  // Null is shape-preserving clear; non-null update needs resulting duration.
  if(fields.volumeEnvelope!==null)validateVolumeEnvelope(fields.volumeEnvelope,duration as number);
 }
 if(!schemas[operation as keyof typeof schemas].safeParse(historicalProjection(operation,input as Record<string, unknown>)).success)fail();
 const text=JSON.stringify(input),bytes=Buffer.byteLength(text);
 if(bytes>EDIT_TASK_LIMITS.inputBytes)fail('VOLUME_ENVELOPE_CANDIDATE_INTENT_BUDGET');
 return {input,text,bytes,nodes:budget.nodes,depth:budget.depth};
}
// Candidate-specific digest domain prevents accidental historical ledger reuse.
function digest(operation: string,input: unknown): string{
 const canonical=JSON.stringify({profile:'dormant-volume-envelope-intent-v1',operation,input},(_key: string,v: unknown)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
 return createHash('sha256').update(canonical).digest('hex');
}
export function volumeEnvelopeCandidateIntentDigest(operation: string,input: unknown,context: Record<string, unknown>): string{
 return digest(operation,captureVolumeEnvelopeCandidateIntent(operation,input,context).input);
}
/** Complete candidate task guard, NOT an admission gate for the live ledger.
 * Digest includes exact absent/null/value identity and all original input keys. */
export function isVolumeEnvelopeCandidateEditTask(value: unknown,context: Record<string, unknown>): boolean{
 try{
  // Inspect root before selecting input, including any hostile accessor/proxy.
  if(!value||typeof value!=='object'||isProxy(value)||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return false;
  const shell: Record<string, unknown>={};let input: unknown;
  for(const key of Reflect.ownKeys(value)){
   const d=Object.getOwnPropertyDescriptor(value,key);
   if(typeof key!=='string'||key==='__proto__'||!d?.enumerable||!own(d,'value'))return false;
   if(key==='input')input=d.value;else shell[key]=d.value;
  }
  const task=capture(shell,null) as Record<string, unknown>;
  const captured=captureVolumeEnvelopeCandidateIntent(task.operation as string,input,context);
  task.input=captured.input;
  if(Buffer.byteLength(JSON.stringify(task))>EDIT_TASK_LIMITS.rowBytes||task.digest!==digest(task.operation as string,task.input))return false;
  return isEditTask({...task,input:historicalProjection(task.operation as string,task.input as Record<string, unknown>)});
 }catch{return false;}
}
