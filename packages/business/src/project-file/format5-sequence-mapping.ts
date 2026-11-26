import {deriveFilmChains,compareChainIds,compareSequenceEdges} from '../../../contracts/src/board-sequence.ts';
import type {ChainBoard,ChainNode,ChainNodeKind,FilmChainDerivation} from '../../../contracts/src/board-sequence.ts';
import {indexChainSyncTrack} from '../../../contracts/src/chain-main-track.ts';
import type {ChainSyncClip} from '../../../contracts/src/chain-main-track.ts';
import type {ChainSyncBaseline} from '../../../contracts/src/chain-sync-analysis.ts';
import {sourceFrameCount} from '../../../contracts/src/source-range.ts';
import {clipSourceEndFrame} from '../../../contracts/src/timeline-clip-timing.ts';
import {freezeSourceSha256} from '../format6-source-proof.ts';
import {readPrevisOutputSource} from '../previs-output-ownership.ts';
import {
  assertFormat5Timeline,format5EdgeSchema,format5SequenceRootSchema,format5SubjectCardSchema,
  format5DialogueSchema,format5SubjectBindingSchema,
} from '../../../contracts/src/project-format5.ts';
import type {Format5Anchor,Format5Clip,Format5Edge,Format5ErrorCode,Format5SyncBaseline,Format5Timeline} from '../../../contracts/src/project-format5.ts';

type Row=Record<string,unknown>;
const object=(value:unknown):value is Row=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(value);
function fail(code:Format5ErrorCode,ids:readonly string[]=[]):never {
  throw Object.assign(new Error('Invalid format-5 sequence graph.'),{code,ids});
}

/** Persistent root/card names deliberately map to SA's film/subject names. */
export function format5ChainNodeKind(type:string):ChainNodeKind {
  if(type==='sequence_root')return 'film';
  if(type==='subject_card')return 'subject';
  if(['image','video','audio','text','previs'].includes(type))return type as ChainNodeKind;
  return fail('FORMAT5_NODE_INVALID');
}

/** SA uses one version identity for playable media. A fixed media node maps its
 * asset ID there, while a shot maps its actual applied immutable version ID. */
export function format5MainTrackClips(timeline:Format5Timeline):ChainSyncClip[] {
  return timeline.clips.filter(clip=>clip.trackId===timeline.mainTrack.trackId).map(clip=>{
    const source=clip.sequenceSource;
    if(!source)return fail('FORMAT5_SEQUENCE_SOURCE_INVALID',[clip.id]);
    return {id:clip.id,nodeId:source.nodeId,
      versionId:source.kind==='media'?clip.assetId:clip.versionId??null,
      versionLocked:source.kind==='media'||source.versionMode==='locked',
      startFrame:clip.startFrame,durationFrames:clip.durationFrames,sourceInFrame:clip.sourceInFrame,
      ...(clip.sourceSpanFrames===undefined?{}:{sourceSpanFrames:clip.sourceSpanFrames}),
      splitGroupId:source.segmentGroupId};
  });
}

export function format5ChainSyncBaseline(value:Format5SyncBaseline):ChainSyncBaseline {
  return {
    board:value.board.map(item=>({nodeId:item.nodeId,versionId:item.kind==='shot'?item.selectedVersionId:item.assetId})),
    track:value.track.map(item=>({nodeId:item.nodeId,versionId:item.kind==='shot'?item.appliedVersionId:item.assetId,
      locked:item.kind==='media'||item.versionMode==='locked'})),
  };
}

export interface Format5SequenceGraphInput {
  readonly projectId:string;
  readonly shots:readonly unknown[];
  /** Identity-only projection, including archived shots retained by versions. */
  readonly retainedShots?:readonly unknown[];
  readonly nodes:readonly unknown[];
  readonly edges:readonly unknown[];
  /** K1 supplies these projections for final validation. Pure topology plans
   * can omit relations that they have not read from the owning connection. */
  readonly assets?:readonly unknown[];
  readonly versions?:readonly unknown[];
  readonly adoptions?:readonly unknown[];
  readonly subjects?:readonly unknown[];
  readonly subjectVersions?:readonly unknown[];
  readonly subjectBindings?:readonly unknown[];
  readonly timeline?:unknown;
}
export interface Format5SequenceGraph {
  readonly board:ChainBoard;
  readonly derived:FilmChainDerivation;
}

