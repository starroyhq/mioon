import {PROJECT_ENTRY_DESKTOP_CHANNEL,projectEntryDesktopRequestSchema,projectDesktopCapabilitiesSchema,projectDesktopSelectionSchema,projectDesktopOpenResultSchema,projectDesktopCreatedSchema} from '../../../packages/contracts/src/project-entry-desktop.ts';
import type {ProjectEntriesDesktopBridge} from '../../../packages/contracts/src/project-entry-desktop.ts';
import {projectEntriesResponseSchema} from '../../../packages/contracts/src/project-entry.ts';
import {projectCopyResponseSchema} from '../../../packages/contracts/src/project-copies.ts';
import {projectEntryControlErrorSchema} from '../../../packages/contracts/src/project-entry-control.ts';
export function createProjectEntriesDesktopBridge(invoke:(channel:typeof PROJECT_ENTRY_DESKTOP_CHANNEL,input:unknown)=>Promise<unknown>):ProjectEntriesDesktopBridge{
 const request=async(input:unknown):Promise<unknown>=>{
  const value=await invoke(PROJECT_ENTRY_DESKTOP_CHANNEL,projectEntryDesktopRequestSchema.parse(input));
  if(value===null||typeof value!=='object'||!('ok'in value)||typeof value.ok!=='boolean')throw new Error('Invalid project entry response');
  if(!value.ok){if(Object.keys(value).sort().join(',')!=='error,ok'||!('error'in value))throw new Error('Invalid project entry response');const error=projectEntryControlErrorSchema.parse(value.error);throw Object.assign(new Error(error.code),error);}
  if(Object.keys(value).sort().join(',')!=='data,ok'||!('data'in value))throw new Error('Invalid project entry response');return value.data;
 };
 return Object.freeze({
  capabilities:async()=>projectDesktopCapabilitiesSchema.parse(await request({action:'capabilities'})),
  listRecent:async()=>projectEntriesResponseSchema.parse(await request({action:'listRecent'})),
  chooseLocation:async(input:Parameters<ProjectEntriesDesktopBridge['chooseLocation']>[0])=>{const value=await request({action:'chooseLocation',...input});return value===null?null:projectDesktopSelectionSchema.parse(value);},
  createAtSelection:async(input:Parameters<ProjectEntriesDesktopBridge['createAtSelection']>[0])=>projectDesktopCreatedSchema.parse(await request({action:'createAtSelection',...input})),
  openSelectedFile:async()=>projectDesktopOpenResultSchema.parse(await request({action:'openSelectedFile'})),
  takePendingOpen:async()=>{const value=await request({action:'takePendingOpen'});return value===null?null:projectDesktopOpenResultSchema.parse(value);},
  openRecent:async(input:Parameters<ProjectEntriesDesktopBridge['openRecent']>[0])=>projectDesktopOpenResultSchema.parse(await request({action:'openRecent',...input})),
  adoptCopy:async(input:Parameters<ProjectEntriesDesktopBridge['adoptCopy']>[0])=>projectDesktopOpenResultSchema.parse(await request({action:'adoptCopy',...input})),
  saveAs:async(input:Parameters<ProjectEntriesDesktopBridge['saveAs']>[0])=>projectCopyResponseSchema.parse(await request({action:'saveAs',...input})),
  duplicate:async(input:Parameters<ProjectEntriesDesktopBridge['duplicate']>[0])=>projectCopyResponseSchema.parse(await request({action:'duplicate',...input})),
  copyTo:async(input:Parameters<ProjectEntriesDesktopBridge['copyTo']>[0])=>projectCopyResponseSchema.parse(await request({action:'copyTo',...input})),
 });
}
