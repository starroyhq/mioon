import type {Format5SyncBaseline,Format5Timeline} from '../../packages/contracts/src/project-format5.ts';

export const format5FixtureId=(n:number):string=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
export const format5FixtureTimestamp='2026-01-01T00:00:00.000Z';

/** One persisted fixture and the corresponding SA projection share exact IDs. */
export function format5SequenceFixture(){
  const id=format5FixtureId,projectId=id(1),rootId=id(2),shotId=id(3),imageId=id(4),nodeId=id(5);
  const timeline:Format5Timeline={
    id:id(6),projectId,revision:1,fps:30,width:720,height:1280,durationFrames:18,
    createdAt:format5FixtureTimestamp,updatedAt:format5FixtureTimestamp,
    mainTrack:{trackId:id(7),sequenceNodeId:rootId},
    tracks:[
      {id:id(7),name:'V1',kind:'video',orderIndex:0,hidden:false,muted:false},
      {id:id(8),name:'A1',kind:'audio',orderIndex:1,hidden:false,muted:false},
    ],
    clips:[
      {id:id(9),trackId:id(7),name:'未生成镜头',assetId:null,versionId:null,jobId:null,
        startFrame:0,durationFrames:12,sourceInFrame:0,rect:{x:0,y:0,width:720,height:1280},gain:1,
        sourceState:'placeholder',sequenceSource:{kind:'shot',nodeId:shotId,segmentGroupId:id(10),versionMode:'follow'}},
      {id:id(11),trackId:id(7),name:'图片',assetId:imageId,startFrame:12,durationFrames:6,sourceInFrame:0,
        rect:{x:0,y:0,width:720,height:1280},gain:1,sourceState:'ready',
        sequenceSource:{kind:'media',nodeId,segmentGroupId:id(12)}},
      {id:id(13),trackId:id(8),name:'声音',assetId:id(14),startFrame:2,durationFrames:10,sourceInFrame:0,
        rect:{x:0,y:0,width:720,height:1280},gain:1,sourceState:'ready',anchor:{clipId:id(9),offsetFrames:2}},
    ],
    subtitles:{profileId:'bottom_cjk_v1',cues:[
      {id:id(15),text:'示例',startFrame:1,durationFrames:2,anchor:{clipId:id(9),offsetFrames:1},
        dialogueRef:{shotId,lineId:id(16)}},
    ]},
  };
  const baseline:Format5SyncBaseline={version:1,
    board:[{nodeId:shotId,kind:'shot',selectedVersionId:null},{nodeId,kind:'media',assetId:imageId}],
    track:[{nodeId:shotId,segmentGroupId:id(10),clipId:id(9),kind:'shot',versionMode:'follow',appliedVersionId:null},
      {nodeId,segmentGroupId:id(12),clipId:id(11),kind:'media',assetId:imageId}],
  };
  return {projectId,rootId,shotId,imageId,nodeId,timeline,baseline,
    shots:[{id:shotId,projectId,selectedVersionId:null,dialogue:[{id:id(16),text:'示例'}]}],
    nodes:[{id:rootId,projectId,type:'sequence_root',name:'成片',position:{x:0,y:0},createdAt:format5FixtureTimestamp},
      {id:nodeId,projectId,type:'image',assetId:imageId}],
    assets:[{id:imageId,projectId,mimeType:'image/png',duration:null},{id:id(14),projectId,mimeType:'audio/wav',duration:1}],
    edges:[{id:id(17),projectId,kind:'sequence',source:rootId,target:shotId,createdAt:format5FixtureTimestamp},
      {id:id(18),projectId,kind:'sequence',source:shotId,target:nodeId,createdAt:format5FixtureTimestamp}],
  };
}
