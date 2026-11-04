import {lstatSync} from 'node:fs';
import {AppError} from '../../../contracts/src/app-error.ts';
import {mediaReferenceSchema} from '../../../contracts/src/media-reference.ts';
import {referencePathForRealFile,resolveReferencePath} from '../media-reference/paths.ts';

/** Only ownership fields change. User text and entity/provenance IDs do not
 * become project IDs merely because their string happens to equal one. */
export function rewriteProjectOwnership(value:unknown,oldId:string,newId:string,projectRow=false):unknown {
 if(Array.isArray(value))return value.map(item=>rewriteProjectOwnership(item,oldId,newId));
 if(value===null||typeof value!=='object'||ArrayBuffer.isView(value))return value;
 return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,
  (key==='projectId'||projectRow&&key==='id')&&item===oldId?newId:rewriteProjectOwnership(item,oldId,newId)]));
}

export function rewriteProjectCopyRow(table:string,input:Record<string,unknown>,oldId:string,newId:string):Record<string,unknown> {
 const row={...input};
 if(row.projectId===oldId)row.projectId=newId;
 if(table==='projects'&&row.id===oldId)row.id=newId;
 if(table==='agent_task_target_revisions_v2'&&(row.kind==='project'||row.kind==='timeline')&&row.targetId===oldId)row.targetId=newId;
 if(typeof row.data==='string')row.data=JSON.stringify(rewriteProjectOwnership(JSON.parse(row.data),oldId,newId,table==='projects'));
 return row;
}

/** Rebase a reference without reading the material. Missing files remain
 * references to the same location rather than being silently discarded. */
export function relocateProjectCopyReference(data:Record<string,unknown>,from:string,to:string):void {
 const parsed=mediaReferenceSchema.safeParse(data.reference);
 if(!parsed.success||parsed.data.pathForm==='absolute')return;
 const file=resolveReferencePath(from,parsed.data);
 if(file===null)throw new AppError('PROJECT_BACKUP_COPY_FAILED','无法安全地复制项目内容',409,{reason:'media-reference'});
 let sameVolume=false;
 try{sameVolume=lstatSync(from).dev===lstatSync(to).dev;}catch{}
 data.reference={...parsed.data,...referencePathForRealFile(to,file,sameVolume)};
}
