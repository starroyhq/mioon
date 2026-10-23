import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

/** Reviewed Wan SDK input-contract additions over the fixed PR18 predecessor.
 * Historical fixtures and hashes remain authoritative. These finite inverses
 * recover exactly that predecessor before the older reviewed inverse chain;
 * whole-body checks reject unknown edits rather than normalizing them away. */
export const reviewedWanVideoSourceDeltas=Object.freeze([
{
  "path": "packages/contracts/src/index.ts",
  "beforeSha256": "5c3f96682bcdaedf235bbd8996b7ec8f642a88e8818fa0cd3304992b60ad4957",
  "afterSha256": "c0d172e978f81fa314c6750d73d50c7184a4620c2d1bf5c7120bbe3cad38d56e",
  "beforeBytes": 48032,
  "afterBytes": 49276,
  "inverse": [
    {
      "before": "import {AppError} from './app-error.ts';\nexport * from './video-providers.ts';\nimport {parseVideoBinding,videoBindingCapabilities} from './video-providers.ts';\nexport * from './timeline-volume-envelope-capability.ts';\nimport {isVolumeEnvelope} from './timeline-volume-envelope-processing.ts';\n",
      "after": "import {AppError} from './app-error.ts';\nexport * from './video-providers.ts';\nimport {getVideoGenerationIssue,parseVideoBinding,videoBindingCapabilities} from './video-providers.ts';\nimport {videoGenerationParametersSchema,wanVideoInputSchema,wanVideoParametersSchema} from './wan-video.ts';\nexport * from './timeline-volume-envelope-capability.ts';\nimport {isVolumeEnvelope} from './timeline-volume-envelope-processing.ts';\n"
    },
    {
      "before": "'provider.list':z.object({}).strict(),\n'video.connection.list':z.object({}).strict(),\n'generation.submit':z.object({shotId:id,expectedRevision:z.number().int().positive(),requestId:key,providerId:z.enum(['mock','runway','ark','veo','minimax','vidu','kling','wan','compatible']),model:z.string().max(100).optional(),connectionId:id.optional(),configurationRevision:z.number().int().positive().optional(),modelEntryId:id.optional(),parameters:params.extend({resolution:z.string().min(1).max(20).optional(),generateAudio:z.boolean().optional()}).optional(),subjectVersionId:id.optional().describe('Explicit immutable subject version for one subject-reference image; the server resolves its identity and metadata. Omission preserves existing frame generation. Subject and first/last-frame inputs cannot be combined.')}).strict().superRefine((value,ctx)=>{\n const fields=[value.connectionId,value.configurationRevision,value.modelEntryId],has=fields.some(field=>field!==undefined);\n if(has&&!fields.every(field=>field!==undefined)||!has&&['kling','wan','compatible'].includes(value.providerId))ctx.addIssue({code:'custom',path:['connectionId'],message:'Select an exact configured video connection and model revision.'});\n if(!has&&(value.parameters?.resolution!==undefined||value.parameters?.generateAudio!==undefined))ctx.addIssue({code:'custom',path:['parameters'],message:'Configured video parameters require an explicit connection.'});\n}),\n'job.get':z.object({jobId:id}).strict(),\n",
      "after": "'provider.list':z.object({}).strict(),\n'video.connection.list':z.object({}).strict(),\n'generation.submit':z.object({shotId:id,expectedRevision:z.number().int().positive(),requestId:key,providerId:z.enum(['mock','runway','ark','veo','minimax','vidu','kling','wan','compatible']),model:z.string().max(100).optional(),connectionId:id.optional(),configurationRevision:z.number().int().positive().optional(),modelEntryId:id.optional(),parameters:params.merge(videoGenerationParametersSchema).optional(),videoInput:wanVideoInputSchema.optional().describe('Versioned explicit Wan 3.0 input. Ordered managed image IDs replace saved shot references for this generation; omission preserves legacy selection.'),subjectVersionId:id.optional().describe('Explicit immutable subject version for one subject-reference image; the server resolves its identity and metadata. Omission preserves existing frame generation. Subject and first/last-frame inputs cannot be combined.')}).strict().superRefine((value,ctx)=>{\n const fields=[value.connectionId,value.configurationRevision,value.modelEntryId],has=fields.some(field=>field!==undefined);\n if(has&&!fields.every(field=>field!==undefined)||!has&&['kling','wan','compatible'].includes(value.providerId))ctx.addIssue({code:'custom',path:['connectionId'],message:'Select an exact configured video connection and model revision.'});\n if(!has&&(value.parameters?.resolution!==undefined||value.parameters?.generateAudio!==undefined||Object.keys(wanVideoParametersSchema.shape).some(key=>value.parameters?.[key as keyof typeof value.parameters]!==undefined)))ctx.addIssue({code:'custom',path:['parameters'],message:'Configured video parameters require an explicit connection.'});\n if(value.videoInput!==undefined&&(value.providerId!=='wan'||!has))ctx.addIssue({code:'custom',path:['videoInput'],message:'Explicit video input requires a configured Wan 3.0 connection.'});\n if(value.videoInput!==undefined&&value.subjectVersionId!==undefined)ctx.addIssue({code:'custom',path:['videoInput'],message:'Explicit video input and subject reference are mutually exclusive.'});\n if(value.providerId!=='wan'&&Object.keys(wanVideoParametersSchema.shape).some(key=>value.parameters?.[key as keyof typeof value.parameters]!==undefined))ctx.addIssue({code:'custom',path:['parameters'],message:'Wan parameters require a Wan video model.'});\n}),\n'job.get':z.object({jobId:id}).strict(),\n"
    },
    {
      "before": " const denseArray=(value: unknown): value is unknown[]=>{if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype||value.length>8)return false;const descriptors=Object.getOwnPropertyDescriptors(value);return Reflect.ownKeys(descriptors).length===value.length+1&&Reflect.ownKeys(descriptors).every(key=>key==='length'||typeof key==='string'&&/^(0|[1-9]\\d*)$/.test(key)&&Number(key)<value.length&&!descriptors[key].get&&!descriptors[key].set&&descriptors[key].enumerable);};\n if(!dataRecord(snapshot))return issue('INVALID_INPUT','生成输入必须为对象');\n const request = snapshot as Record<string, unknown>;\n const subjectIssue=getSubjectGenerationSnapshotIssue(snapshot);\n",
      "after": " const denseArray=(value: unknown): value is unknown[]=>{if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype||value.length>8)return false;const descriptors=Object.getOwnPropertyDescriptors(value);return Reflect.ownKeys(descriptors).length===value.length+1&&Reflect.ownKeys(descriptors).every(key=>key==='length'||typeof key==='string'&&/^(0|[1-9]\\d*)$/.test(key)&&Number(key)<value.length&&!descriptors[key].get&&!descriptors[key].set&&descriptors[key].enumerable);};\n if(!dataRecord(snapshot))return issue('INVALID_INPUT','生成输入必须为对象');\n if(dataRecord(capabilities)&&(capabilities as Record<string,unknown>).videoConnection&&(capabilities as Record<string,unknown>).videoModel)return getVideoGenerationIssue(snapshot,capabilities);\n const request = snapshot as Record<string, unknown>;\n const subjectIssue=getSubjectGenerationSnapshotIssue(snapshot);\n"
    }
  ]
}
]);
export function reverseReviewedWanVideo(file:string,bytes:Buffer):Buffer {
  const delta=reviewedWanVideoSourceDeltas.find(entry=>entry.path===file);
  if(!delta)return bytes;
  const label=`Baseline dependency changed: ${file}; reviewed Wan input-contract delta`;
  const sha=(value:Buffer)=>createHash('sha256').update(value).digest('hex');
  assert.equal(bytes.byteLength,delta.afterBytes,label);
  assert.equal(sha(bytes),delta.afterSha256,label);
  let source=bytes.toString('utf8');
  for(const inverse of delta.inverse){
    assert.ok(inverse.after.length>0,label);
    assert.equal(source.split(inverse.after).length-1,1,label);
    source=source.replace(inverse.after,inverse.before);
  }
  const previous=Buffer.from(source);
  assert.equal(previous.byteLength,delta.beforeBytes,label);
  assert.equal(sha(previous),delta.beforeSha256,label);
  return previous;
}
