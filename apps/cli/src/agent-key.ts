import {stdin,stderr} from 'node:process';
import path from 'node:path';
import {readPrivateFile} from '@mioon/contracts/private-storage';
import {ClientError,EXIT_CODES} from '@mioon/client';

export interface AgentKeyOptions {keyStdin?:boolean;keyFile?:string;signal?:AbortSignal;redact:(value:string)=>void}
const fail=():never=>{throw new ClientError('VALIDATION_ERROR','Choose one secure key input: hidden terminal, --key-stdin or --key-file. Never put a key in an argument or JSON input.');};
function accepted(raw:string,redact:(value:string)=>void):string{
 redact(raw);const value=raw.replace(/\r?\n$/u,'');redact(value);
 if(!value.trim()||Buffer.byteLength(value)>8192||/[\u0000-\u001f\u007f-\u009f]/u.test(value)||Buffer.from(value).toString('utf8')!==value)return fail();return value;
}
/** Read only the explicitly selected private file. Key bytes are never logged. */
export async function readAgentKey({keyStdin,keyFile,signal,redact}:AgentKeyOptions):Promise<string>{
 if(keyStdin&&keyFile)return fail();
 if(signal?.aborted)throw new ClientError('INTERRUPTED','Key input cancelled.',{exitCode:EXIT_CODES.interrupted});
 if(keyFile){try{const bytes=readPrivateFile(path.resolve(keyFile),{root:path.dirname(path.resolve(keyFile)),maxBytes:8194});if(!Buffer.isBuffer(bytes))return fail();const raw=bytes.toString('utf8');if(!Buffer.from(raw).equals(bytes))return fail();return accepted(raw,redact);}catch(error){if(error instanceof ClientError)throw error;throw new ClientError('FILE_READ_ERROR','Cannot safely read the explicitly selected private key file.');}}
 if(keyStdin){
  const chunks:Buffer[]=[];let size=0;
  const aborted=()=>stdin.destroy(new ClientError('INTERRUPTED','Key input cancelled.',{exitCode:EXIT_CODES.interrupted}));
  signal?.addEventListener('abort',aborted,{once:true});
  try{for await(const chunk of stdin){const value=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);size+=value.length;if(size>8194)return fail();chunks.push(value);}const bytes=Buffer.concat(chunks),raw=bytes.toString('utf8');if(!Buffer.from(raw).equals(bytes))return fail();return accepted(raw,redact);}
  finally{signal?.removeEventListener('abort',aborted);}
 }
 if(!stdin.isTTY||typeof stdin.setRawMode!=='function')return fail();
 const wasRaw=stdin.isRaw;stdin.setRawMode(true);
 try{stderr.write('API key (hidden): ');return await new Promise<string>((resolve,reject)=>{
  let value='';const decoder=new TextDecoder('utf-8',{fatal:true});const finish=(error?:Error)=>{stdin.off('data',data);signal?.removeEventListener('abort',abort);stdin.pause();if(error)reject(error);else{try{resolve(accepted(value,redact));}catch(failure){reject(failure);}}};
  const abort=()=>finish(new ClientError('INTERRUPTED','Key input cancelled.',{exitCode:EXIT_CODES.interrupted}));
  const data=(bytes:Buffer)=>{let characters:string;try{characters=decoder.decode(bytes,{stream:true});}catch{finish(new ClientError('VALIDATION_ERROR','The key must be valid UTF-8.'));return;}for(const character of characters){if(character==='\u0003'){abort();return;}if(character==='\r'||character==='\n'){finish();return;}if(character==='\u007f'||character==='\b')value=Array.from(value).slice(0,-1).join('');else value+=character;if(Buffer.byteLength(value)>8192){finish(new ClientError('VALIDATION_ERROR','The key exceeds its safe size limit.'));return;}}};
  stdin.on('data',data);signal?.addEventListener('abort',abort,{once:true});stdin.resume();
 });}finally{stdin.setRawMode(wasRaw);stderr.write('\n');}
}
