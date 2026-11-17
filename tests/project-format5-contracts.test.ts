import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FORMAT5_LIMITS,assertFormat5Timeline,getFormat5TimelineIssue,isFormat5Timeline,
  format5EdgeSchema,format5SequenceRootSchema,format5SubjectCardSchema,
  format5SequenceSourceSchema,format5AnchorSchema,format5DialogueSchema,format5SyncBaselineSchema,
} from '../packages/contracts/src/project-format5.ts';
import {isTimelineRecord} from '../packages/contracts/src/timeline-replacement.ts';
import {defaultPrevisScene} from '../packages/contracts/src/previs.ts';
import {previsOutputInputHash} from '../packages/business/src/previs-output-ownership.ts';
import {
  validateFormat5SequenceGraph,format5MainTrackClips,format5ChainSyncBaseline,
  format5AnchoredItem,format5AnchoredItemFromPlan,
} from '../packages/business/src/project-file/format5-sequence-mapping.ts';
import {format5SequenceFixture,format5FixtureId as id,format5FixtureTimestamp as stamp} from './fixtures/format5-sequence.ts';

test('format-5 fields have strict discriminators, reference evidence and stable identities',()=>{
  const f=format5SequenceFixture(),base={id:id(20),projectId:f.projectId,source:f.nodeId,target:f.shotId,createdAt:stamp};
  assert.equal(format5EdgeSchema.safeParse({...base,kind:'sequence'}).success,true);
  assert.equal(format5EdgeSchema.safeParse({...base,kind:'sequence',role:'first_frame'}).success,false);
  assert.equal(format5EdgeSchema.safeParse({...base,kind:'reference',role:'first_frame',sourceAssetId:f.imageId}).success,true);
  assert.equal(format5EdgeSchema.safeParse({...base,kind:'reference',role:'last_frame',sourceAssetId:f.imageId,orderIndex:2}).success,true);
  assert.equal(format5EdgeSchema.safeParse({...base,kind:'reference',role:'subject_reference',subjectBindingId:id(21)}).success,true);
  assert.equal(format5EdgeSchema.safeParse({...base,kind:'reference',role:'subject_reference',sourceAssetId:f.imageId}).success,false);
  assert.equal(format5EdgeSchema.safeParse({...base,kind:'reference',role:'first_frame',sourceAssetId:f.imageId,subjectBindingId:id(21)}).success,false);
  assert.equal(format5EdgeSchema.safeParse({...base,kind:'reference',role:'reference_image',sourceAssetId:f.imageId,orderIndex:-1}).success,false);
  assert.equal(format5SequenceSourceSchema.safeParse({kind:'media',nodeId:f.nodeId,segmentGroupId:id(22),versionMode:'locked'}).success,false);
  assert.equal(format5AnchorSchema.safeParse({clipId:id(9),offsetFrames:0,unknown:true}).success,false);
  assert.equal(format5SequenceRootSchema.safeParse(f.nodes[0]).success,true);
  assert.equal(format5SequenceRootSchema.safeParse({...f.nodes[0],assetId:f.imageId}).success,false);
  assert.equal(format5SubjectCardSchema.safeParse({id:id(23),projectId:f.projectId,type:'subject_card',subjectId:id(24),position:{x:0,y:0},createdAt:stamp}).success,true);
  assert.equal(format5DialogueSchema.safeParse([{id:id(25),text:'台词'},{id:id(25),text:'重复'}]).success,false);
  assert.equal(format5SyncBaselineSchema.safeParse(f.baseline).success,true);
  assert.equal(format5SyncBaselineSchema.safeParse({...f.baseline,board:[...f.baseline.board,f.baseline.board[0]]}).success,false);
});

