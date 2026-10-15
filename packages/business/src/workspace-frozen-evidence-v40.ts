/** Opt-in dormant40/41 receipt adapter. Never called by historical profiles.
 * Input is bounded, duplicate-key-checked JSON from the workspace scanners, not
 * caller-supplied source metadata. Nothing is normalized, returned or persisted.
 */
import type {DatabaseSync} from 'node:sqlite';
import {isTimelineRenderRecord,TIMELINE_RENDER_RESPONSE_BYTES} from '../../contracts/src/timeline-acknowledgement.mjs';
import {isTimelineVolumeEnvelopeCandidateRecord} from '../../contracts/src/timeline-volume-envelope-candidate.mjs';
import {isVolumeEnvelopeProcessingSnapshot} from '../../contracts/src/timeline-volume-envelope-processing.ts';
import {timelineRenderDeliveryFields} from '../../contracts/src/timeline-delivery.ts';

export type FrozenEvidenceProfile = 'workspace40-restored41';
type Value = Record<string,unknown>;
const object=(value:unknown):value is Value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const own=(value:object,key:string)=>Object.hasOwn(value,key);
const without=(value:Value,key:string):Value=>Object.fromEntries(Object.entries(value).filter(([name])=>name!==key));

/** Only the actual clips of a complete root render receipt receive bindings.
 * Editable history, intents, nested lookalikes and partial snapshot wrappers
 * cannot select a frozen source. Existing feature scanners still validate each
 * clip (including hidden clips), source declarations and retained LUT identity.
 */
export function frozenReceiptBindingsV40(db:Pick<DatabaseSync,'prepare'>,root:unknown,owner:unknown,table:string,rowIdentity:unknown,invalid:()=>never):WeakMap<object,Value> {
 const result=new WeakMap<object,Value>();
 if(table!=='timeline_requests'&&table!=='exports')return result;
 let evidence=false,nodes=0;
 const pending=[{value:root,depth:0}];
 while(pending.length){const {value,depth}=pending.pop()!;
  if(++nodes>200000||depth>128)invalid();
  if(value===null||typeof value!=='object')continue;
  if(object(value)&&(own(value,'snapshot')||own(value,'timeline')||own(value,'assets')))evidence=true;
  const children=Object.values(value);if(nodes+pending.length+children.length>200000)invalid();
  for(const child of children)pending.push({value:child,depth:depth+1});
 }
 if(!evidence)return result;
 if(!object(root)||!object(root.snapshot)||!object(root.snapshot.timeline)||!Array.isArray(root.snapshot.assets))invalid();
 const snapshot=root.snapshot,timeline=snapshot.timeline as Value,assets=snapshot.assets as unknown[];
 if((table==='exports'||owner!=null)&&root.projectId!==owner||timeline.projectId!==root.projectId||
    root[table==='timeline_requests'?'requestId':'id']!==rowIdentity||
    Buffer.byteLength(JSON.stringify(root))>TIMELINE_RENDER_RESPONSE_BYTES||
    !Array.isArray(timeline.clips)||assets.length<1||assets.length>100||
    !isVolumeEnvelopeProcessingSnapshot(snapshot))invalid();
 const clips=timeline.clips as unknown[];
 const hasEnvelope=clips.some(clip=>object(clip)&&own(clip,'volumeEnvelope'));
 if(hasEnvelope&&!isTimelineVolumeEnvelopeCandidateRecord(timeline,{projectId:root.projectId}))invalid();
 const projectedTimeline=hasEnvelope?{...timeline,clips:clips.map(clip=>without(clip as Value,'volumeEnvelope'))}:timeline;
 // An optional frozen projectId is accepted only when it agrees with the
 // original receipt. The production public asset projection omits that field.
 const projectedAssets=assets.map(asset=>{
  if(!object(asset)||own(asset,'projectId')&&asset.projectId!==root.projectId)invalid();
  return without(asset,'projectId');
 });
 const projectedSnapshot={...without(snapshot,'volumeEnvelopeProfile'),timeline:projectedTimeline,assets:projectedAssets};
 let input:Value;
 try{input={projectId:root.projectId,requestId:root.requestId,expectedRevision:root.timelineRevision,purpose:root.purpose,...timelineRenderDeliveryFields(snapshot)};}catch{invalid();}
 if(!isTimelineRenderRecord({...root,snapshot:projectedSnapshot},input))invalid();
 const frozen=new Map<string,Value>();
 for(const item of assets){const asset=item as Value;
  // Only current resource existence and owning project are authoritative here.
  // Cache MIME and SHA are deliberately not selected or compared to the past.
  const rows=db.prepare("SELECT CASE WHEN typeof(projectId)='text' AND length(CAST(projectId AS BLOB))=36 THEN projectId END AS projectId FROM main.assets WHERE id=? LIMIT 2").all(asset.id as string);
  if(rows.length!==1||rows[0]!.projectId!==root.projectId)invalid();
  frozen.set(asset.id as string,{...asset,projectId:root.projectId});
 }
 for(const clip of clips)result.set(clip as object,frozen.get((clip as Value).assetId as string)!);
 return result;
}
