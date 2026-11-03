import path from 'node:path';
import {openProjectStore} from '../../packages/business/src/project-file/index.ts';
import {registerProjectMediaStore} from '../../packages/business/src/project-media-storage.ts';
import {publishProjectOutput,assertPublishedProjectOutput,markProjectOutputRegistered,setProjectOutputPublicationTestHooks} from '../../packages/business/src/project-output-publication.ts';
import type {ProjectOutputInput} from '../../packages/business/src/project-output-publication.ts';

const input=JSON.parse(process.argv[2]??'null') as {root:string;projectFile:string;publication:ProjectOutputInput;point:string;forceCopy:boolean};
const store=openProjectStore({projectFile:input.projectFile,locate:()=>({localDir:path.join(input.root,'local'),cacheDir:path.join(input.root,'cache'),tempDir:path.join(input.root,'tmp')})});
registerProjectMediaStore(store);
const crash=()=>{process.kill(process.pid,'SIGKILL');throw Error('SIGKILL did not terminate the worker');};
setProjectOutputPublicationTestHooks(store,{forceCopy:input.forceCopy,fault:point=>{if(point===input.point)crash();}});
const output=await publishProjectOutput(store,input.publication);
store.tx(()=>{
 assertPublishedProjectOutput(store,output.publication);
 const {relativePath:_relative,...stored}=output;
 store.put('assets',{id:input.publication.assetId,projectId:store.projectId,name:'Crash output.png',mimeType:'image/png',width:64,height:64,...stored,provenance:'generated',createdAt:'2026-11-03T00:00:00.000Z'});
});
if(input.point==='after_database_commit')crash();
await markProjectOutputRegistered(store,output.publication);
throw Error('The requested crash point was not reached');
