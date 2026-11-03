/** Disposable synthetic browser fixture, normal authenticated backend only. */
import path from 'node:path';
import {mkdir,writeFile,access} from 'node:fs/promises';
import {ensureQaProject,closeQaProject} from './helpers/kernel-qa-fixture.mjs';
import {startServer} from '../apps/server/src/index.ts';
const runtime=path.resolve('evidence/split-clips/runtime'),dataDir=path.join(runtime,'data');
await mkdir(runtime,{recursive:true});
const prepared=await ensureQaProject(dataDir,{name:'分割剪辑 · 合成验收'}),{store,services,project}=prepared;
const fixture={kernel:true,projectId:project.id,dataDir,projectDir:store.projectDir,timeline:await services.call('timeline.get',{projectId:project.id})};
await closeQaProject(prepared);
await writeFile(path.join(runtime,'fixture.json'),JSON.stringify(fixture,null,2));
process.env.MIOON_ENABLE_LIVE_PROVIDER='0';
for(const key of Object.keys(process.env))if(/^(RUNWAY|RUNWAYML|ARK_|VEO_|GEMINI_|MINIMAX_|HAILUO_|VIDU_)/.test(key))delete process.env[key];
const backend=await startServer({dataDir,port:4877,token:'split-clips-local-synthetic-token',distDir:path.resolve('apps/web/dist')});
await writeFile(path.join(runtime,'server.json'),JSON.stringify({url:backend.url,projectId:project.id,pid:process.pid}));
console.log('SPLIT_QA_READY '+backend.url);
let closing=false;async function close(){if(closing)return;closing=true;await backend.close();}process.on('SIGINT',close);process.on('SIGTERM',close);
