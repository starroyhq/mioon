import {createHash,randomUUID} from 'node:crypto';
import {constants,lstatSync,openSync,fstatSync,fsyncSync,fchmodSync,closeSync,realpathSync} from 'node:fs';
import path from 'node:path';
import {ensurePrivateDirectory,validatePrivateDirectory,validateManagedFile,readPrivateFile,writePrivateFileAtomic,getWindowsManagedFileIO} from '../../contracts/src/private-storage.ts';
import {outputArtifactSchema,outputArtifactFileInfoSchema} from '../../contracts/src/output-artifact.ts';
import type {OutputArtifact} from '../../contracts/src/output-artifact.ts';
import type {ProjectOutputOwner} from '../../contracts/src/project-output-publication.ts';
import {timelineExportAudioCheckSchema} from '../../contracts/src/timeline-export-float.ts';
import {timelineExportOutputFrames} from '../../contracts/src/timeline-export-range.ts';
import type {ProjectStore} from './project-file/store.ts';
import {registeredProjectStore} from './project-media-storage.ts';
import {assertProjectOutputStore,outputFileIdentity,sameOutputIdentity} from './project-output-owner.ts';
import {isProjectFileHeld} from './project-file/held-files.ts';
import {isAppLibraryHeld} from './app-db/connection.ts';
import {floatSnapshotSha256} from './timeline-float-outcome.ts';
import type {MediaFileInfo} from './media.ts';

export const outputArtifactDigest=(value:string):string=>createHash('sha256').update(value).digest('hex');
const invalid=():never=>{throw Object.assign(Error('已完成的本地产物回执无法核对'),{code:'INVALID_OUTPUT_ARTIFACT'});};
const sameOwner=(a:ProjectOutputOwner,b:ProjectOutputOwner):boolean=>a.kind===b.kind&&a.id===b.id&&a.requestId===b.requestId&&a.inputHash===b.inputHash;
function folder(kind:OutputArtifact['kind']):string{return kind==='generation'?'job-results':'export-staging';}
function directory(store:ProjectStore,owner:ProjectOutputOwner,kind:OutputArtifact['kind'],create=false):string{
 assertProjectOutputStore(store);if(owner.kind!==kind||!/^[a-f0-9-]{36}$/u.test(owner.id))invalid();
 const base=path.join(store.tempDir,folder(kind)),directory=path.join(base,owner.id);
 validatePrivateDirectory(store.tempDir);if(create){ensurePrivateDirectory(base,{create:true});ensurePrivateDirectory(directory,{create:true});}
 else if(!lstatSync(directory,{throwIfNoEntry:false}))return directory;
 validatePrivateDirectory(directory);return directory;
}
function syncDirectory(directory:string):void{
 if(process.platform==='win32'){getWindowsManagedFileIO().syncDirectory(directory,{root:directory,private:true});return;}
 const before=validatePrivateDirectory(directory),fd=openSync(directory,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const opened=fstatSync(fd);if(!before||before.dev!==opened.dev||before.ino!==opened.ino||!opened.isDirectory())invalid();fsyncSync(fd);const after=validatePrivateDirectory(directory);if(!after||after.dev!==opened.dev||after.ino!==opened.ino)invalid();}finally{closeSync(fd);}
}
export function createOutputArtifactStage(store:ProjectStore,owner:ProjectOutputOwner,kind:OutputArtifact['kind']):string{
 return path.join(directory(store,owner,kind,true),`stage-${randomUUID()}.mp4`);
}
/** Providers create this fresh random stage under the already-private parent.
 * Seal that owned descriptor before applying the private artifact policy. */
export function sealOutputArtifactStage(store:ProjectStore,owner:ProjectOutputOwner,file:string):void{
 const dir=directory(store,owner,'generation');if(path.dirname(file)!==dir)invalid();
 const before=lstatSync(file,{bigint:true});if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||realpathSync(file)!==file||isProjectFileHeld(outputFileIdentity(before))||isAppLibraryHeld(outputFileIdentity(before)))invalid();
 const fd=openSync(file,constants.O_RDWR|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{const opened=fstatSync(fd,{bigint:true});if(!sameOutputIdentity(outputFileIdentity(before),outputFileIdentity(opened))||opened.nlink!==1n)invalid();fchmodSync(fd,0o600);fsyncSync(fd);assertProjectOutputStore(store);}finally{closeSync(fd);}
}
/** A provider may write only this worker-owned private stage. Returning null
 * preserves the old workspace destination policy without granting a path. */
