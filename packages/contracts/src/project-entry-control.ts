import {z} from 'zod';
import {isNormalizedAbsolutePath} from './media-reference.ts';
import {projectEntryAcquireInputSchema,projectEntryPrepareAcquireInputSchema,projectEntryCreateInputSchema,projectEntryOpenPathInputSchema,projectEntryReleaseInputSchema,projectEntrySaveAsInputSchema,projectEntryAdoptCopyInputSchema,projectEntryWindowSchema,projectEntryWindowRevokedSchema,projectEntrySourceObservationSchema} from './project-entry-native.ts';
import {projectCopyInputSchema,projectCopyToInputSchema,projectCopyResponseSchema,projectCopySourceSchema,projectTemplateInputSchema} from './project-copies.ts';
import {PROJECT_ENTRY_LIMITS,projectEntriesResponseSchema} from './project-entry.ts';
import {recentProjectSchema} from './project-registry.ts';
import type {ProjectEntryWindow} from './project-entry-native.ts';
import type {ProjectEntrySourceObservation} from './project-entry-native.ts';
import type {ProjectCopyResponse} from './project-copies.ts';
import type {ProjectEntriesResponse} from './project-entry.ts';
import type {RecentProject} from './project-registry.ts';
import {projectDesktopCapabilitiesSchema} from './project-entry-desktop.ts';
import type {ProjectDesktopCapabilities} from './project-entry-desktop.ts';
import {nativeRelinkCandidateInputSchema,nativeRelinkCandidateSchema,nativeRelinkPreviewInputSchema,nativeRelinkPreviewSchema,nativeRelinkApplyInputSchema,nativeRelinkApplyResultSchema,nativeRelinkDiscardInputSchema} from './asset-media-native.ts';
import type {NativeRelinkCandidate,NativeRelinkPreview,NativeRelinkApplyResult} from './asset-media-native.ts';

