/** Ordinary sandboxed Electron on the disposable mutation workspace. */
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdir,writeFile,appendFile} from 'node:fs/promises';
import path from 'node:path';
import {prepareMutationQaFixture,mutationQaRoot} from './mutation-qa-runtime.mjs';
import {testEnv} from './helpers/test-env.ts';
const runtime=path.join(mutationQaRoot,'native-runtime'),userData=path.join(runtime,'user-data');
await mkdir(runtime,{recursive:true});await prepareMutationQaFixture(userData);
if(process.argv.includes('--prepare'))process.exit(0);
const require=createRequire(import.meta.url),env={...testEnv(),MIOON_DESKTOP_USER_DATA:userData,MIOON_FFMPEG_PATH:'/usr/bin/ffmpeg',MIOON_FFPROBE_PATH:'/usr/bin/ffprobe'};
for(const name of ['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','NODE_PATH','MIOON_DESKTOP_SMOKE_OUTPUT'])delete env[name];
const startedAt=new Date().toISOString(),child=spawn(require('electron'),[path.resolve('apps/desktop/build')],{env,stdio:['ignore','pipe','pipe']});
await writeFile(path.join(runtime,'launch.json'),JSON.stringify({startedAt,pid:child.pid,binary:require('electron'),synthetic:true,sandboxUnchanged:true,remoteDebugging:false,smokeHooks:false},null,2));
for(const stream of[child.stdout,child.stderr])stream.on('data',bytes=>appendFile(path.join(runtime,'electron.log'),bytes));
child.on('error',error=>{console.error(error.message);process.exitCode=1;});
child.on('exit',async(code,signal)=>{await writeFile(path.join(runtime,'exit.json'),JSON.stringify({startedAt,endedAt:new Date().toISOString(),code,signal}));process.exitCode=code||0;});
