import {z} from 'zod';
import {frameReceiptSchema} from './frame-extraction.ts';
import {sceneShotsReceiptSchema,sceneSchemas,SCENE_LIMITS} from './scene-tasks.ts';

const encoder=new TextEncoder(),bytes=(value:string):number=>encoder.encode(value).length;
const requestId=z.string().min(8).max(200).refine(value=>bytes(value)<=800,'Request ID exceeds its byte limit');
/** Portable immutable source facts. A local task, when present, remains the
 * authority and must match these facts exactly; missing local history never
 * authorizes reconstruction of a task or execution of work. */
export const frameOutputResultSchema=z.object({requestId,receipt:frameReceiptSchema}).strict()
 .refine(value=>bytes(JSON.stringify(value))<=8192,'Frame result source exceeds its byte limit');
/** A keyframe carries only its own entry of the complete storyboard receipt.
 * The complete batch remains in local history and its durable staging manifest. */
export const sceneOutputResultSchema=z.object({requestId,input:sceneSchemas['scene.shots.create'],
 segment:z.tuple([z.number().int().min(1).max(SCENE_LIMITS.cuts+1),z.number().int().min(0).max(SCENE_LIMITS.frameCount),z.number().int().min(1).max(SCENE_LIMITS.frameCount)]),
 receipt:sceneShotsReceiptSchema.refine(value=>value.keyframes.length===1,'A keyframe carries exactly one receipt entry')}).strict()
 .refine(({requestId,input,segment,receipt})=>input.requestId===requestId&&input.projectId===receipt.projectId&&input.sourceAssetId===receipt.sourceAssetId&&input.sourceHash===receipt.sourceHash&&
  input.segments.includes(segment[0])&&segment[1]<segment[2]&&receipt.keyframes[0]!.segment===segment[0]&&receipt.keyframes[0]!.sourceFrame===segment[1]+Math.floor((segment[2]-segment[1])/2),'The keyframe follows its frozen input and segment')
 .refine(value=>bytes(JSON.stringify(value))<=8192,'Scene result source exceeds its byte limit');
export type FrameOutputResult= z.infer<typeof frameOutputResultSchema>;
export type SceneOutputResult= z.infer<typeof sceneOutputResultSchema>;
