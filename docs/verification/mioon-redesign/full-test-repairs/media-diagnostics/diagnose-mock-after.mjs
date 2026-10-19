import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,writeFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import {createMockRendererCapability} from '../verify/packages/business/src/providers/mock-renderer-capability.ts';
import {createMockProvider} from '../verify/packages/business/src/providers/mock.mjs';

const out=path.dirname(new URL(import.meta.url).pathname),exec=promisify(execFile);
const {stdout:listing}=await exec('/opt/homebrew/bin/ffmpeg',['-hide_banner','-filters']);
const lacks=createMockRendererCapability({run:async()=>listing,throwIfMediaAborted(){}});
const results={parser:{actualLacksDrawtext:await lacks()},polls:[],reconciliations:[]};
const root=path.join(out,'mock-workspace-after');await mkdir(path.join(root,'media'),{recursive:true});
const db=new DatabaseSync(':memory:');
try{
 const provider=createMockProvider({db,root}),requestId='local-diagnostic-after-1';
 const accepted=await provider.submit({prompt:'Local diagnostic',duration:2,aspectRatio:'9:16',parameters:{scenario:'success',delayMs:0},referenceAssets:[]},{requestId});
 const id=accepted.providerJobId;results.providerJobId=id;
 for(let n=0;n<3;n++){results.polls.push(await provider.poll(id,{}));results.reconciliations.push(await provider.reconcile(requestId,{}));}
 try{await provider.download(id,path.join(root,'media','mock.mp4'),{});results.download={unexpectedSuccess:true};}
 catch(error){results.download={code:error.code,message:error.message,retryable:error.retryable};}
 results.ledger={submissionCount:db.prepare('SELECT COUNT(*) AS n FROM mock_provider_submissions WHERE request_id=?').get(requestId).n,taskCount:db.prepare('SELECT COUNT(*) AS n FROM mock_provider_tasks WHERE request_id=?').get(requestId).n,task:db.prepare('SELECT provider_job_id,poll_count,download_attempts FROM mock_provider_tasks WHERE request_id=?').get(requestId)};
}finally{db.close();}
await writeFile(path.join(out,'mock-diagnostics-after.json'),JSON.stringify(results,null,2)+'\n');
console.log(JSON.stringify(results,null,2));