export function resolveJobOutputDestination(root:string,destination:string):string|null{
 const store=registeredProjectStore(root);if(!store)return null;
 const relative=path.relative(store.tempDir,path.resolve(destination)).split(path.sep).join('/'),parts=relative.split('/');
 if(parts[0]!=='job-results')return null;
 if(parts.length!==3||parts[0]!=='job-results'||!/^[a-f0-9-]{36}$/u.test(parts[1]??'')||!/^stage-[a-f0-9-]{36}\.mp4$/u.test(parts[2]??''))throw Object.assign(Error('Output must name an owned private job stage'),{code:'UNSAFE_OUTPUT_PATH'});
 const job:unknown=store.get('jobs',parts[1]!);
 if(!job||typeof job!=='object'||!('projectId'in job)||job.projectId!==store.projectId||!('status'in job)||job.status!=='downloading')invalid();
 const parent=path.dirname(destination);validatePrivateDirectory(parent);assertProjectOutputStore(store);if(realpathSync(parent)!==parent)invalid();return path.resolve(destination);
}
export function readOutputArtifact(store:ProjectStore,owner:ProjectOutputOwner,kind:OutputArtifact['kind'],sourceIdentity:string):OutputArtifact|null{
 const dir=directory(store,owner,kind),raw=readPrivateFile(path.join(dir,'complete.json'),{root:store.tempDir,maxBytes:32768,encoding:'utf8',allowMissing:true});
 if(raw===null)return null;let artifact:OutputArtifact;try{artifact=outputArtifactSchema.parse(JSON.parse(String(raw)));}catch{return invalid();}
 if(artifact.projectId!==store.projectId||artifact.kind!==kind||!sameOwner(artifact.owner,owner)||artifact.sourceIdentity!==sourceIdentity)invalid();return artifact;
}
export function outputArtifactStage(store:ProjectStore,artifact:OutputArtifact):string{
 const file=path.join(store.tempDir,artifact.stageRelativePath);directory(store,artifact.owner,artifact.kind);return file;
}
export function assertOutputArtifactStage(store:ProjectStore,artifact:OutputArtifact):void{
 const file=outputArtifactStage(store,artifact),info=lstatSync(file,{bigint:true});
 if(!info.isFile()||info.isSymbolicLink()||realpathSync(file)!==file||!sameOutputIdentity(artifact.stageIdentity,outputFileIdentity(info))||Number(info.size)!==artifact.info.sizeBytes||isProjectFileHeld(outputFileIdentity(info))||isAppLibraryHeld(outputFileIdentity(info)))invalid();
}
export function writeOutputArtifact(store:ProjectStore,input:{owner:ProjectOutputOwner;kind:OutputArtifact['kind'];sourceIdentity:string;stageFile:string;info:MediaFileInfo;audioCheck?:OutputArtifact['audioCheck']},check:()=>void):OutputArtifact{
 check();const dir=directory(store,input.owner,input.kind,true),info=outputArtifactFileInfoSchema.parse(input.info);
 if(path.dirname(input.stageFile)!==dir)invalid();validateManagedFile(input.stageFile,{root:store.tempDir,private:true,maxBytes:info.sizeBytes});
 const before=lstatSync(input.stageFile,{bigint:true});if(!before.isFile()||before.isSymbolicLink()||Number(before.size)!==info.sizeBytes||isProjectFileHeld(outputFileIdentity(before))||isAppLibraryHeld(outputFileIdentity(before)))invalid();
 const fd=openSync(input.stageFile,constants.O_RDWR|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{const opened=fstatSync(fd,{bigint:true});if(!sameOutputIdentity(outputFileIdentity(before),outputFileIdentity(opened))||before.size!==opened.size||before.mtimeNs!==opened.mtimeNs||before.ctimeNs!==opened.ctimeNs)invalid();fsyncSync(fd);check();}finally{closeSync(fd);}
 const artifact=outputArtifactSchema.parse({version:1,kind:input.kind,projectId:store.projectId,owner:input.owner,sourceIdentity:input.sourceIdentity,
  assetId:randomUUID(),publicationId:randomUUID(),...(input.kind==='generation'?{versionId:randomUUID()}:{}),stageRelativePath:path.relative(store.tempDir,input.stageFile).split(path.sep).join('/'),stageIdentity:outputFileIdentity(before),info,...(input.audioCheck?{audioCheck:input.audioCheck}:{}),createdAt:new Date().toISOString()});
 check();writePrivateFileAtomic(path.join(dir,'complete.json'),JSON.stringify(artifact),{root:store.tempDir,maxBytes:32768});syncDirectory(dir);check();return artifact;
}
/** The private manifest carries an already validated bounded float report.
 * A restart may claim a new local attempt without re-rendering the bytes. */
export function restoredArtifactAudioCheck(artifact:OutputArtifact,record:Record<string,unknown>):OutputArtifact['audioCheck']{
 if(!artifact.audioCheck)return undefined;
 const check=timelineExportAudioCheckSchema.parse(artifact.audioCheck);
 if(check.status!=='complete'||check.code!=='EXPORT_AUDIO_WITHIN_LIMIT'||check.projectId!==artifact.projectId||check.exportId!==artifact.owner.id||check.snapshotSha256!==floatSnapshotSha256(record.snapshot)||check.outputFrames!==timelineExportOutputFrames(record.snapshot as never)||check.output!==null)invalid();
 return timelineExportAudioCheckSchema.parse({...check,attemptId:record.renderAttemptId,output:{assetId:artifact.assetId,sha256:artifact.info.sha256}});
}
