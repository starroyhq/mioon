import {z} from 'zod';
import {projectNameProblem, PROJECT_NAME_MAX_LENGTH} from './project-name.ts';
import {projectIdSchema} from './project-file.ts';
import {recentProjectSchema} from './project-registry.ts';
import {projectEntriesResponseSchema} from './project-entry.ts';

export const PROJECT_ENTRY_DESKTOP_CHANNEL = 'mioon:project-entries:v1';
export const PROJECT_ENTRY_DESKTOP_LIMITS = Object.freeze({requestBytes:16*1024,tickets:64,ticketMs:10*60*1000,pending:32});
const uuid=z.string().uuid(),name=z.string().min(1).max(PROJECT_NAME_MAX_LENGTH).refine(value=>projectNameProblem(value)===null);
const line=z.string().max(500).refine(value=>!/[\u0000-\u001f\u007f-\u009f]/u.test(value));
export const projectLocationFactsSchema=z.object({fileSystem:z.string().min(1).max(100),isLocal:z.boolean(),volumeReadOnly:z.boolean(),permissionBits:z.boolean(),cloud:z.enum(['known-icloud','known-file-provider','not-reported','unknown'])}).strict();
export type ProjectLocationFacts=z.infer<typeof projectLocationFactsSchema>;
export const projectStoragePurposeSchema=z.enum(['create','save-as','duplicate','copy-to']);
export type ProjectStoragePurpose=z.infer<typeof projectStoragePurposeSchema>;
export const projectDesktopSelectionSchema=z.object({token:uuid,displayPath:z.string().min(1).max(4096),facts:projectLocationFactsSchema}).strict();
export type ProjectDesktopSelection=z.infer<typeof projectDesktopSelectionSchema>;
export const projectDesktopCapabilitiesSchema=z.object({ready:z.boolean(),create:z.boolean(),open:z.boolean(),saveAs:z.boolean(),duplicate:z.boolean(),copyTo:z.boolean(),adoptCopy:z.boolean()}).strict();
export type ProjectDesktopCapabilities=z.infer<typeof projectDesktopCapabilitiesSchema>;
export const projectDesktopOpenResultSchema=z.discriminatedUnion('status',[
 z.object({status:z.literal('opened'),projectId:projectIdSchema,windowId:uuid}).strict(),
 z.object({status:z.literal('cancelled')}).strict(),
 z.object({status:z.literal('copy'),token:uuid,name:line}).strict(),
]);
export type ProjectDesktopOpenResult=z.infer<typeof projectDesktopOpenResultSchema>;
export const projectDesktopCreatedSchema=z.object({status:z.literal('created'),project:recentProjectSchema}).strict();
export const projectEntryDesktopRequestSchema=z.discriminatedUnion('action',[
 z.object({action:z.literal('capabilities')}).strict(),
 z.object({action:z.literal('listRecent')}).strict(),
 z.object({action:z.literal('chooseLocation'),purpose:projectStoragePurposeSchema,suggestedName:name,message:line}).strict(),
 z.object({action:z.literal('createAtSelection'),token:uuid,name,description:z.string().max(2000).optional(),timelinePresetId:z.enum(['portrait_1080','landscape_1080','square_1080']).optional(),createFolder:z.boolean()}).strict(),
 z.object({action:z.literal('openSelectedFile')}).strict(),
 z.object({action:z.literal('takePendingOpen')}).strict(),
 z.object({action:z.literal('openRecent'),projectId:projectIdSchema,entryToken:uuid,remember:z.boolean()}).strict(),
 z.object({action:z.literal('adoptCopy'),token:uuid}).strict(),
 z.object({action:z.literal('saveAs'),token:uuid,projectId:projectIdSchema,requestId:uuid,name:name.optional()}).strict(),
 z.object({action:z.literal('duplicate'),token:uuid,projectId:projectIdSchema,requestId:uuid,name:name.optional()}).strict(),
 z.object({action:z.literal('copyTo'),token:uuid,sourceToken:uuid,requestId:uuid,name:name.optional()}).strict(),
]);
export type ProjectEntryDesktopRequest=z.infer<typeof projectEntryDesktopRequestSchema>;
export interface ProjectEntriesDesktopBridge {
 capabilities():Promise<ProjectDesktopCapabilities>;
 listRecent():Promise<z.infer<typeof projectEntriesResponseSchema>>;
 chooseLocation(input:{purpose:ProjectStoragePurpose;suggestedName:string;message:string}):Promise<ProjectDesktopSelection|null>;
 createAtSelection(input:Omit<Extract<ProjectEntryDesktopRequest,{action:'createAtSelection'}>,'action'>):Promise<z.infer<typeof projectDesktopCreatedSchema>>;
 openSelectedFile():Promise<ProjectDesktopOpenResult>;
 takePendingOpen():Promise<ProjectDesktopOpenResult|null>;
 openRecent(input:{projectId:string;entryToken:string;remember:boolean}):Promise<ProjectDesktopOpenResult>;
 adoptCopy(input:{token:string}):Promise<ProjectDesktopOpenResult>;
 saveAs(input:Omit<Extract<ProjectEntryDesktopRequest,{action:'saveAs'}>,'action'>):Promise<unknown>;
 duplicate(input:Omit<Extract<ProjectEntryDesktopRequest,{action:'duplicate'}>,'action'>):Promise<unknown>;
 copyTo(input:Omit<Extract<ProjectEntryDesktopRequest,{action:'copyTo'}>,'action'>):Promise<unknown>;
}
