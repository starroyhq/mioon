import path from 'node:path';
import {realpathSync} from 'node:fs';
import {createCipheriv,createDecipheriv,createHash,randomBytes,randomUUID} from 'node:crypto';
import {agentSettingsError,exactObject,MAX_AGENT_SECRET_BYTES} from '@mioon/business/agent/config';
import type {PublicStorage,SecretCodec,SettingsContextOptions} from '@mioon/business/agent/settings';
import {ensurePrivateDirectory,validatePrivateDirectory,readPrivateFile,writePrivateFileAtomic,removePrivateFile} from '@mioon/contracts/private-storage';
import {createHeadlessSecretHelperClient} from './headless-agent-secret-client.ts';
import type {HeadlessSecretHelper} from './headless-agent-secret-client.ts';
import {isHeadlessDek} from './headless-agent-secret-helper.ts';

export type HeadlessAgentSecretChannel='web'|'development'|'production';
export interface HeadlessAgentSecretCodec {
  readonly secretCodec:SecretCodec;
  readonly storage:()=>PublicStorage;
  readonly close:()=>void;
}
const MAX_PLAINTEXT_BYTES=24*1024,MAX_ENCRYPTED_CHARS=48*1024;
const unavailable=()=>agentSettingsError('AGENT_SETTINGS_STORAGE_UNAVAILABLE');
const corrupt=()=>agentSettingsError('AGENT_SETTINGS_CORRUPT');
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
class HelperFailure extends Error {readonly beforeWrite:boolean;constructor(beforeWrite=false){super('Headless credential store is unavailable.');this.beforeWrite=beforeWrite;}}
function decode(value:unknown,max:number):Buffer {
  if(typeof value!=='string'||!value||value.length>max*2||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value))throw corrupt();
  const bytes=Buffer.from(value,'base64');
  if(bytes.length>max||bytes.toString('base64')!==value)throw corrupt();
  return bytes;
}
function payload(value:string):{version:1;binding:string;value:string} {
  if(typeof value!=='string'||Buffer.byteLength(value)>MAX_PLAINTEXT_BYTES)throw corrupt();
  let parsed:unknown;try{parsed=JSON.parse(value);}catch{throw corrupt();}
  if(!exactObject(parsed,['version','binding','value'])||parsed.version!==1||typeof parsed.binding!=='string'||!parsed.binding||
    typeof parsed.value!=='string'||!parsed.value.trim()||Buffer.byteLength(parsed.value)>MAX_AGENT_SECRET_BYTES)throw corrupt();
  return {version:1,binding:parsed.binding,value:parsed.value};
}

/** directory is the Agent settings directory, never a model-supplied path.
 * The optional helper is a trusted construction seam for offline tests. */
