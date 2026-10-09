/** Disposable synthetic browser fixture, normal authenticated backend only. */
import path from 'node:path';
import {mkdir,writeFile,access} from 'node:fs/promises';
import {migrateData} from '../apps/desktop/scripts/migrate-data.mjs';
import {startServer} from '../apps/server/src/index.mjs';
import {openStore} from '../packages/business/src/db.mjs';
import {createServices} from '../packages/business/src/services.mjs';
const runtime=path.resolve('evidence/split-clips/runtime'),dataDir=path.join(runtime,'workspace');
await mkdir(runtime,{recursive:true});
try{await access(path.join(dataDir,'workbench.sqlite'));}catch{await migrateData(path.resolve('examples/multitrack-project'),dataDir);}
const store=openStore(dataDir),services=createServices(store,new Map());
const project=(await services.call('project.list',{}))[0];
const fixture={projectId:project.id,dataDir,timeline:await services.call('timeline.get',{projectId:project.id})};
store.close();
await writeFile(path.join(runtime,'fixture.json'),JSON.stringify(fixture,null,2));
process.env.MIOON_ENABLE_LIVE_PROVIDER='0';
for(const key of Object.keys(process.env))if(/^(RUNWAY|RUNWAYML|ARK_|VEO_|GEMINI_|MINIMAX_|HAILUO_|VIDU_)/.test(key))delete process.env[key];
const backend=await startServer({dataDir,port:4877,token:'split-clips-local-synthetic-token',distDir:path.resolve('apps/web/dist')});
await writeFile(path.join(runtime,'server.json'),JSON.stringify({url:backend.url,projectId:project.id,pid:process.pid}));
console.log('SPLIT_QA_READY '+backend.url);
let closing=false;async function close(){if(closing)return;closing=true;await backend.close();}process.on('SIGINT',close);process.on('SIGTERM',close);