const referenceKinds:Readonly<Record<string,readonly ChainNodeKind[]>>={
  first_frame:['image','previs'],last_frame:['image','previs'],reference_image:['image','previs'],
  composition:['image','previs'],reference_audio:['audio'],reference_video:['video'],
  subject_reference:['subject'],style_reference:['subject'],
};
const videoSourceMimes:ReadonlySet<string>=new Set(['image/png','image/jpeg','image/webp','video/mp4','video/webm']);
const audioSourceMimes:ReadonlySet<string>=new Set(['audio/wav','audio/mpeg','audio/mp4']);

function ownedRows(values:readonly unknown[]|undefined,projectId:string):Map<string,Row> {
  const records=new Map<string,Row>();
  for(const value of values??[]){
    if(!object(value)||!uuid(value.id)||value.projectId!==projectId||records.has(value.id))fail('FORMAT5_GRAPH_IDENTITY_INVALID');
    records.set(value.id,value);
  }
  return records;
}

function hashMatches(version:Row,asset:Row|undefined):boolean {
  return asset!==undefined&&typeof version.sha256==='string'&&/^[a-f0-9]{64}$/u.test(version.sha256)&&version.sha256===asset.sha256;
}

function validVersionOwner(
  version:Row|undefined,shotId:string,adoptions:ReadonlySet<string>,assets:ReadonlyMap<string,Row>,
  input:Format5SequenceGraphInput,retainedShots:ReadonlyMap<string,Row>,
):boolean {
  return version!==undefined&&uuid(version.shotId)&&uuid(version.jobId)&&uuid(version.assetId)&&
    (version.shotId===shotId||adoptions.has(shotId+'/'+version.id))&&
    (input.retainedShots===undefined||retainedShots.has(version.shotId))&&
    (input.assets===undefined||hashMatches(version,assets.get(version.assetId)));
}

/** Ownership and graph checks run on the complete proposed state. SA receives
 * only live sequence edges, never a reference edge or a canvas coordinate. */