test('persisted identities map explicitly to SA film, directed edges, split groups and selected content',()=>{
  const f=format5SequenceFixture();
  assertFormat5Timeline(f.timeline,{projectId:f.projectId});
  const {board,derived}=validateFormat5SequenceGraph(f);
  assert.deepEqual(board.nodes,[{id:f.rootId,kind:'film'},{id:f.shotId,kind:'shot'},{id:f.nodeId,kind:'image'}]);
  assert.deepEqual(board.edges,[{fromId:f.rootId,toId:f.shotId},{fromId:f.shotId,toId:f.nodeId}]);
  assert.deepEqual(derived.chains,[{filmId:f.rootId,nodeIds:[f.shotId,f.nodeId]}]);
  const original=JSON.stringify(f);
  assert.deepEqual(validateFormat5SequenceGraph({...f,nodes:[...f.nodes].reverse(),edges:[...f.edges].reverse()}),{board,derived});
  assert.equal(JSON.stringify(f),original);
  assert.deepEqual(format5MainTrackClips(f.timeline),[
    {id:id(9),nodeId:f.shotId,versionId:null,versionLocked:false,startFrame:0,durationFrames:12,sourceInFrame:0,splitGroupId:id(10)},
    {id:id(11),nodeId:f.nodeId,versionId:f.imageId,versionLocked:true,startFrame:12,durationFrames:6,sourceInFrame:0,splitGroupId:id(12)},
  ]);
  assert.deepEqual(format5ChainSyncBaseline(f.baseline),{
    board:[{nodeId:f.shotId,versionId:null},{nodeId:f.nodeId,versionId:f.imageId}],
    track:[{nodeId:f.shotId,versionId:null,locked:false},{nodeId:f.nodeId,versionId:f.imageId,locked:true}],
  });
  const anchored=f.timeline.clips[2]!;
  assert.deepEqual(format5AnchoredItem({id:anchored.id,startFrame:anchored.startFrame,anchor:anchored.anchor!}),
    {id:id(13),startFrame:2,anchorClipId:id(9)});
  assert.deepEqual(format5AnchoredItemFromPlan({startFrame:2},{startFrame:14,anchorClipId:id(11)},f.timeline.clips),{startFrame:14,anchor:{clipId:id(11),offsetFrames:2}});
  assert.deepEqual(format5AnchoredItemFromPlan({startFrame:2},{startFrame:18,anchorClipId:id(11)},f.timeline.clips),{startFrame:2,anchor:null});
  assert.deepEqual(format5AnchoredItemFromPlan({startFrame:2},{startFrame:14,anchorClipId:null},f.timeline.clips),{startFrame:2,anchor:null});
  assert.equal(isTimelineRecord(f.timeline),false,'the format-3/4 grammar remains closed');
});

test('SA graph errors and exact reference cardinalities survive the persistence mapping',()=>{
  const f=format5SequenceFixture();
  assert.throws(()=>validateFormat5SequenceGraph({...f,edges:[...f.edges,{...f.edges[0],id:id(30),source:f.rootId,target:f.nodeId}]}),{code:'MULTIPLE_PREDECESSORS'});
  assert.throws(()=>validateFormat5SequenceGraph({...f,edges:[...f.edges,{...f.edges[0],id:id(31),source:f.nodeId,target:f.shotId}]}),{code:'CYCLE'});
  assert.throws(()=>validateFormat5SequenceGraph({...f,nodes:[...f.nodes,{...f.nodes[0]}]}),{code:'FORMAT5_GRAPH_IDENTITY_INVALID'});
  assert.throws(()=>validateFormat5SequenceGraph({...f,shots:[{...f.shots[0],projectId:id(31)}]}),{code:'FORMAT5_GRAPH_IDENTITY_INVALID'});
  const first={id:id(32),projectId:f.projectId,source:f.nodeId,target:f.shotId,kind:'reference',role:'first_frame',sourceAssetId:f.imageId,createdAt:stamp};
  validateFormat5SequenceGraph({...f,edges:[...f.edges,first]});
  assert.throws(()=>validateFormat5SequenceGraph({...f,edges:[...f.edges,first,{...first,id:id(33)}]}),{code:'FORMAT5_REFERENCE_CARDINALITY'});
  assert.throws(()=>validateFormat5SequenceGraph({...f,edges:[...f.edges,{...first,role:'reference_audio'}]}),{code:'FORMAT5_REFERENCE_ROLE_INVALID'});
  assert.throws(()=>validateFormat5SequenceGraph({...f,timeline:{...f.timeline,mainTrack:{...f.timeline.mainTrack,sequenceNodeId:id(34)}}}),{code:'FORMAT5_MAIN_TRACK_INVALID'});
  const emptyCard={id:id(35),projectId:f.projectId,type:'image',assetId:null};
  validateFormat5SequenceGraph({...f,nodes:[...f.nodes,emptyCard]});
  assert.throws(()=>validateFormat5SequenceGraph({...f,nodes:[...f.nodes,emptyCard],edges:[...f.edges,
    {id:id(36),projectId:f.projectId,kind:'sequence',source:f.nodeId,target:emptyCard.id,createdAt:stamp}]}),{code:'FORMAT5_NODE_SOURCE_INVALID'});
});

