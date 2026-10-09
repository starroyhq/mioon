/** Ordinary sandboxed development Electron launch on disposable copied data.
 * No browser debugging, IPC hooks, smoke entry, security override or live calls. */
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdir,writeFile,access,appendFile} from 'node:fs/promises';
import path from 'node:path';
import {migrateData} from '../apps/desktop/scripts/migrate-data.mjs';
const runtime=path.resolve('evidence/dockable-panels/native-runtime'),userData=path.join(runtime,'user-data'),workspace=path.join(userData,'workspace');await mkdir(runtime,{recursive:true});
try{await access(path.join(workspace,'workbench.sqlite'));}catch{await migrateData(path.resolve('examples/multitrack-project'),workspace);}
if(process.argv.includes('--prepare')){console.log(workspace);process.exit(0);}
const require=createRequire(import.meta.url),env={...process.env,MIOON_DESKTOP_USER_DATA:userData,MIOON_FFMPEG_PATH:'/usr/bin/ffmpeg',MIOON_FFPROBE_PATH:'/usr/bin/ffprobe',MIOON_ENABLE_LIVE_PROVIDER:'0'};
for(const name of Object.keys(env))if(/^(RUNWAY|RUNWAYML|ARK_|VEO_|GEMINI_|MINIMAX_|HAILUO_|VIDU_)/.test(name)||['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','NODE_PATH','MIOON_DESKTOP_SMOKE_OUTPUT'].includes(name))delete env[name];
const startedAt=new Date().toISOString(),child=spawn(require('electron'),[path.resolve('apps/desktop/build')],{env,stdio:['ignore','pipe','pipe']});
const launch={startedAt,pid:child.pid,binary:require('electron'),sandboxUnchanged:true,remoteDebugging:false,smokeHooks:false};await writeFile(path.join(runtime,'launch.json'),JSON.stringify(launch,null,2));
for(const stream of[child.stdout,child.stderr])stream.on('data',bytes=>appendFile(path.join(runtime,'electron.log'),bytes));
child.on('error',e=>{console.error(e.message);process.exitCode=1;});const outcome=await new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
const absent={};for(const name of['mcp-connection.json','mcp-token','workspace/server.lock']){try{await access(path.join(userData,name));absent[name]=false;}catch(e){absent[name]=e.code==='ENOENT';}}
await writeFile(path.join(runtime,'last-exit.json'),JSON.stringify({...launch,endedAt:new Date().toISOString(),outcome,removed:absent},null,2));console.log('DOCK_NATIVE_EXIT '+JSON.stringify(outcome));