export function validateFormat5SequenceGraph(input:Format5SequenceGraphInput):Format5SequenceGraph {
  if(!uuid(input.projectId))return fail('FORMAT5_GRAPH_IDENTITY_INVALID');
  const rows=new Map<string,Row>(),nodes:ChainNode[]=[],assets=new Map<string,Row>();
  const versions=ownedRows(input.versions,input.projectId),subjects=ownedRows(input.subjects,input.projectId);
  const subjectVersions=ownedRows(input.subjectVersions,input.projectId),bindings=ownedRows(input.subjectBindings,input.projectId);
  const retainedShots=ownedRows(input.retainedShots??input.shots,input.projectId);
  const dialogueByShot=new Map<string,ReadonlyMap<string,string>>();
  const adoptions=new Set<string>();
  for(const value of input.adoptions??[]){
    if(!object(value)||value.projectId!==input.projectId||!uuid(value.shotId)||!uuid(value.versionId))fail('FORMAT5_ADOPTION_INVALID');
    const key=value.shotId+'/'+value.versionId;
    if(adoptions.has(key))fail('FORMAT5_ADOPTION_INVALID',[value.shotId]);
    adoptions.add(key);
  }
  for(const value of input.assets??[]){
    if(!object(value)||!uuid(value.id)||value.projectId!==input.projectId||assets.has(value.id)||typeof value.mimeType!=='string')
      return fail('FORMAT5_NODE_SOURCE_INVALID');
    assets.set(value.id,value);
  }
  const add=(value:unknown,kind:ChainNodeKind):void=>{
    if(!object(value)||!uuid(value.id)||value.projectId!==input.projectId||rows.has(value.id))
      fail('FORMAT5_GRAPH_IDENTITY_INVALID');
    rows.set(value.id,value);nodes.push({id:value.id,kind});
  };
  for(const value of input.shots){
    add(value,'shot');
    if(object(value)&&!retainedShots.has(String(value.id)))fail('FORMAT5_GRAPH_IDENTITY_INVALID',[String(value.id)]);
    if(object(value)&&Object.hasOwn(value,'dialogue')){
      const dialogue=format5DialogueSchema.safeParse(value.dialogue);
      if(!dialogue.success)fail('FORMAT5_DIALOGUE_INVALID',[String(value.id)]);
      if(input.subjects!==undefined&&dialogue.data.some(line=>line.speakerSubjectId!==undefined&&!subjects.has(line.speakerSubjectId)))
        fail('FORMAT5_DIALOGUE_INVALID',[String(value.id)]);
      dialogueByShot.set(String(value.id),new Map(dialogue.data.map(line=>[line.id,line.text])));
    }
  }
  for(const adoption of input.adoptions??[]){
    const value=adoption as Row,shotId=value.shotId as string,versionId=value.versionId as string;
    if(!retainedShots.has(shotId)||input.versions!==undefined&&
        !validVersionOwner(versions.get(versionId),shotId,adoptions,assets,input,retainedShots))fail('FORMAT5_ADOPTION_INVALID',[shotId,versionId]);
  }
  if(input.versions!==undefined)for(const value of input.shots){
    const shot=value as Row;
    if(shot.selectedVersionId===null)continue;
    if(!uuid(shot.selectedVersionId)||!validVersionOwner(versions.get(shot.selectedVersionId),shot.id as string,adoptions,assets,input,retainedShots))
      fail('FORMAT5_VERSION_INVALID',[String(shot.id)]);
  }
  const subjectCards=new Set<string>();
  for(const value of input.nodes){
    if(!object(value)||typeof value.type!=='string')return fail('FORMAT5_NODE_INVALID');
    if(value.type==='sequence_root'&&!format5SequenceRootSchema.safeParse(value).success||
        value.type==='subject_card'&&!format5SubjectCardSchema.safeParse(value).success)
      return fail('FORMAT5_NODE_INVALID');
    const kind=format5ChainNodeKind(value.type);
    add(value,kind);
    if(kind==='subject'){
      if(!uuid(value.subjectId)||subjectCards.has(value.subjectId))return fail('FORMAT5_SUBJECT_CARD_DUPLICATE');
      if(input.subjects!==undefined&&!subjects.has(value.subjectId))return fail('FORMAT5_SUBJECT_BINDING_INVALID',[String(value.id)]);
      subjectCards.add(value.subjectId);
    }
    if(['image','video','audio'].includes(kind)&&value.assetId!=null){
      if(!uuid(value.assetId))return fail('FORMAT5_NODE_SOURCE_INVALID',[String(value.id)]);
      if(input.assets!==undefined){
        const asset=assets.get(value.assetId);
        if(!asset||!(asset.mimeType as string).startsWith(kind+'/'))return fail('FORMAT5_NODE_SOURCE_INVALID',[String(value.id)]);
      }
    }
  }
  const kinds=new Map(nodes.map(node=>[node.id,node.kind]));
  const edgeIds=new Set<string>(),references=new Set<string>(),sequence:ChainBoard['edges'][number][]=[];
  for(const value of input.edges){
    const parsed=format5EdgeSchema.safeParse(value);
    if(!parsed.success)return fail('FORMAT5_EDGE_INVALID');
    const edge=parsed.data;
    if(edge.projectId!==input.projectId||edgeIds.has(edge.id)||!rows.has(edge.source)||!rows.has(edge.target)||edge.source===edge.target)
      return fail('FORMAT5_GRAPH_IDENTITY_INVALID',[edge.id]);
    edgeIds.add(edge.id);
    if(edge.kind==='sequence'){
      for(const nodeId of [edge.source,edge.target])if(['image','video'].includes(kinds.get(nodeId)??'')&&!uuid(rows.get(nodeId)?.assetId))
        return fail('FORMAT5_NODE_SOURCE_INVALID',[nodeId]);
      sequence.push({fromId:edge.source,toId:edge.target});
    }
    else{
      if(kinds.get(edge.target)!=='shot'||!referenceKinds[edge.role]?.includes(kinds.get(edge.source)!))
        return fail('FORMAT5_REFERENCE_ROLE_INVALID',[edge.id]);
      if('sourceAssetId' in edge){
        const source=rows.get(edge.source)!;
        if(kinds.get(edge.source)!=='previs'&&source.assetId!==edge.sourceAssetId||
            input.assets!==undefined&&!assets.has(edge.sourceAssetId))return fail('FORMAT5_NODE_SOURCE_INVALID',[edge.id]);
        if(input.assets!==undefined){
          const asset=assets.get(edge.sourceAssetId)!,mime=asset.mimeType as string;
          const prefix=edge.role==='reference_audio'?'audio/':edge.role==='reference_video'?'video/':'image/';
          if(!mime.startsWith(prefix))return fail('FORMAT5_REFERENCE_ROLE_INVALID',[edge.id]);
          if(kinds.get(edge.source)==='previs'){
            let output:ReturnType<typeof readPrevisOutputSource>;
            try{output=readPrevisOutputSource(asset,input.projectId);}catch{return fail('FORMAT5_NODE_SOURCE_INVALID',[edge.id]);}
            if(output?.nodeId!==edge.source)return fail('FORMAT5_NODE_SOURCE_INVALID',[edge.id]);
          }
        }
      }else if(input.subjectBindings!==undefined){
        const binding=bindings.get(edge.subjectBindingId),source=rows.get(edge.source)!;
        const parsedBinding=format5SubjectBindingSchema.safeParse(binding);
        if(!parsedBinding.success||parsedBinding.data.subjectId!==source.subjectId||parsedBinding.data.shotId!==edge.target||
            parsedBinding.data.bindingMode==='detached'||parsedBinding.data.role!==(edge.role==='style_reference'?'style':'subject'))
          return fail('FORMAT5_SUBJECT_BINDING_INVALID',[edge.id]);
        const subject=subjects.get(parsedBinding.data.subjectId);
        if(input.subjects!==undefined&&(!subject||!uuid(subject.headVersionId)||
            (subject.kind==='look')!==(parsedBinding.data.role==='style')))return fail('FORMAT5_SUBJECT_BINDING_INVALID',[edge.id]);
        if(input.subjectVersions!==undefined){
          const selected=parsedBinding.data.bindingMode==='locked'?parsedBinding.data.subjectVersionId:subject?.headVersionId;
          const version=typeof selected==='string'?subjectVersions.get(selected):undefined;
          if(!version||version.subjectId!==parsedBinding.data.subjectId||
              input.assets!==undefined&&!hashMatches(version,typeof version.assetId==='string'?assets.get(version.assetId):undefined))
            return fail('FORMAT5_SUBJECT_BINDING_INVALID',[edge.id]);
          const head=typeof subject?.headVersionId==='string'?subjectVersions.get(subject.headVersionId):undefined;
          if(input.subjects!==undefined&&(!head||head.subjectId!==subject!.id||head.variant!==undefined||
              input.assets!==undefined&&!hashMatches(head,typeof head.assetId==='string'?assets.get(head.assetId):undefined)))
            return fail('FORMAT5_SUBJECT_BINDING_INVALID',[edge.id]);
        }
      }
      if(edge.role==='first_frame'||edge.role==='last_frame'){
        const key=edge.target+'/'+edge.role;
        if(references.has(key))return fail('FORMAT5_REFERENCE_CARDINALITY',[edge.id]);
        references.add(key);
      }
    }
  }
  const board={nodes:nodes.sort((a,b)=>compareChainIds(a.id,b.id)),edges:sequence.sort(compareSequenceEdges)};
  const derived=deriveFilmChains(board);
  if(derived.issues.length)return fail(derived.issues[0]!.code,derived.issues[0]!.nodeIds);
  if(input.timeline!==undefined){
    assertFormat5Timeline(input.timeline,{projectId:input.projectId});
    validateBoundTimeline(input.timeline,derived,kinds,rows);
    validateSourcesAndDialogue(input.timeline,input,versions,adoptions,assets,dialogueByShot,retainedShots);
  }
  return {board,derived};
}