test('main-track packing, placeholder nulls, split ownership and both kinds of anchors are enforced',()=>{
  const invalid=(change:(f:ReturnType<typeof format5SequenceFixture>)=>void,code:string)=>{
    const f=format5SequenceFixture();change(f);assert.equal(getFormat5TimelineIssue(f.timeline)?.code,code);
  };
  invalid(f=>{f.timeline.clips[0]!.assetId=f.imageId;},'FORMAT5_PLACEHOLDER_INVALID');
  invalid(f=>{f.timeline.clips[1]!.startFrame++;f.timeline.durationFrames++;},'FORMAT5_MAIN_TRACK_GAP');
  invalid(f=>{f.timeline.clips[2]!.anchor={clipId:id(9),offsetFrames:12};},'FORMAT5_ANCHOR_INVALID');
  invalid(f=>{f.timeline.subtitles!.cues[0]!.anchor={clipId:id(11),offsetFrames:0};},'FORMAT5_SUBTITLES_INVALID');
  invalid(f=>{f.timeline.clips[1]!.sequenceSource!.segmentGroupId=id(10);},'FORMAT5_SEGMENT_GROUP_INVALID');
  invalid(f=>{f.timeline.clips[0]!.transitionIn={kind:'arbitrary'};},'FORMAT5_CLIP_INVALID');
  invalid(f=>{f.timeline.clips[1]!.layout={profileId:'mioon-clip-layout-v2',basisPresetId:'arbitrary'};},'FORMAT5_CLIP_INVALID');
  invalid(f=>{f.timeline.clips[0]!.gain=3;},'FORMAT5_CLIP_INVALID');
  const f=format5SequenceFixture(),cue=f.timeline.subtitles!.cues[0]!;
  f.timeline.subtitles!.cues.push({...cue,id:id(35),startFrame:3,durationFrames:1,anchor:{clipId:id(9),offsetFrames:3}});
  assert.equal(getFormat5TimelineIssue(f.timeline)?.code,'FORMAT5_DIALOGUE_DUPLICATE');
});

