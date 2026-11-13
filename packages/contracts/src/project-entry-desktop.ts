import {z} from 'zod';
import {projectNameProblem, PROJECT_NAME_MAX_LENGTH} from './project-name.ts';
import {projectIdSchema} from './project-file.ts';
import {recentProjectSchema} from './project-registry.ts';
import {projectEntriesResponseSchema} from './project-entry.ts';
import {projectTemplateInputSchema} from './project-copies.ts';
import {projectEntryOpenFailureSchema} from './project-entry-open-failure.ts';

export const PROJECT_ENTRY_DESKTOP_CHANNEL = 'mioon:project-entries:v1';
export const PROJECT_ENTRY_DESKTOP_PENDING_OPEN_EVENT = 'mioon:project-entries:pending-open:v1';
export const PROJECT_ENTRY_DESKTOP_LIMITS = Object.freeze({requestBytes:16*1024,tickets:64,ticketMs:10*60*1000,pending:32});
const uuid=z.string().uuid(),name=z.string().min(1).max(PROJECT_NAME_MAX_LENGTH).refine(value=>projectNameProblem(value)===null);
export const projectPendingOpenNoticeSchema=z.object({backendId:uuid,windowId:uuid,contextId:uuid}).strict();
export type ProjectPendingOpenNotice=z.infer<typeof projectPendingOpenNoticeSchema>;
const line=z.string().max(500).refine(value=>!/[\u0000-\u001f\u007f-\u009f]/u.test(value));
export const projectLocationFactsSchema=z.object({fileSystem:z.string().min(1).max(100),isLocal:z.boolean(),volumeReadOnly:z.boolean(),permissionBits:z.boolean(),cloud:z.enum(['known-icloud','known-file-provider','not-reported','unknown'])}).strict();
export type ProjectLocationFacts=z.infer<typeof projectLocationFactsSchema>;
export const projectStoragePurposeSchema=z.enum(['create','save-as','duplicate','copy-to','template']);
export type ProjectStoragePurpose=z.infer<typeof projectStoragePurposeSchema>;
/** The renderer may select only the shipped example version, never a path. */
export const projectDesktopTemplateSchema=z.object({id:z.literal('timeline-basics'),version:z.literal(1)}).strict();
export type ProjectDesktopTemplate=z.infer<typeof projectDesktopTemplateSchema>;
export const projectDesktopSelectionSchema=z.object({token:uuid,displayPath:z.string().min(1).max(4096),facts:projectLocationFactsSchema,
 template:projectDesktopTemplateSchema.extend({name}).optional()}).strict();
