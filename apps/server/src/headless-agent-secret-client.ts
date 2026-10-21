import {fork} from 'node:child_process';
import type {ChildProcess} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {agentSettingsError} from '@mioon/business/agent/config';
import {isHeadlessSecretResult} from './headless-agent-secret-helper.ts';
import type {HeadlessSecretRequest,HeadlessSecretResult} from './headless-agent-secret-helper.ts';

export interface HeadlessSecretHelper {
  request(input:Omit<HeadlessSecretRequest,'version'|'id'>,options?:{signal?:AbortSignal}):Promise<HeadlessSecretResult>;
  close():void;
}
const unavailable=()=>agentSettingsError('AGENT_SETTINGS_STORAGE_UNAVAILABLE');
const environmentKeys=['HOME','USER','LOGNAME','TMPDIR','TMP','TEMP','PATH','SystemRoot','WINDIR','USERPROFILE','APPDATA','LOCALAPPDATA','XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS','LANG','LC_ALL'] as const;
function helperEnvironment():NodeJS.ProcessEnv {
  const environment:NodeJS.ProcessEnv={};
  for(const key of environmentKeys)if(typeof process.env[key]==='string')environment[key]=process.env[key];
  // Do not inherit NODE_OPTIONS, native-library overrides or preload hooks.
  return environment;
}
/** Every operation gets a one-shot owned child. Even native construction is off
 * the server event loop, and a late IPC result cannot revive an expired call. */
export function createHeadlessSecretHelperClient({timeoutMs=1500,helperFile=new URL('./headless-agent-secret-helper.ts',import.meta.url)}:{timeoutMs?:number;helperFile?:URL}={}):HeadlessSecretHelper {
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>4000||helperFile.protocol!=='file:')throw unavailable();
  let closed=false;
  const children=new Set<ChildProcess>(),cancellations=new Set<()=>void>();
  return Object.freeze({
    request(input:Omit<HeadlessSecretRequest,'version'|'id'>,options:{signal?:AbortSignal}={}):Promise<HeadlessSecretResult>{
      if(closed||options.signal?.aborted||children.size>=8)return Promise.reject(unavailable());
      return new Promise((resolve,reject)=>{
        const request:HeadlessSecretRequest={version:1,id:randomUUID(),...input};
        const deadline=performance.now()+timeoutMs;
        let child:ChildProcess|undefined,result:HeadlessSecretResult|undefined,settled=false;
        const finish=(value?:HeadlessSecretResult)=>{
          if(settled)return;
          settled=true;clearTimeout(timer);options.signal?.removeEventListener('abort',cancel);cancellations.delete(cancel);
          if(value)resolve(value);else reject(unavailable());
        };
        const cancel=()=>{finish();try{child?.kill('SIGKILL');}catch{}};
        const timer=setTimeout(cancel,timeoutMs);
        options.signal?.addEventListener('abort',cancel,{once:true});cancellations.add(cancel);
        try{
          child=fork(fileURLToPath(helperFile),[],{execPath:process.execPath,execArgv:[],env:helperEnvironment(),stdio:['ignore','ignore','ignore','ipc'],serialization:'json',windowsHide:true});
          children.add(child);
          // A failed OS spawn emits error/close without exit. Keep the bound
          // until close, which also covers that failure and releases its slot.
          child.once('close',()=>{children.delete(child!);});
          child.on('error',cancel);
          child.once('exit',(code,signal)=>{
            if(!settled&&!closed&&!options.signal?.aborted&&performance.now()<deadline&&code===0&&signal===null&&result)finish(result);else finish();
          });
          child.on('message',(value:unknown)=>{
            if(settled)return;
            if(closed||options.signal?.aborted||performance.now()>=deadline||result||!isHeadlessSecretResult(value,request.id)){cancel();return;}
            result=value;
          });
          child.send(request,error=>{if(error)cancel();});
        }catch{cancel();}
      });
    },
    close(){if(closed)return;closed=true;for(const cancel of [...cancellations])cancel();for(const child of children){try{child.kill('SIGKILL');}catch{}};},
  });
}