function validateSourcesAndDialogue(
  timeline:Format5Timeline,input:Format5SequenceGraphInput,versions:ReadonlyMap<string,Row>,adoptions:ReadonlySet<string>,
  assets:ReadonlyMap<string,Row>,dialogueByShot:ReadonlyMap<string,ReadonlyMap<string,string>>,retainedShots:ReadonlyMap<string,Row>,
):void {
  const trackKinds=new Map(timeline.tracks.map(track=>[track.id,track.kind]));
  const sourceFacts=new Map<string,{mime:unknown;hasAudio?:boolean;frames?:number}>();
  for(const clip of timeline.clips){
    if(clip.sourceState!=='ready')continue;
    const source=clip.sequenceSource;
    if(input.assets!==undefined){
      const asset=assets.get(clip.assetId!);
      if(!asset)fail('FORMAT5_NODE_SOURCE_INVALID',[clip.id]);
      let facts=sourceFacts.get(clip.assetId!);
      if(!facts){facts={mime:asset.mimeType,hasAudio:asset.hasAudio===true};sourceFacts.set(clip.assetId!,facts);}
      const kind=trackKinds.get(clip.trackId),mime=facts.mime;
      if(clip.timing?.profile==='timeline-freeze-v1'&&
        (kind!=='video'||clip.timing.sourceSha256!==freezeSourceSha256(asset)||clip.timing.sourceVersionId!==(clip.versionId??null)))
        fail('FORMAT5_NODE_SOURCE_INVALID',[clip.id]);
      if(kind==='audio'&&clip.soundOnly===true){
        // «Separate sound» is the only legal way for an audio track to reference
        // a video asset: it must really be a video source that carries audio.
        if(typeof mime!=='string'||!mime.startsWith('video/')||facts.hasAudio!==true)fail('FORMAT5_NODE_SOURCE_INVALID',[clip.id]);
        if(clipSourceEndFrame(clip)>(facts.frames??=(sourceFrameCount(asset.duration)??0)))fail('SOURCE_BOUNDS',[clip.id]);
      }else{
        const supported=kind==='video'?videoSourceMimes:audioSourceMimes;
        if(typeof mime!=='string'||!supported.has(mime))fail('FORMAT5_NODE_SOURCE_INVALID',[clip.id]);
        if(mime.startsWith('image/')?clip.sourceInFrame!==0||clip.timing!==undefined:
            clipSourceEndFrame(clip)>(facts.frames??=(sourceFrameCount(asset.duration)??0)))fail('SOURCE_BOUNDS',[clip.id]);
      }
    }
    if(clip.versionId!==undefined&&input.versions!==undefined){
      const version=versions.get(clip.versionId!);
      const ownerId=source?.kind==='shot'?source.nodeId:version?.shotId;
      if(!version||version.assetId!==clip.assetId||
          typeof ownerId!=='string'||!validVersionOwner(version,ownerId,adoptions,assets,input,retainedShots)||
          clip.shotId!==undefined&&clip.shotId!==version.shotId||clip.jobId!==undefined&&clip.jobId!==version.jobId)
        fail('FORMAT5_VERSION_INVALID',[clip.id]);
    }
  }
  for(const cue of timeline.subtitles?.cues??[]){
    if(!cue.dialogueRef)continue;
    if(dialogueByShot.get(cue.dialogueRef.shotId)?.get(cue.dialogueRef.lineId)!==cue.text)
      fail('FORMAT5_DIALOGUE_INVALID',[cue.id]);
  }
}