test('ready shot content requires its direct immutable version or an explicit adoption',()=>{
  const f=format5SequenceFixture(),assetId=id(40),versionId=id(41),jobId=id(42),hash='a'.repeat(64);
  Object.assign(f.timeline.clips[0]!,{sourceState:'ready',assetId,versionId,jobId,shotId:f.shotId});
  const assets=[...f.assets,{id:assetId,projectId:f.projectId,mimeType:'video/mp4',duration:1,sha256:hash}];
  const version={id:versionId,projectId:f.projectId,shotId:f.shotId,jobId,assetId,sha256:hash};
  validateFormat5SequenceGraph({...f,assets,versions:[version],adoptions:[]});
  assert.throws(()=>validateFormat5SequenceGraph({...f,assets:assets.map(asset=>asset.id===assetId?{...asset,duration:.3}:asset),versions:[version]}),{code:'SOURCE_BOUNDS'});
  assert.throws(()=>validateFormat5SequenceGraph({...f,assets,versions:[{...version,sha256:'b'.repeat(64)}]}),{code:'FORMAT5_VERSION_INVALID'});
  assert.throws(()=>validateFormat5SequenceGraph({...f,assets,versions:[{...version,assetId:f.imageId}]}),{code:'FORMAT5_VERSION_INVALID'});
  const originalShotId=id(43);
  f.timeline.clips[0]!.shotId=originalShotId;
  const adoptedVersion={...version,shotId:originalShotId};
  assert.throws(()=>validateFormat5SequenceGraph({...f,assets,versions:[adoptedVersion]}),{code:'FORMAT5_VERSION_INVALID'});
  validateFormat5SequenceGraph({...f,assets,versions:[adoptedVersion],
    adoptions:[{projectId:f.projectId,shotId:f.shotId,versionId,createdAt:stamp}]});
  assert.throws(()=>validateFormat5SequenceGraph({...f,assets,versions:[adoptedVersion],
    adoptions:[{projectId:id(44),shotId:f.shotId,versionId,createdAt:stamp}]}),{code:'FORMAT5_ADOPTION_INVALID'});
  const cue=f.timeline.subtitles!.cues[0]!;cue.text='另一行';
  f.timeline.clips[0]!.shotId=f.shotId;
  assert.throws(()=>validateFormat5SequenceGraph({...f,assets,versions:[version]}),{code:'FORMAT5_DIALOGUE_INVALID'});
});

test('subject references resolve only their binding mode, real head, subject role and version owner',()=>{
  const f=format5SequenceFixture(),subjectId=id(45),versionId=id(46),bindingId=id(47),cardId=id(48),hash='b'.repeat(64);
  const card={id:cardId,projectId:f.projectId,type:'subject_card',subjectId,position:{x:0,y:0},createdAt:stamp};
  const edge={id:id(49),projectId:f.projectId,kind:'reference',role:'subject_reference',source:cardId,target:f.shotId,subjectBindingId:bindingId,createdAt:stamp};
  const binding={id:bindingId,projectId:f.projectId,shotId:f.shotId,subjectId,role:'subject',revision:1,
    bindingMode:'follow',subjectVersionId:null,reviewedHeadVersionId:null,createdAt:stamp,updatedAt:stamp};
  const context={...f,nodes:[...f.nodes,card],edges:[...f.edges,edge],
    assets:f.assets.map(asset=>({...asset,...(asset.id===f.imageId?{sha256:hash}:{})})),
    subjects:[{id:subjectId,projectId:f.projectId,kind:'character',headVersionId:versionId}],
    subjectVersions:[{id:versionId,projectId:f.projectId,subjectId,assetId:f.imageId,sha256:hash}],subjectBindings:[binding]};
  validateFormat5SequenceGraph(context);
  validateFormat5SequenceGraph({...context,subjectBindings:[{...binding,bindingMode:'locked',subjectVersionId:versionId}]});
  assert.throws(()=>validateFormat5SequenceGraph({...context,subjectBindings:[{...binding,bindingMode:'detached'}]}),{code:'FORMAT5_SUBJECT_BINDING_INVALID'});
  assert.throws(()=>validateFormat5SequenceGraph({...context,subjectBindings:[{...binding,role:'style'}]}),{code:'FORMAT5_SUBJECT_BINDING_INVALID'});
  assert.throws(()=>validateFormat5SequenceGraph({...context,subjectVersions:[{...context.subjectVersions[0],subjectId:id(50)}]}),{code:'FORMAT5_SUBJECT_BINDING_INVALID'});
  assert.throws(()=>validateFormat5SequenceGraph({...context,subjectBindings:[{...binding,bindingMode:'locked',subjectVersionId:versionId}],
    subjects:[{...context.subjects[0],headVersionId:id(51)}],
    subjectVersions:[...context.subjectVersions,{...context.subjectVersions[0],id:id(51),sha256:'c'.repeat(64)}]}),{code:'FORMAT5_SUBJECT_BINDING_INVALID'});
  // A migrated binding may predate its subject-card edge.
  validateFormat5SequenceGraph({...context,nodes:f.nodes,edges:f.edges});
});

