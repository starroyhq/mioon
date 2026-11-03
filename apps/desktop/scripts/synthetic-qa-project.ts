import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {isTimelineRecord} from '@mioon/contracts';
import {createQaProject,closeQaProject} from '../../../tests/helpers/kernel-qa-fixture.mjs';
import {openServerProject} from '../../../tests/helpers/project-database.ts';

export interface DesktopQaFixture {
  readonly synthetic:true;
  readonly projectId:string;
  readonly dataDir:string;
  readonly assets:number;
  readonly clipCount:number;
}
/** Current synthetic media only; no legacy database, credentials or profile copy. */
export async function seedDesktopQaProject(dataDir:string):Promise<DesktopQaFixture> {
  const fixture=await createQaProject(dataDir,{name:'Synthetic desktop multitrack QA'});
  try {
    const projectId=fixture.store.projectId,timeline=await fixture.services.call('timeline.get',{projectId});
    assert.ok(isTimelineRecord(timeline));
    const video=timeline.tracks.find(track=>track.kind==='video'),clip=timeline.clips.find(value=>value.trackId===video?.id);
    assert.ok(video&&clip);
    const updated=await fixture.services.call('timeline.clip.add',{projectId,expectedRevision:timeline.revision,requestId:randomUUID(),
      assetId:clip.assetId,trackId:video.id,startFrame:90,sourceInFrame:0,durationFrames:30});
    assert.ok(isTimelineRecord(updated));assert.ok(updated.clips.length>=4);
    return {synthetic:true,projectId,dataDir,assets:fixture.store.list('assets',projectId).length,clipCount:updated.clips.length};
  } finally {await closeQaProject(fixture);}
}
/** Real app and project owners must both have released their SQLite locks. */
export function assertDesktopQaCold(fixture:DesktopQaFixture):void {
  const store=openServerProject(fixture.dataDir,fixture.projectId);store.close();
}