function validateBoundTimeline(timeline:Format5Timeline,derived:FilmChainDerivation,kinds:ReadonlyMap<string,ChainNodeKind>,rows:ReadonlyMap<string,Row>):void {
  const chain=derived.chains.find(item=>item.filmId===timeline.mainTrack.sequenceNodeId);
  if(!chain)return fail('FORMAT5_MAIN_TRACK_INVALID',[timeline.mainTrack.sequenceNodeId]);
  const main=format5MainTrackClips(timeline),indexed=indexChainSyncTrack(main);
  if(!indexed.ok)return fail(indexed.code,[indexed.id]);
  const order=[...indexed.groups.keys()];
  if(order.length!==chain.nodeIds.length||order.some((nodeId,index)=>nodeId!==chain.nodeIds[index]))
    return fail('CHAIN_TRACK_MISMATCH',[timeline.mainTrack.sequenceNodeId]);
  for(const clip of timeline.clips){
    if(clip.trackId!==timeline.mainTrack.trackId)continue;
    const source=clip.sequenceSource!;
    if(source.kind==='shot'?kinds.get(source.nodeId)!=='shot':!['image','video'].includes(kinds.get(source.nodeId)??''))
      return fail('FORMAT5_SEQUENCE_SOURCE_INVALID',[clip.id]);
    if(source.kind==='media'&&rows.get(source.nodeId)?.assetId!==clip.assetId)
      return fail('FORMAT5_NODE_SOURCE_INVALID',[clip.id]);
  }
}

/** Preserve explicit detached anchors when mapping the existing SA grammar. */
export function format5AnchoredItem(value:{id:string;startFrame:number;anchor:Format5Anchor}):{id:string;startFrame:number;anchorClipId:string|null} {
  return {id:value.id,startFrame:value.startFrame,anchorClipId:value.anchor?.clipId??null};
}

/** SA returns absolute starts and anchor IDs. Persistence also stores the exact
 * offset so later reads can reject stale or out-of-range associations. */
export function format5AnchoredItemFromPlan(
  before:{startFrame:number},planned:{startFrame:number;anchorClipId?:string|null},main:readonly Format5Clip[],
):{startFrame:number;anchor:Format5Anchor} {
  if(planned.anchorClipId!=null){
    const owner=main.find(clip=>clip.id===planned.anchorClipId);
    if(owner){
      const offsetFrames=planned.startFrame-owner.startFrame;
      if(offsetFrames>=0&&offsetFrames<owner.durationFrames)return {startFrame:planned.startFrame,anchor:{clipId:owner.id,offsetFrames}};
    }
  }
  return {startFrame:before.startFrame,anchor:null};
}

export const format5SequenceEdgeToSa=(edge:Extract<Format5Edge,{kind:'sequence'}>)=>({fromId:edge.source,toId:edge.target});