test('selected versions and retained adoptions prove ownership while a short selection preserves the applied version',()=>{
  const f=format5SequenceFixture(),oldAsset=id(60),oldVersion=id(61),selectedVersion=id(62),selectedAsset=id(63),archivedShot=id(64);
  const actual={id:oldVersion,projectId:f.projectId,shotId:f.shotId,jobId:id(65),assetId:oldAsset,sha256:'a'.repeat(64)};
  const selected={id:selectedVersion,projectId:f.projectId,shotId:f.shotId,jobId:id(66),assetId:selectedAsset,sha256:'b'.repeat(64)};
  Object.assign(f.timeline.clips[0]!,{sourceState:'ready',assetId:oldAsset,versionId:oldVersion,shotId:f.shotId,jobId:actual.jobId});
  const context={...f,shots:[{...f.shots[0],selectedVersionId:selectedVersion}],versions:[actual,selected],adoptions:[],retainedShots:[{id:f.shotId,projectId:f.projectId},{id:archivedShot,projectId:f.projectId}],
    assets:[...f.assets,{id:oldAsset,projectId:f.projectId,mimeType:'video/mp4',duration:1,sha256:actual.sha256},
      {id:selectedAsset,projectId:f.projectId,mimeType:'video/mp4',duration:.1,sha256:selected.sha256}]};
  validateFormat5SequenceGraph(context);
  assert.throws(()=>validateFormat5SequenceGraph({...context,versions:[actual]}),{code:'FORMAT5_VERSION_INVALID'});
  assert.throws(()=>validateFormat5SequenceGraph({...context,versions:[actual,{...selected,shotId:archivedShot}]}),{code:'FORMAT5_VERSION_INVALID'});
  const adoption={projectId:f.projectId,shotId:f.shotId,versionId:selectedVersion,createdAt:stamp};
  validateFormat5SequenceGraph({...context,versions:[actual,{...selected,shotId:archivedShot}],adoptions:[adoption]});
  assert.throws(()=>validateFormat5SequenceGraph({...context,adoptions:[{...adoption,versionId:id(67)}]}),{code:'FORMAT5_ADOPTION_INVALID'});
  assert.throws(()=>validateFormat5SequenceGraph({...context,adoptions:[{...adoption,shotId:id(68)}]}),{code:'FORMAT5_ADOPTION_INVALID'});
  validateFormat5SequenceGraph({...context,adoptions:[{...adoption,shotId:archivedShot}]});
  assert.throws(()=>validateFormat5SequenceGraph({...context,versions:[actual,{...selected,shotId:id(69)}],adoptions:[adoption]}),{code:'FORMAT5_ADOPTION_INVALID'});
});

test('dialogue speakers are checked before a cue exists and only a shot can own a dialogue reference',()=>{
  const f=format5SequenceFixture();
  assert.throws(()=>validateFormat5SequenceGraph({...f,timeline:undefined,subjects:[],shots:[
    {...f.shots[0],dialogue:[{id:id(16),text:'示例',speakerSubjectId:id(70)}]},
  ]}),{code:'FORMAT5_DIALOGUE_INVALID'});
  f.timeline.subtitles!.cues[0]!.dialogueRef={shotId:f.nodeId,lineId:id(16)};
  const nodes=f.nodes.map(node=>node.id===f.nodeId?{...node,dialogue:[{id:id(16),text:'示例'}]}:node);
  assert.throws(()=>validateFormat5SequenceGraph({...f,nodes}),{code:'FORMAT5_DIALOGUE_INVALID'});
});