export type ProjectDesktopSelection=z.infer<typeof projectDesktopSelectionSchema>;
export const projectDesktopCapabilitiesSchema=z.object({ready:z.boolean(),create:z.boolean(),open:z.boolean(),saveAs:z.boolean(),duplicate:z.boolean(),copyTo:z.boolean(),adoptCopy:z.boolean(),help:z.boolean().optional(),reveal:z.boolean().optional(),openOriginal:z.boolean().optional(),copySource:z.boolean().optional(),locationFacts:z.boolean().optional(),templates:z.array(projectDesktopTemplateSchema).max(1).optional()}).strict();
export type ProjectDesktopCapabilities=z.infer<typeof projectDesktopCapabilitiesSchema>;
const desktopOpened=z.object({status:z.literal('opened'),projectId:projectIdSchema,windowId:uuid}).strict();
const desktopCancelled=z.object({status:z.literal('cancelled')}).strict();
export const projectDesktopOpenResultSchema=z.discriminatedUnion('status',[
 desktopOpened,
 desktopCancelled,
 z.object({status:z.literal('copy'),token:uuid,name:line,expiresAt:z.number().int().positive().optional(),original:z.object({name:line,displayPath:z.string().min(1).max(4096)}).strict().optional()}).strict(),
 z.object({status:z.literal('copy-source'),token:uuid,name:line,expiresAt:z.number().int().positive().optional(),displayPath:z.string().min(1).max(4096),reason:z.enum(['read-only','network']),facts:projectLocationFactsSchema}).strict(),
]);
export type ProjectDesktopOpenResult=z.infer<typeof projectDesktopOpenResultSchema>;
export const projectDesktopRecentOpenResultSchema=z.union([
 desktopOpened,
 desktopCancelled,
 z.object({status:z.literal('failed'),reason:z.literal('busy')}).strict(),
 z.object({status:z.literal('failed'),reason:z.literal('unavailable'),failure:projectEntryOpenFailureSchema.optional()}).strict(),
]);
export type ProjectDesktopRecentOpenResult=z.infer<typeof projectDesktopRecentOpenResultSchema>;
export const projectDesktopLocationSchema=z.object({displayPath:z.string().min(1).max(4096),facts:projectLocationFactsSchema}).strict();
export const projectDesktopCreatedSchema=z.object({status:z.literal('created'),project:recentProjectSchema}).strict();
export const projectEntryDesktopRequestSchema=z.discriminatedUnion('action',[
 z.object({action:z.literal('capabilities')}).strict(),
 z.object({action:z.literal('listRecent')}).strict(),
 z.object({action:z.literal('chooseLocation'),purpose:projectStoragePurposeSchema,suggestedName:name,message:line}).strict(),
 z.object({action:z.literal('createAtSelection'),token:uuid,name,description:z.string().max(2000).optional(),timelinePresetId:z.enum(['portrait_1080','landscape_1080','square_1080']).optional(),createFolder:z.boolean()}).strict(),
 z.object({action:z.literal('instantiateTemplate'),token:uuid,templateId:z.literal('timeline-basics'),templateVersion:z.literal(1),name,locale:projectTemplateInputSchema.shape.locale,requestId:uuid}).strict(),
 z.object({action:z.literal('openSelectedFile')}).strict(),
 z.object({action:z.literal('takePendingOpen')}).strict(),
 z.object({action:z.literal('openPrivacySettings')}).strict(),
 z.object({action:z.literal('reveal'),projectId:projectIdSchema.optional(),token:uuid.optional()}).strict(),
 z.object({action:z.literal('openOriginal'),token:uuid}).strict(),
 z.object({action:z.literal('currentLocation')}).strict(),
 z.object({action:z.literal('openRecent'),projectId:projectIdSchema,entryToken:uuid,remember:z.boolean()}).strict(),
 z.object({action:z.literal('adoptCopy'),token:uuid}).strict(),
 z.object({action:z.literal('saveAs'),token:uuid,projectId:projectIdSchema,requestId:uuid,name:name.optional()}).strict(),
 z.object({action:z.literal('duplicate'),token:uuid,projectId:projectIdSchema,requestId:uuid,name:name.optional()}).strict(),
 z.object({action:z.literal('copyTo'),token:uuid,sourceToken:uuid,requestId:uuid,name:name.optional()}).strict(),
]).refine(value=>value.action!=='reveal'||(value.projectId===undefined)!==(value.token===undefined));
export type ProjectEntryDesktopRequest=z.infer<typeof projectEntryDesktopRequestSchema>;
export interface ProjectEntriesDesktopBridge {
 capabilities():Promise<ProjectDesktopCapabilities>;
 listRecent():Promise<z.infer<typeof projectEntriesResponseSchema>>;
 chooseLocation(input:{purpose:ProjectStoragePurpose;suggestedName:string;message:string}):Promise<ProjectDesktopSelection|null>;
 createAtSelection(input:Omit<Extract<ProjectEntryDesktopRequest,{action:'createAtSelection'}>,'action'>):Promise<z.infer<typeof projectDesktopCreatedSchema>>;
 instantiateTemplate?(input:Omit<Extract<ProjectEntryDesktopRequest,{action:'instantiateTemplate'}>,'action'>):Promise<import('./project-copies.ts').ProjectCopyResponse>;
 openSelectedFile():Promise<ProjectDesktopOpenResult>;
 takePendingOpen():Promise<ProjectDesktopOpenResult|null>;
 subscribePendingOpen?(listener:()=>void):()=>void;
 openPrivacySettings():Promise<void>;
 reveal(input:{projectId:string}|{token:string}):Promise<void>;
 openOriginal(input:{token:string}):Promise<ProjectDesktopOpenResult>;
 currentLocation():Promise<z.infer<typeof projectDesktopLocationSchema>>;
 openRecent(input:{projectId:string;entryToken:string;remember:boolean}):Promise<ProjectDesktopRecentOpenResult>;
 adoptCopy(input:{token:string}):Promise<ProjectDesktopOpenResult>;
 saveAs(input:Omit<Extract<ProjectEntryDesktopRequest,{action:'saveAs'}>,'action'>):Promise<unknown>;
 duplicate(input:Omit<Extract<ProjectEntryDesktopRequest,{action:'duplicate'}>,'action'>):Promise<unknown>;
 copyTo(input:Omit<Extract<ProjectEntryDesktopRequest,{action:'copyTo'}>,'action'>):Promise<unknown>;
}
