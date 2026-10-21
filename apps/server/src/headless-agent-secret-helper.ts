import {randomBytes} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export interface HeadlessSecretRequest {version:1;id:string;operation:'read'|'create';service:string;account:string}
export type HeadlessSecretResult = {version:1;id:string;ok:true;key:string|null} | {version:1;id:string;ok:false;beforeWrite:boolean};
export interface HeadlessSecretEntry {getPassword():Promise<string|null>;setPassword(value:string):Promise<void>}
export type HeadlessSecretEntryFactory = (service:string,account:string)=>HeadlessSecretEntry|Promise<HeadlessSecretEntry>;
const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exact=(value:Record<string,unknown>,keys:readonly string[])=>Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
export function isHeadlessSecretRequest(value:unknown):value is HeadlessSecretRequest {
  return record(value)&&exact(value,['version','id','operation','service','account'])&&value.version===1&&
    typeof value.id==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(value.id)&&
    (value.operation==='read'||value.operation==='create')&&typeof value.service==='string'&&
    /^app\.starroy\.mioon\.headless\.agent\.v1\.(?:web|development|production)$/u.test(value.service)&&
    typeof value.account==='string'&&/^[a-f0-9]{64}$/u.test(value.account);
}
export function isHeadlessDek(value:unknown):value is string {
  if(typeof value!=='string'||value.length!==44||!/^[A-Za-z0-9+/]{43}=$/u.test(value))return false;
  const bytes=Buffer.from(value,'base64');
  try{return bytes.length===32&&bytes.toString('base64')===value;}finally{bytes.fill(0);}
}
export function isHeadlessSecretResult(value:unknown,id:string):value is HeadlessSecretResult {
  if(!record(value)||value.version!==1||value.id!==id)return false;
  return value.ok===true?exact(value,['version','id','ok','key'])&&(value.key===null||isHeadlessDek(value.key)):
    value.ok===false&&exact(value,['version','id','ok','beforeWrite'])&&typeof value.beforeWrite==='boolean';
}
const nativeEntry:HeadlessSecretEntryFactory=async(service,account)=>{
  const {AsyncEntry}=await import('@napi-rs/keyring');
  // Never use withTarget: its Windows constructor can write an empty secret.
  // Pin Linux to the persistent service; kernel-keyutils fallback is forbidden.
  return new AsyncEntry(service,account,{linux:{store:'secret-service'}});
};
/** Only the fixed DEK namespace is accessible. Native error text never escapes. */
export async function runHeadlessSecretOperation(input:unknown,createEntry:HeadlessSecretEntryFactory=nativeEntry):Promise<HeadlessSecretResult> {
  const id=record(input)&&typeof input.id==='string'&&input.id.length===36?input.id:'00000000-0000-0000-0000-000000000000';
  let beforeWrite=true;
  try{
    if(!isHeadlessSecretRequest(input))throw Error('invalid');
    const entry=await createEntry(input.service,input.account);
    const existing=await entry.getPassword();
    if(existing!==null){if(!isHeadlessDek(existing))throw Error('invalid');return {version:1,id,ok:true,key:existing};}
    if(input.operation==='read')return {version:1,id,ok:true,key:null};
    const bytes=randomBytes(32);let key:string;
    try{key=bytes.toString('base64');}finally{bytes.fill(0);}
    beforeWrite=false;
    await entry.setPassword(key);
    if(await entry.getPassword()!==key)throw Error('unconfirmed');
    return {version:1,id,ok:true,key};
  }catch{return {version:1,id,ok:false,beforeWrite};}
}

// The parent provides a private IPC pipe and owns the lifetime/deadline. No
// arguments, environment variables, stdout or stderr carry credential data.
if(process.send&&process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  process.once('message',(input:unknown)=>{
    void runHeadlessSecretOperation(input).then(result=>{
      if(!process.connected||!process.send){process.exit(1);return;}
      process.send(result,()=>process.exit(0));
    },()=>process.exit(1));
  });
  process.once('disconnect',()=>process.exit(1));
}
