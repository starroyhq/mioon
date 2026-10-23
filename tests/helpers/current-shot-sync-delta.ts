import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

/** Independently reviewed timeline shot-sync additions (refreshSources and
 * shots.append) to already pinned integration sources. Each exact inverse
 * recovers the previous main bytes; anything else still fails its pin. */
export const reviewedShotSyncSourceDeltas=Object.freeze([
 {
  path:'packages/contracts/src/index.ts',
  previousSha256:'c0d172e978f81fa314c6750d73d50c7184a4620c2d1bf5c7120bbe3cad38d56e',
  inverse:[
   {before:"export * from './timeline-loudness-apply.ts';\n",
    after:"export * from './timeline-loudness-apply.ts';\nimport {timelineShotSyncSchemas,timelineShotSyncDescriptions} from './timeline-shot-sync.ts';\nexport * from './timeline-shot-sync.ts';\n"},
   {before:'...timelineLoudnessApplySchemas,\n',after:'...timelineLoudnessApplySchemas,\n...timelineShotSyncSchemas,\n'},
   {before:' ...timelineColourDescriptions,\n',after:' ...timelineColourDescriptions,\n ...timelineShotSyncDescriptions,\n'},
  ],
 },
 {
  path:'packages/contracts/src/timeline-acknowledgement.ts',
  previousSha256:'a55d256b49b13af632293437cc693929ec626f394badcfb9336061dc292cae1c',
  inverse:[
   {before:"from './timeline-loudness-apply.ts';\n",
    after:"from './timeline-loudness-apply.ts';\nimport {createTimelineShotSyncContracts,hasTimelineShotSyncNotAppliedProof,TIMELINE_SHOT_SYNC_OPERATIONS} from './timeline-shot-sync.ts';\n"},
   {before:'TIMELINE_LOUDNESS_APPLY_OPERATION,\n]);',after:'TIMELINE_LOUDNESS_APPLY_OPERATION, ...TIMELINE_SHOT_SYNC_OPERATIONS,\n]);'},
   {before:'const loudnessApplyContracts=createTimelineLoudnessApplyContracts({isTimelineRecord: (value, options) => isTimelineRecord(value, options)});\n',
    after:'const loudnessApplyContracts=createTimelineLoudnessApplyContracts({isTimelineRecord: (value, options) => isTimelineRecord(value, options)});\nconst shotSyncContracts=createTimelineShotSyncContracts({isTimelineRecord: (value, options) => isTimelineRecord(value, options)});\n'},
   {before:'return loudnessApplyContracts.isTimelineLoudnessApplyResponse(value,input);\n',
    after:'return loudnessApplyContracts.isTimelineLoudnessApplyResponse(value,input);\n  if((TIMELINE_SHOT_SYNC_OPERATIONS as readonly unknown[]).includes(operation))return shotSyncContracts.isTimelineShotSyncResponse(operation,input,value);\n'},
   {before:'  if(operation===TIMELINE_LOUDNESS_APPLY_OPERATION)return hasTimelineLoudnessApplyNotAppliedProof(failure,input);\n',
    after:'  if((TIMELINE_SHOT_SYNC_OPERATIONS as readonly unknown[]).includes(operation))return hasTimelineShotSyncNotAppliedProof(failure,input,operation);\n  if(operation===TIMELINE_LOUDNESS_APPLY_OPERATION)return hasTimelineLoudnessApplyNotAppliedProof(failure,input);\n'},
  ],
 },
 {
  "path": "packages/contracts/src/edit-tasks.ts",
  "previousSha256": "d79bfc599ceb7a4154b4c8e29ac4bc0d7e07d71fa05986888eff592ab1cd94b3",
  "inverse": [
   {
    "before": "import {TIMELINE_SUBTITLE_OPERATIONS} from './timeline-subtitles.ts';\nimport {TIMELINE_MUTATION_OPERATIONS, isTimelineMutationResponse} from './timeline-acknowledgement.ts';\n",
    "after": "import {TIMELINE_SUBTITLE_OPERATIONS} from './timeline-subtitles.ts';\nimport {TIMELINE_SHOT_SYNC_OPERATIONS} from './timeline-shot-sync.ts';\nimport {TIMELINE_MUTATION_OPERATIONS, isTimelineMutationResponse} from './timeline-acknowledgement.ts';\n"
   },
   {
    "before": "// Local UI coordination only. These are not RPC/model-tool operations.\nexport const DURABLE_EDIT_OPERATIONS = Object.freeze([\n  ...TIMELINE_MUTATION_OPERATIONS.filter(operation => operation !== 'timeline.render' && operation !== 'timeline.format.set' && operation !== 'timeline.loudness.apply' && !TIMELINE_SUBTITLE_OPERATIONS.includes(operation)),\n  ...REFERENCE_MUTATION_OPERATIONS,\n",
    "after": "// Local UI coordination only. These are not RPC/model-tool operations.\n// The edit_tasks table checks this exact list, so shot-sync bridges stay out.\nexport const DURABLE_EDIT_OPERATIONS = Object.freeze([\n  ...TIMELINE_MUTATION_OPERATIONS.filter(operation => operation !== 'timeline.render' && operation !== 'timeline.format.set' && operation !== 'timeline.loudness.apply' && !TIMELINE_SUBTITLE_OPERATIONS.includes(operation) && !(TIMELINE_SHOT_SYNC_OPERATIONS as readonly string[]).includes(operation)),\n  ...REFERENCE_MUTATION_OPERATIONS,\n"
   }
  ]
 },
 {
  path:'packages/business/src/workspace-restore-policy.ts',
  previousSha256:'ce2cc6a3c65c1e428792a7e361aab895a0b44bf890a28aae2015103b77b7fcb8',
  inverse:[
   {before:"'timeline.loudness.apply',",after:"'timeline.loudness.apply','timeline.clip.refreshSources','timeline.shots.append',"},
  ],
 },
 {
  "path": "packages/contracts/src/operation-effects.ts",
  "previousSha256": "7fbe8b205ba1aec9e5c0f1ee01461d2e10b0ece05c665b3455bd50d81d0c81cf",
  "inverse": [
   {
    "before": "  'timeline.seed': define({...replayEdit,notes:'Copies selected shot assets into an empty timeline and records an edit; a new branch can discard redo history. Exact replay is durable.'}),\n  'timeline.render': define({...render,notes:'Queues a frozen timeline render once per exact request. Optional export-only fixed delivery settings invoke bounded local capability compute before fresh acceptance; historical replay runs no probe. Later worker work revalidates and invokes local FFmpeg/ffprobe and writes managed output. Omission retains the legacy path. No provider call.'}),\n",
    "after": "  'timeline.seed': define({...replayEdit,notes:'Copies selected shot assets into an empty timeline and records an edit; a new branch can discard redo history. Exact replay is durable.'}),\n  'timeline.clip.refreshSources': define({...replayEdit,notes:'Switches listed clips to the version their shot now selects, keeping every editable clip field; skipped clips and reasons are returned. One edit for the whole batch; a new branch can discard redo history. Exact replay is durable.'}),\n  'timeline.shots.append': define({...replayEdit,notes:'Appends shots without a clip, in canvas order with their selected versions pinned, to the end of the first video track; skipped shots and reasons are returned. Records one edit; a new branch can discard redo history. Exact replay preserves the new clip IDs.'}),\n  'timeline.render': define({...render,notes:'Queues a frozen timeline render once per exact request. Optional export-only fixed delivery settings invoke bounded local capability compute before fresh acceptance; historical replay runs no probe. Later worker work revalidates and invokes local FFmpeg/ffprobe and writes managed output. Omission retains the legacy path. No provider call.'}),\n"
   }
  ]
 },
 {
  "path": "packages/business/src/timeline-recovery.ts",
  "previousSha256": "b22da79752e3252ad79e23ce07b8f9c55dee8b94a61bff559f652a4f7a6624b8",
  "inverse": [
   {
    "before": "import {readTimelineFormatProvenance} from './timeline-format-receipts.ts';\nimport {AppError,TIMELINE_SUBTITLE_OPERATIONS,TIMELINE_EXPORT_CAPABILITY_REJECTION_CODES,isTimelineMutationResponse,isTimelineRecord,isTimelineRenderRecord,TIMELINE_RESPONSE_BYTES,TIMELINE_REPLACEMENT_RESPONSE_BYTES,TIMELINE_RENDER_RESPONSE_BYTES} from '@mioon/contracts';\nexport {TIMELINE_RESPONSE_BYTES,TIMELINE_REPLACEMENT_RESPONSE_BYTES,TIMELINE_RENDER_RESPONSE_BYTES} from '@mioon/contracts';\n",
    "after": "import {readTimelineFormatProvenance} from './timeline-format-receipts.ts';\nimport {AppError,TIMELINE_SUBTITLE_OPERATIONS,TIMELINE_EXPORT_CAPABILITY_REJECTION_CODES,isTimelineMutationResponse,isTimelineRecord,isTimelineRenderRecord,TIMELINE_RESPONSE_BYTES,TIMELINE_REPLACEMENT_RESPONSE_BYTES,TIMELINE_RENDER_RESPONSE_BYTES,TIMELINE_SHOT_SYNC_OPERATIONS,TIMELINE_SHOT_SYNC_PROOF_CODES,TIMELINE_SHOT_SYNC_RESPONSE_BYTES} from '@mioon/contracts';\nexport {TIMELINE_RESPONSE_BYTES,TIMELINE_REPLACEMENT_RESPONSE_BYTES,TIMELINE_RENDER_RESPONSE_BYTES} from '@mioon/contracts';\n"
   },
   {
    "before": " version(id: string,shotId?: string|null,assetId?: string|null): TimelineVersionRecord;\n}\n",
    "after": " version(id: string,shotId?: string|null,assetId?: string|null): TimelineVersionRecord;\n legacySource(assetId: string): TimelineVersionRecord|null;\n}\n"
   },
   {
    "before": " version(id: string,shotId?: string|null,assetId?: string|null): TimelineVersionRecord;\n sources(timeline: TimelineRecord): Map<string, TimelineAssetRecord>;\n",
    "after": " version(id: string,shotId?: string|null,assetId?: string|null): TimelineVersionRecord;\n /** The one generated version that owns an asset, or null for imports. */\n legacySource(assetId: string): TimelineVersionRecord|null;\n sources(timeline: TimelineRecord): Map<string, TimelineAssetRecord>;\n"
   },
   {
    "before": "export const invalidTimeline: ()=>never=()=>{throw new AppError('INVALID_TIMELINE_SNAPSHOT','时间线或已保存的请求响应无效',409);};\nconst unavailable: ()=>never=()=>{throw new AppError('TIMELINE_SOURCE_UNAVAILABLE','项目中的时间线或关联素材不可用',404);};\n",
    "after": "export const invalidTimeline: ()=>never=()=>{throw new AppError('INVALID_TIMELINE_SNAPSHOT','时间线或已保存的请求响应无效',409);};\n// Shot-sync acknowledgements wrap the saved timeline with per-item outcomes;\n// every other non-render timeline acknowledgement is the timeline itself.\nconst responseTimeline=(operation: string,response: unknown): unknown=>\n (TIMELINE_SHOT_SYNC_OPERATIONS as readonly string[]).includes(operation)?(response as {timeline?: unknown}).timeline:response;\nconst unavailable: ()=>never=()=>{throw new AppError('TIMELINE_SOURCE_UNAVAILABLE','项目中的时间线或关联素材不可用',404);};\n"
   },
   {
    "before": " if(operation===TIMELINE_LOUDNESS_APPLY_OPERATION)return;\n if(transactionEntered&&callbackFailed&&receiptAbsent&&!writesStarted&&!db.isTransaction&&error instanceof AppError&&definiteRejections.has(error.code))\n",
    "after": " if(operation===TIMELINE_LOUDNESS_APPLY_OPERATION)return;\n // Shot-sync proofs always bind operation and project, and only for the codes\n // the client accepts for these operations; nothing looser is attached.\n if((TIMELINE_SHOT_SYNC_OPERATIONS as readonly string[]).includes(operation)){\n  if(transactionEntered&&callbackFailed&&receiptAbsent&&!writesStarted&&!db.isTransaction&&error instanceof AppError&&(TIMELINE_SHOT_SYNC_PROOF_CODES as readonly string[]).includes(error.code))\n   failure.details={...(failure.details as Record<string,unknown>|undefined),mutationOutcome:'not_applied',operation,projectId:input.projectId,requestId:input.requestId};\n  return;\n }\n if(transactionEntered&&callbackFailed&&receiptAbsent&&!writesStarted&&!db.isTransaction&&error instanceof AppError&&definiteRejections.has(error.code))\n"
   },
   {
    "before": "export function readTimelineReceipt(db: DatabaseSync,input: TimelineRecoveryInput,operation: string): TimelineReceiptRow|undefined{\n const bytes=operation===TIMELINE_LOUDNESS_APPLY_OPERATION?TIMELINE_LOUDNESS_APPLY_RESPONSE_BYTES:operation==='timeline.render'?TIMELINE_RENDER_RESPONSE_BYTES:operation==='timeline.clip.replaceSource'?TIMELINE_REPLACEMENT_RESPONSE_BYTES:TIMELINE_RESPONSE_BYTES;\n const row=db.prepare(`SELECT ${bounded('requestHash',64)} AS requestHash,${bounded('response',bytes)} AS response FROM timeline_requests WHERE requestId=?`).get(input.requestId as string);\n",
    "after": "export function readTimelineReceipt(db: DatabaseSync,input: TimelineRecoveryInput,operation: string): TimelineReceiptRow|undefined{\n const bytes=operation===TIMELINE_LOUDNESS_APPLY_OPERATION?TIMELINE_LOUDNESS_APPLY_RESPONSE_BYTES:operation==='timeline.render'?TIMELINE_RENDER_RESPONSE_BYTES:operation==='timeline.clip.replaceSource'?TIMELINE_REPLACEMENT_RESPONSE_BYTES:\n  (TIMELINE_SHOT_SYNC_OPERATIONS as readonly string[]).includes(operation)?TIMELINE_SHOT_SYNC_RESPONSE_BYTES:TIMELINE_RESPONSE_BYTES;\n const row=db.prepare(`SELECT ${bounded('requestHash',64)} AS requestHash,${bounded('response',bytes)} AS response FROM timeline_requests WHERE requestId=?`).get(input.requestId as string);\n"
   },
   {
    "before": " const version=(id: string,shotId?: string|null,assetId?: string|null): TimelineVersionRecord=>guarded(()=>graph().version(id,shotId,assetId));\n function sources(timeline: TimelineRecord): Map<string, TimelineAssetRecord>{\n",
    "after": " const version=(id: string,shotId?: string|null,assetId?: string|null): TimelineVersionRecord=>guarded(()=>graph().version(id,shotId,assetId));\n const legacySource=(assetId: string): TimelineVersionRecord|null=>guarded(()=>graph().legacySource(assetId));\n function sources(timeline: TimelineRecord): Map<string, TimelineAssetRecord>{\n"
   },
   {
    "before": " function responseSources(operation: string,response: unknown,{historical=false}: {historical?: boolean}={}): TimelineRecord{\n  assertTimelineAudioRoleWorkspace(db,response);\n  assertTimelineVolumeEnvelopeWorkspace(db,response);\n  const record=response as TimelineRenderResponseLike&TimelineRecord;\n  const timeline=operation==='timeline.render'?record.snapshot.timeline:record;\n",
    "after": " function responseSources(operation: string,response: unknown,{historical=false}: {historical?: boolean}={}): TimelineRecord{\n  const saved=responseTimeline(operation,response);\n  assertTimelineAudioRoleWorkspace(db,saved);\n  assertTimelineVolumeEnvelopeWorkspace(db,saved);\n  const record=saved as TimelineRenderResponseLike&TimelineRecord;\n  const timeline=operation==='timeline.render'?record.snapshot.timeline:record;\n"
   },
   {
    "before": "   if(current.id!==responseRecord.snapshot.timeline.id||JSON.stringify(renderRecord(responseRecord))!==JSON.stringify(response))invalidTimeline();\n  }else if(JSON.stringify(current)!==JSON.stringify(response))invalidTimeline();\n  const saved=readTimelineReceipt(db,input,operation);\n",
    "after": "   if(current.id!==responseRecord.snapshot.timeline.id||JSON.stringify(renderRecord(responseRecord))!==JSON.stringify(response))invalidTimeline();\n  }else if(JSON.stringify(current)!==JSON.stringify(responseTimeline(operation,response)))invalidTimeline();\n  const saved=readTimelineReceipt(db,input,operation);\n"
   },
   {
    "before": " }\n return {read,asset,inputAsset,clipSource,version,sources,shots,validate,validateReadonly,restored,replay,verify};\n}\n",
    "after": " }\n return {read,asset,inputAsset,clipSource,version,legacySource,sources,shots,validate,validateReadonly,restored,replay,verify};\n}\n"
   }
  ]
 },
]);

const sha=(value:Uint8Array):string=>createHash('sha256').update(value).digest('hex');
/** Newest reviewed layer: reverse it before every older one. Bytes that are
 * already the previous source pass unchanged, so a chain may apply it twice. */
export function reverseReviewedShotSync(path:string,bytes:Uint8Array):Buffer {
 const delta=reviewedShotSyncSourceDeltas.find(item=>item.path===path);if(!delta||sha(bytes)===delta.previousSha256)return Buffer.from(bytes);
 let source=Buffer.from(bytes).toString('utf8');
 for(const inverse of delta.inverse){
  assert.equal(source.split(inverse.after).length-1,1,`Baseline dependency changed: ${path}; reviewed shot-sync edit must occur exactly once`);
  source=source.replace(inverse.after,inverse.before);
 }
 const recovered=Buffer.from(source);assert.equal(sha(recovered),delta.previousSha256,`Baseline dependency changed: ${path}; unreviewed shot-sync source drift`);return recovered;
}