export async function createHeadlessAgentSecretCodec({directory,channel,timeoutMs=1500,helper:injectedHelper}:{
  directory:string;channel:HeadlessAgentSecretChannel;timeoutMs?:number;helper?:HeadlessSecretHelper;
}):Promise<HeadlessAgentSecretCodec> {
  if(typeof directory!=='string'||!path.isAbsolute(directory)||!['web','development','production'].includes(channel)||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>4000)throw unavailable();
  let root=path.resolve(directory);
  try{if(validatePrivateDirectory(root,{allowMissing:true}))root=realpathSync.native(root);}catch{throw unavailable();}
  const namespace=hash(JSON.stringify(['mioon-headless-agent-secret',1,root,channel]));
  const service=`app.starroy.mioon.headless.agent.v1.${channel}`,account=namespace;
  const settingsFile=path.join(root,'settings.json'),fenceFile=path.join(root,`headless-dek-${channel}-v1.json`);
  const helper=injectedHelper??createHeadlessSecretHelperClient({timeoutMs});
  const lifetime=new AbortController();
  let available=false,sawCiphertext=false,tail:Promise<unknown>=Promise.resolve(),queued=0;
  const storage=():PublicStorage=>({persistentAvailable:available&&!lifetime.signal.aborted,sessionScope:'server',reasonCode:available&&!lifetime.signal.aborted?null:'OS_SECRET_STORE_UNAVAILABLE'});
  const checkpoint=(options:SettingsContextOptions)=>{if(lifetime.signal.aborted||options.signal?.aborted||options.isActive?.()===false)throw unavailable();};
  function diskState():{cipher:boolean;fence:boolean} {
    if(!validatePrivateDirectory(root,{allowMissing:true}))return {cipher:false,fence:false};
    const saved=readPrivateFile(settingsFile,{root,allowMissing:true,maxBytes:64*1024});
    let cipher=false;
    if(saved!==null){
      if(!(saved instanceof Uint8Array))throw corrupt();
      let parsed:unknown;try{parsed=JSON.parse(Buffer.from(saved).toString('utf8'));}catch{throw corrupt();}
      if(!exactObject(parsed,['version','revision','configuration','secret'])||parsed.version!==1&&parsed.version!==2)throw corrupt();
      cipher=parsed.secret!==null;
    }
    const bytes=readPrivateFile(fenceFile,{root,allowMissing:true,maxBytes:1024});
    if(bytes!==null){
      if(!(bytes instanceof Uint8Array))throw corrupt();
      let marker:unknown;try{marker=JSON.parse(Buffer.from(bytes).toString('utf8'));}catch{throw corrupt();}
      if(!exactObject(marker,['version','namespace','owner'])||marker.version!==1||marker.namespace!==namespace||typeof marker.owner!=='string'||!/^[a-f0-9-]{36}$/u.test(marker.owner))throw corrupt();
    }
    return {cipher,fence:bytes!==null};
  }
  function schedule<T>(options:SettingsContextOptions,operation:(context:SettingsContextOptions)=>Promise<T>):Promise<T> {
    if(lifetime.signal.aborted||queued>=16)return Promise.reject(unavailable());
    const context={...options,signal:options.signal?AbortSignal.any([lifetime.signal,options.signal]):lifetime.signal};
    queued++;
    const result=tail.then(async()=>{checkpoint(context);return operation(context);});
    tail=result.catch(()=>{}).finally(()=>{queued--;});
    return result;
  }
  async function key(operation:'read'|'create',options:SettingsContextOptions):Promise<Buffer|null> {
    checkpoint(options);
    const controller=new AbortController(),signal=options.signal?AbortSignal.any([controller.signal,options.signal,lifetime.signal]):AbortSignal.any([controller.signal,lifetime.signal]);
    return new Promise((resolve,reject)=>{
      let settled=false;
      const finish=(error:unknown,value?:Buffer|null)=>{
        if(settled){value?.fill(0);return;}
        settled=true;clearTimeout(timer);signal.removeEventListener('abort',abort);
        if(error)reject(error);else resolve(value??null);
      };
      const abort=()=>finish(unavailable());
      const timer=setTimeout(()=>{controller.abort();finish(unavailable());},timeoutMs);
      signal.addEventListener('abort',abort,{once:true});
      if(signal.aborted){abort();return;}
      void helper.request({operation,service,account},{signal}).then(result=>{
        try{
          checkpoint(options);if(signal.aborted||settled)throw unavailable();
          if(!result.ok)throw new HelperFailure(result.beforeWrite);
          if(result.key===null){if(operation==='create')throw new HelperFailure();finish(null,null);return;}
          if(!isHeadlessDek(result.key))throw new HelperFailure();
          finish(null,Buffer.from(result.key,'base64'));
        }catch{finish(result.ok?unavailable():new HelperFailure(result.beforeWrite));}
      },()=>finish(unavailable()));
    });
  }
  async function requiredKey(options:SettingsContextOptions,allowCreate:boolean):Promise<Buffer> {
    const current=await key('read',options);
    if(current)return current;
    const before=diskState();
    if(!allowCreate||sawCiphertext||before.cipher||before.fence)throw unavailable();
    checkpoint(options);ensurePrivateDirectory(root,{create:true});
    const marker=JSON.stringify({version:1,namespace,owner:randomUUID()});
    // Durable no-clobber reservation prevents two hosts creating different DEKs.
    // Keep it after success and unknown writes: missing keys must never be
    // silently replaced after ciphertext existed or a timed-out creation.
    writePrivateFileAtomic(fenceFile,marker,{root,maxBytes:1024,replace:false});
    try{
      if(diskState().cipher)throw unavailable();
      checkpoint(options);
      const created=await key('create',options);if(!created)throw unavailable();return created;
    }catch(error){
      // Only an exited helper's explicit pre-write proof permits a clean retry.
      if(error instanceof HelperFailure&&error.beforeWrite){
        try{const saved=readPrivateFile(fenceFile,{root,maxBytes:1024});if(saved instanceof Uint8Array&&Buffer.from(saved).toString('utf8')===marker)removePrivateFile(fenceFile,{root,maxBytes:1024});}catch{}
      }
      throw unavailable();
    }
  }
  const aad=(binding:string)=>Buffer.from(JSON.stringify(['mioon-headless-agent-aes256gcm',1,namespace,channel,binding]));
  const close=()=>{if(lifetime.signal.aborted)return;available=false;lifetime.abort();helper.close();};
  const secretCodec:SecretCodec={
    refreshStorage(options:SettingsContextOptions={}){
      return schedule(options,async context=>{
        try{
          const disk=diskState();sawCiphertext ||= disk.cipher;
          const bytes=await key('read',context);
          try{checkpoint(context);available=bytes!==null||!sawCiphertext&&!disk.fence;}finally{bytes?.fill(0);}
        }catch{available=false;}
        return storage();
      });
    },
    encrypt(plaintext:string,options:SettingsContextOptions={}){
      return schedule(options,async context=>{
        const parsed=payload(plaintext),binding=hash(parsed.binding);
        let bytes:Buffer|undefined;
        try{
          bytes=await requiredKey(context,true);checkpoint(context);
          const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',bytes,iv);cipher.setAAD(aad(binding));
          const encrypted=Buffer.concat([cipher.update(plaintext,'utf8'),cipher.final()]);
          const envelope={version:1,codec:'mioon-headless-aes256gcm',namespace,binding,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),body:encrypted.toString('base64')};
          const result=Buffer.from(JSON.stringify(envelope)).toString('base64');
          if(result.length>MAX_ENCRYPTED_CHARS)throw corrupt();
          checkpoint(context);available=true;return result;
        }catch{available=false;throw unavailable();}finally{bytes?.fill(0);}
      });
    },
    decrypt(ciphertext:string,options:SettingsContextOptions={}){
      return schedule(options,async context=>{
        sawCiphertext=true;
        let envelope:Record<string,unknown>,iv:Buffer,tag:Buffer,body:Buffer;
        try{
          if(typeof ciphertext!=='string'||ciphertext.length>MAX_ENCRYPTED_CHARS)throw corrupt();
          const decoded:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(decode(ciphertext,36*1024)));
          if(!exactObject(decoded,['version','codec','namespace','binding','iv','tag','body'])||decoded.version!==1||decoded.codec!=='mioon-headless-aes256gcm'||decoded.namespace!==namespace||typeof decoded.binding!=='string'||!/^[a-f0-9]{64}$/u.test(decoded.binding))throw corrupt();
          envelope=decoded;iv=decode(decoded.iv,12);tag=decode(decoded.tag,16);body=decode(decoded.body,MAX_PLAINTEXT_BYTES);
          if(iv.length!==12||tag.length!==16||!body.length)throw corrupt();
        }catch{throw corrupt();}
        let bytes:Buffer|undefined;
        try{
          bytes=await requiredKey(context,false);checkpoint(context);
          const decipher=createDecipheriv('aes-256-gcm',bytes,iv);decipher.setAAD(aad(String(envelope.binding)));decipher.setAuthTag(tag);
          const plaintext=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat([decipher.update(body),decipher.final()]));
          if(hash(payload(plaintext).binding)!==envelope.binding)throw corrupt();
          checkpoint(context);available=true;return plaintext;
        }catch{available=false;throw unavailable();}finally{bytes?.fill(0);}
      });
    },
    close,
  };
  await secretCodec.refreshStorage!();
  return Object.freeze({secretCodec:Object.freeze(secretCodec),storage,close});
}
