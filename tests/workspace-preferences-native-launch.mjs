/** Launch the ordinary sandboxed development Electron. No smoke/IPC/debug hook. */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, writeFile, readFile, access, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { prepareWorkspace, qaRoot } from './workspace-preferences-qa-runtime.mjs';
const runtime=path.join(qaRoot,'native-runtime'),userData=path.join(runtime,'user-data');await mkdir(runtime,{recursive:true});
const fixture=await prepareWorkspace(path.join(userData,'workspace'),path.join(runtime,'fixture.json'));
const require=createRequire(import.meta.url);
const env={...process.env,MIOON_DESKTOP_USER_DATA:userData,MIOON_FFMPEG_PATH:'/usr/bin/ffmpeg',MIOON_FFPROBE_PATH:'/usr/bin/ffprobe',MIOON_ENABLE_LIVE_PROVIDER:'0'};
for(const name of Object.keys(env))if(/^(RUNWAY|RUNWAYML|ARK_|VEO_|GEMINI_|MINIMAX_|HAILUO_|VIDU_)/.test(name)||['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','NODE_PATH','MIOON_DESKTOP_SMOKE_OUTPUT'].includes(name))delete env[name];
const startedAt=new Date().toISOString(),child=spawn(require('electron'),[path.resolve('apps/desktop/build')],{env,stdio:['ignore','pipe','pipe']});
const launch={startedAt,pid:child.pid,binary:require('electron'),sandboxUnchanged:true,remoteDebugging:false,smokeHooks:false};await writeFile(path.join(runtime,'launch.json'),JSON.stringify(launch,null,2));
for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>appendFile(path.join(runtime,'electron.log'),bytes));
child.on('error',e=>{console.error(e.message);process.exitCode=1;});
const outcome=await new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
const absent={};for(const name of ['mcp-connection.json','mcp-token','workspace/server.lock']){try{await access(path.join(userData,name));absent[name]=false;}catch(e){absent[name]=e.code==='ENOENT';}}
await writeFile(path.join(runtime,'last-exit.json'),JSON.stringify({...launch,endedAt:new Date().toISOString(),outcome,removed:absent},null,2));console.log('NATIVE_QA_EXIT '+JSON.stringify(outcome));
