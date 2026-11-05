import path from 'node:path';
import {projectEntryWindowSchema} from '../../packages/contracts/src/project-entry-native.ts';
import type {ProjectEntryWindow,ProjectEntryWindowRevoked} from '../../packages/contracts/src/project-entry-native.ts';
import type {ProjectWindowHostOptions,ProjectNativeWindow} from '../../apps/desktop/src/project-window-host.ts';

export function projectWindowLeaseValue(windowId:string,projectId:string,projectFile=path.resolve(`${projectId}.mioon`)):ProjectEntryWindow{
 return projectEntryWindowSchema.parse({windowId,project:{projectId,projectFile,fileIdentity:{dev:'1',ino:'2'},name:'Synthetic project',lastOpenedAt:null,summary:null}});
}
/** Explicit native lease boundary for renderer/native window fixtures. No
 * editor is allowed to appear merely because its UUID passed a UI token. */
export function createProjectWindowLeaseFixture(){
 const acquired:Array<{windowId:string;projectId:string}>=[],opened:Array<{windowId:string;projectFile:string}>=[],released:string[]=[],active=new Map<string,ProjectEntryWindow>(),listeners=new Set<(event:ProjectEntryWindowRevoked)=>void>();
 const port:NonNullable<ProjectWindowHostOptions<ProjectNativeWindow>['projectEntries']>={
  acquire:async input=>{acquired.push({...input});const value=projectWindowLeaseValue(input.windowId,input.projectId);active.set(input.windowId,value);return value;},
  openPath:async input=>{opened.push({...input});throw Object.assign(new Error('No path in this fixture'),{code:'PROJECT_NOT_FOUND'});},
  release:({windowId})=>{released.push(windowId);active.delete(windowId);},
  onWindowRevoked:listener=>{listeners.add(listener);return()=>{listeners.delete(listener);};},
 };
 return {port,acquired,opened,released,active,revoke(windowId:string,projectId=active.get(windowId)?.project.projectId){if(!projectId)throw Error('Missing fixture project');active.delete(windowId);for(const listener of listeners)listener({windowId,projectId});}};
}