export const PROJECT_ENTRY_CONTROL_LIMITS=Object.freeze({requestBytes:64*1024,responseBytes:PROJECT_ENTRY_LIMITS.responseBytes,pending:32,completed:64,readMs:15000,writeMs:120000,maxMs:600000});
const id=z.string().uuid(),file=z.string().min(1).max(4096).refine(isNormalizedAbsolutePath);
export const projectEntryInspectCopyInputSchema=z.object({projectFile:file}).strict();
const commands=[
 z.object({operation:z.literal('capabilities'),input:z.object({}).strict()}).strict(),
 z.object({operation:z.literal('listRecent'),input:z.object({}).strict()}).strict(),
 z.object({operation:z.literal('prepareAcquire'),input:projectEntryPrepareAcquireInputSchema}).strict(),
 z.object({operation:z.literal('create'),input:projectEntryCreateInputSchema}).strict(),
 z.object({operation:z.literal('openPath'),input:projectEntryOpenPathInputSchema}).strict(),
 z.object({operation:z.literal('acquire'),input:projectEntryAcquireInputSchema}).strict(),
 z.object({operation:z.literal('release'),input:projectEntryReleaseInputSchema}).strict(),
 z.object({operation:z.literal('inspectCopy'),input:projectEntryInspectCopyInputSchema}).strict(),
 z.object({operation:z.literal('observeSource'),input:projectEntryInspectCopyInputSchema}).strict(),
 z.object({operation:z.literal('adoptCopy'),input:projectEntryAdoptCopyInputSchema}).strict(),
 z.object({operation:z.literal('saveAs'),input:projectEntrySaveAsInputSchema}).strict(),
 z.object({operation:z.literal('duplicate'),input:projectCopyInputSchema}).strict(),
 z.object({operation:z.literal('copyTo'),input:projectCopyToInputSchema}).strict(),
 z.object({operation:z.literal('instantiateTemplate'),input:projectTemplateInputSchema.extend({templateId:z.literal('timeline-basics'),templateVersion:z.literal(1)})}).strict(),
 z.object({operation:z.literal('mediaRelinkCandidate'),input:nativeRelinkCandidateInputSchema}).strict(),
 z.object({operation:z.literal('mediaRelinkPreview'),input:nativeRelinkPreviewInputSchema}).strict(),
 z.object({operation:z.literal('mediaRelinkApply'),input:nativeRelinkApplyInputSchema}).strict(),
 z.object({operation:z.literal('mediaRelinkDiscard'),input:nativeRelinkDiscardInputSchema}).strict(),
] as const;
export const projectEntryControlCommandSchema=z.discriminatedUnion('operation',commands);
export type ProjectEntryControlCommand=z.infer<typeof projectEntryControlCommandSchema>;
export interface ProjectEntryControlResults{capabilities:ProjectDesktopCapabilities;listRecent:ProjectEntriesResponse;prepareAcquire:RecentProject;create:RecentProject;openPath:ProjectEntryWindow;acquire:ProjectEntryWindow;release:true;inspectCopy:z.infer<typeof projectCopySourceSchema>;observeSource:ProjectEntrySourceObservation;adoptCopy:{copy:ProjectCopyResponse;window:ProjectEntryWindow};saveAs:{copy:ProjectCopyResponse;window:ProjectEntryWindow};duplicate:ProjectCopyResponse;copyTo:ProjectCopyResponse;instantiateTemplate:ProjectCopyResponse;mediaRelinkCandidate:NativeRelinkCandidate;mediaRelinkPreview:NativeRelinkPreview;mediaRelinkApply:NativeRelinkApplyResult;mediaRelinkDiscard:true}
export const projectEntryControlRequestSchema=z.object({type:z.literal('project-entry-control-request'),version:z.literal(1),backendId:id,requestId:id,deadline:z.number().int().positive(),command:projectEntryControlCommandSchema}).strict();
export const projectEntryControlCancelSchema=z.object({type:z.literal('project-entry-control-cancel'),version:z.literal(1),backendId:id,requestId:id}).strict();
/** Main-to-utility cleanup only; never a renderer action or queued business request. */
export const projectEntryControlReleaseSchema=z.object({type:z.literal('project-entry-control-release'),version:z.literal(1),backendId:id,windowId:id}).strict();
export const projectEntryControlErrorSchema=z.object({code:z.string().regex(/^[A-Z][A-Z0-9_]{1,90}$/u),status:z.number().int().min(400).max(599),details:z.object({projectId:id.optional(),requestId:z.string().min(8).max(200).optional(),operation:z.enum(['create','adoptCopy','saveAs','duplicate','copyTo','instantiateTemplate','release','openPath','acquire','prepareAcquire','listRecent','inspectCopy','observeSource','capabilities','mediaRelinkCandidate','mediaRelinkPreview','mediaRelinkApply','mediaRelinkDiscard']).optional(),database:z.enum(['project','history','cache']).optional(),reason:z.string().max(100).optional(),invalidReason:z.string().max(100).optional(),formatVersion:z.number().int().positive().optional(),supportedFormatVersion:z.number().int().positive().optional()}).strict()}).strict();
export const projectEntryControlResponseSchema=z.discriminatedUnion('ok',[
 z.object({type:z.literal('project-entry-control-response'),version:z.literal(1),backendId:id,requestId:id,ok:z.literal(true),data:z.unknown()}).strict(),
 z.object({type:z.literal('project-entry-control-response'),version:z.literal(1),backendId:id,requestId:id,ok:z.literal(false),error:projectEntryControlErrorSchema}).strict(),
]);
export const projectEntryControlRevokedSchema=z.object({type:z.literal('project-entry-control-revoked'),version:z.literal(1),backendId:id,event:projectEntryWindowRevokedSchema}).strict();
export function parseProjectEntryControlResult(command:ProjectEntryControlCommand,value:unknown):unknown {
 switch(command.operation){
  case 'instantiateTemplate':{
   const result=projectCopyResponseSchema.parse(value),parent=command.input.parentDir,posix=parent.startsWith('/'),separator=posix?'/':'\\',normalizedParent=posix?parent:parent.replace(/\//gu,'\\');
   const target=`${normalizedParent.endsWith(separator)?normalizedParent:normalizedParent+separator}${command.input.name}${separator}${command.input.name}.mioon`;
   if(result.requestId!==command.input.requestId||result.project.projectFile!==target||result.project.name!==command.input.name)throw new TypeError('Template instance identity mismatch');return result;
  }
  case 'mediaRelinkCandidate':{const result=nativeRelinkCandidateSchema.parse(value);if(result.projectId!==command.input.projectId||result.assetId!==command.input.assetId||result.expectedReferenceRevision!==command.input.expectedReferenceRevision)throw new TypeError('Media candidate identity mismatch');return result;}
  case 'mediaRelinkPreview':{const result=nativeRelinkPreviewSchema.parse(value);if(result.projectId!==command.input.projectId)throw new TypeError('Media preview identity mismatch');return result;}
  case 'mediaRelinkApply':return nativeRelinkApplyResultSchema.parse(value);
  case 'mediaRelinkDiscard':return z.literal(true).parse(value);
  case 'capabilities':return projectDesktopCapabilitiesSchema.parse(value);
  case 'listRecent':return projectEntriesResponseSchema.parse(value);
  case 'prepareAcquire':{const result=recentProjectSchema.parse(value);if(result.projectId!==command.input.projectId)throw new TypeError('Project preparation identity mismatch');return result;}
  case 'create':{
   const result=recentProjectSchema.parse(value);
   if(command.input.projectFile!==undefined&&result.projectFile!==command.input.projectFile)throw new TypeError('Project create target mismatch');return result;
  }
  case 'release':return z.literal(true).parse(value);
  case 'inspectCopy':{const result=projectCopySourceSchema.parse(value);if(result.sourceFile!==command.input.projectFile)throw new TypeError('Project copy observation mismatch');return result;}
  case 'observeSource':{const result=projectEntrySourceObservationSchema.parse(value);if(result.source.sourceFile!==command.input.projectFile||result.original!==null&&result.original.projectId!==result.source.sourceProjectId)throw new TypeError('Project source observation mismatch');return result;}
  case 'openPath':case 'acquire':{
   const result=projectEntryWindowSchema.parse(value);
   if(result.windowId!==command.input.windowId||command.operation==='acquire'&&(result.project.projectId!==command.input.projectId||command.input.expectedProjectFile!==undefined&&result.project.projectFile!==command.input.expectedProjectFile)||command.operation==='openPath'&&result.project.projectFile!==command.input.projectFile)throw new TypeError('Project entry identity mismatch');return result;
  }
  case 'adoptCopy':case 'saveAs':{
   const result=z.object({copy:projectCopyResponseSchema,window:projectEntryWindowSchema}).strict().parse(value);
   const expectedSource=command.operation==='adoptCopy'?command.input.sourceProjectId:command.input.projectId;
   const expectedTarget=command.operation==='adoptCopy'?command.input.sourceFile:command.input.projectFile;
   if(result.copy.requestId!==command.input.requestId||result.copy.sourceProjectId!==expectedSource||result.copy.project.projectFile!==expectedTarget||result.window.windowId!==command.input.windowId||result.window.project.projectId!==result.copy.project.projectId||result.window.project.projectFile!==result.copy.project.projectFile)throw new TypeError('Project copy window identity mismatch');return result;
  }
  case 'duplicate':case 'copyTo':{
   const result=projectCopyResponseSchema.parse(value),expectedSource=command.operation==='duplicate'?command.input.projectId:command.input.sourceProjectId;
   if(result.requestId!==command.input.requestId||result.sourceProjectId!==expectedSource||result.project.projectFile!==command.input.projectFile)throw new TypeError('Project copy identity mismatch');return result;
  }
 }
}
