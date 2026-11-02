import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import type {ProjectSummary} from '../../packages/contracts/src/project-home.ts';
import type {TypedClient} from './strict-service-responses.ts';

/** Finish fixture-owned background publication before taking a no-effects
 * baseline. Later refreshes of this unchanged source reuse the same cache pair. */
export async function waitForProjectCover({client,url,token,projectId,cacheDir,source}: {
  client:TypedClient;url:string;token:string;projectId:string;cacheDir:string;
  source:{assetId:string;mimeType:NonNullable<ProjectSummary['cover']>['mimeType'];sourceSha256:string};
}):Promise<void>{
  const summary=(await client.rpc('project.summary.list',{})).find(summary=>summary.id===projectId);
  assert.deepEqual(summary?.cover,{assetId:source.assetId,mimeType:source.mimeType,url:`/api/project-covers/${projectId}`});
  const deadline=Date.now()+20000;let status:number|undefined,jpeg:Buffer|undefined;
  while(Date.now()<deadline){
    const response=await fetch(`${url}/api/project-covers/${projectId}`,{headers:{authorization:'Bearer '+token},
      signal:AbortSignal.timeout(Math.max(1,deadline-Date.now()))});
    const body=Buffer.from(await response.arrayBuffer());status=response.status;
    if(status===200){assert.equal(response.headers.get('content-type'),'image/jpeg');jpeg=body;break;}
    assert.equal(status,404);await new Promise(resolve=>setTimeout(resolve,25));
  }
  assert.equal(status,200,'fixture cover publication did not finish before the observation baseline');
  assert.ok(jpeg&&jpeg.length>0);
  assert.deepEqual(JSON.parse(await readFile(path.join(cacheDir,'cover.json'),'utf8')),
    {version:1,...source,jpegSha256:createHash('sha256').update(jpeg).digest('hex')});
}