test('previs references retain immutable output proof after the source scene changes',()=>{
  const f=format5SequenceFixture(),nodeId=id(71),assetId=id(72),hash='c'.repeat(64),sizeBytes=16;
  const node={id:nodeId,projectId:f.projectId,type:'previs',label:'预演',text:'',position:{x:0,y:0},
    revision:10,sceneRevision:10,scene:defaultPrevisScene(),createdAt:stamp};
  const output={projectId:f.projectId,nodeId,keyframeId:'k1',sceneRevision:1,
    requestId:'previs-output-original',name:'frame.png',sha256:hash,width:32,height:32};
  const asset={id:assetId,projectId:f.projectId,mimeType:'image/png',name:output.name,
    duration:null,width:32,height:32,sha256:hash,sizeBytes,provenance:'generated',previsOutput:output,
    reference:{pathForm:'relative',path:'生成/frame.png',volume:null,sizeBytes,mtimeMs:0,sampledSha256:hash,fullSha256:hash},
    publication:{version:1,publicationId:id(73),projectId:f.projectId,assetId,
      owner:{kind:'previs',id:nodeId,requestId:output.requestId,inputHash:previsOutputInputHash(output)},
      targetKind:'generated',relativePath:'生成/frame.png',sha256:hash,sizeBytes,mimeType:'image/png'}};
  const edge={id:id(74),projectId:f.projectId,kind:'reference',role:'composition',source:nodeId,target:f.shotId,
    sourceAssetId:assetId,createdAt:stamp};
  const context={...f,nodes:[...f.nodes,node],assets:[...f.assets,asset],edges:[...f.edges,edge]};
  assert.equal(node.scene.keyframes.length,0);
  validateFormat5SequenceGraph(context);
  validateFormat5SequenceGraph({...context,edges:[...f.edges,{...edge,role:'first_frame'}]});
  assert.throws(()=>validateFormat5SequenceGraph({...context,edges:[...f.edges,{...edge,sourceAssetId:f.imageId}]}),{code:'FORMAT5_NODE_SOURCE_INVALID'});
  assert.throws(()=>validateFormat5SequenceGraph({...context,assets:[...f.assets,{...asset,sha256:'d'.repeat(64)}]}),{code:'FORMAT5_NODE_SOURCE_INVALID'});
  const foreignOutput={...output,nodeId:id(75)};
  const foreignAsset={...asset,previsOutput:foreignOutput,publication:{...asset.publication,
    owner:{...asset.publication.owner,id:foreignOutput.nodeId,inputHash:previsOutputInputHash(foreignOutput)}}};
  assert.throws(()=>validateFormat5SequenceGraph({...context,assets:[...f.assets,foreignAsset]}),{code:'FORMAT5_NODE_SOURCE_INVALID'});
});

test('approved format-5 capacities include 500 main clips, 1000 other clips and 1000 cues',()=>{
  const f=format5SequenceFixture(),main=f.timeline.clips[1]!,other=f.timeline.clips[2]!;
  f.timeline.clips=[
    ...Array.from({length:FORMAT5_LIMITS.mainTrackClips},(_,n)=>({...main,id:id(1000+n),startFrame:n,durationFrames:1,
      sequenceSource:{kind:'media' as const,nodeId:id(3000+n),segmentGroupId:id(5000+n)}})),
    ...Array.from({length:FORMAT5_LIMITS.otherTrackClips},(_,n)=>({...other,id:id(7000+n),startFrame:n,durationFrames:1,anchor:null})),
  ];
  f.timeline.durationFrames=1000;
  f.timeline.subtitles!.cues=Array.from({length:FORMAT5_LIMITS.subtitleCues},(_,n)=>({id:id(9000+n),text:'字',startFrame:n,durationFrames:1,anchor:null}));
  assert.equal(isFormat5Timeline(f.timeline),true);
  f.timeline.subtitles!.cues.push({id:id(11000),text:'字',startFrame:999,durationFrames:1,anchor:null});
  assert.equal(isFormat5Timeline(f.timeline),false);
  f.timeline.subtitles!.cues.pop();
  f.timeline.clips.push({...other,id:id(11001),startFrame:1000,durationFrames:1,anchor:null});
  f.timeline.durationFrames=1001;
  assert.equal(getFormat5TimelineIssue(f.timeline)?.code,'FORMAT5_TIMELINE_INVALID');
});
