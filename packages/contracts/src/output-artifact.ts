import {z} from 'zod';
import {projectIdSchema} from './project-file.ts';
import {projectOutputOwnerSchema} from './project-output-publication.ts';
import {timelineExportAudioCheckSchema} from './timeline-export-float.ts';

const digest=z.string().regex(/^[a-f0-9]{64}$/u);
export const outputArtifactFileInfoSchema=z.object({sizeBytes:z.number().int().positive().max(8*1024**3),sha256:digest,
 width:z.number().int().positive().max(32768),height:z.number().int().positive().max(32768),duration:z.number().positive().finite(),hasVideo:z.literal(true),hasAudio:z.boolean()}).strict();
export const outputArtifactSchema=z.object({version:z.literal(1),kind:z.enum(['generation','export']),projectId:projectIdSchema,
 owner:projectOutputOwnerSchema,sourceIdentity:digest,assetId:projectIdSchema,publicationId:projectIdSchema,versionId:projectIdSchema.optional(),
 stageRelativePath:z.string().min(1).max(1024),stageIdentity:z.object({dev:z.string().min(1).max(40),ino:z.string().min(1).max(40),birthtimeNs:z.string().min(1).max(40)}).strict(),
 info:outputArtifactFileInfoSchema,audioCheck:timelineExportAudioCheckSchema.optional(),createdAt:z.string().datetime()}).strict().superRefine((value,context)=>{
 const folder=value.kind==='generation'?'job-results':'export-staging',parts=value.stageRelativePath.split('/');
 if(value.owner.kind!==value.kind||parts.length!==3||parts[0]!==folder||parts[1]!==value.owner.id||!/^stage-[a-f0-9-]{36}\.mp4$/u.test(parts[2]??'')||
   (value.kind==='generation'?!value.versionId||Boolean(value.audioCheck):Boolean(value.versionId)))context.addIssue({code:'custom',message:'Artifact owner and private stage must match.'});
});
export type OutputArtifact=z.infer<typeof outputArtifactSchema>;
/** One frozen output identity for writers and retained-output readers. Runtime
 * status/attempts and filesystem locations do not change the accepted work. */
export function exportOutputArtifactIdentity(value:Readonly<Record<string,unknown>>):string{
 return JSON.stringify(Object.fromEntries(['id','projectId','requestId','mode','purpose','timelineRevision','snapshot','orderedVersionIds','outputGeometry','createdAt'].map(key=>[key,value[key]])));
}
