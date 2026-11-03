import {createHash} from 'node:crypto';
import {isProjectStore} from '../project-file/store.ts';
import type {ProjectStore} from '../project-file/store.ts';
import {projectVersionSchemas,projectVersionSaveResponseSchema} from '../../../contracts/src/project-version-operations.ts';
import type {ProjectVersionListInput,ProjectVersionSaveInput,ProjectVersionPreviewInput} from '../../../contracts/src/project-version-operations.ts';
import {captureProjectDocumentInside,canonicalJson} from './document.ts';
import {encodeProjectDocument,decodeProjectDocument} from './codec.ts';
import type {EncodedProjectDocument} from './codec.ts';
import {readVersion,storeManualVersionInside,versionError,versionSummary} from './repository.ts';
import {encodeCursor,decodeCursor} from './pagination.ts';
import {previewDifferences} from './preview.ts';

/** All writes stay on the real owner's attached history connection. Preview
 * and list never restore content, replay effects, or read media files. */
export function createProjectVersions(store:ProjectStore){
  const assertProject=(projectId:string):void=>{
    if(!isProjectStore(store))throw new TypeError('Versions require a live project store');
    if(projectId!==store.projectId)throw versionError('PROJECT_ID_MISMATCH','版本请求与项目宿主不一致。',400);
  };
  const list=(raw:ProjectVersionListInput)=>{
    const input=projectVersionSchemas['project.version.list'].parse(raw);assertProject(input.projectId);
    const limit=input.limit??100;
    let anchor:{createdAt:string;id:string}|undefined;
    if(input.cursor){
      const cursor=decodeCursor(input.cursor);
      if(cursor.operation!=='list'||cursor.projectId!==input.projectId||cursor.limit!==limit||typeof cursor.createdAt!=='string'||typeof cursor.id!=='string')throw versionError('PROJECT_VERSION_CURSOR_INVALID','版本列表游标不属于此请求。',400);
      anchor={createdAt:cursor.createdAt,id:cursor.id};
    }
    const rows=anchor?store.db.prepare('SELECT * FROM main.project_versions WHERE projectId=? AND (createdAt<? OR (createdAt=? AND id<?)) ORDER BY createdAt DESC,id DESC LIMIT ?').all(input.projectId,anchor.createdAt,anchor.createdAt,anchor.id,limit+1)
      :store.db.prepare('SELECT * FROM main.project_versions WHERE projectId=? ORDER BY createdAt DESC,id DESC LIMIT ?').all(input.projectId,limit+1);
    const versions=rows.slice(0,limit).map(versionSummary),last=versions.at(-1);
    return {projectId:input.projectId,versions,nextCursor:rows.length>limit&&last?encodeCursor({operation:'list',projectId:input.projectId,limit,createdAt:last.createdAt,id:last.id}):null};
  };
  const save=(raw:ProjectVersionSaveInput)=>{
    const input=projectVersionSchemas['project.version.save'].parse(raw);assertProject(input.projectId);
    const inputDigest=createHash('sha256').update(canonicalJson({operation:'project.version.save',projectId:input.projectId,name:input.name??null})).digest('hex');
    return store.tx(()=>{
      const old=store.db.prepare('SELECT operation,inputDigest,response FROM main.project_version_requests WHERE projectId=? AND requestId=?').get(input.projectId,input.requestId);
      if(old){
        if(old.operation!=='project.version.save'||old.inputDigest!==inputDigest)throw versionError('REQUEST_ID_REUSED','请求 ID 已用于不同的版本操作。');
        let response:unknown;
        try{response=JSON.parse(String(old.response));}catch{throw versionError('PROJECT_VERSION_RECORD_INVALID','版本回执损坏。',422);}
        const parsed=projectVersionSaveResponseSchema.safeParse(response);
        if(!parsed.success||parsed.data.projectId!==input.projectId||parsed.data.requestId!==input.requestId)throw versionError('PROJECT_VERSION_RECORD_INVALID','版本回执损坏。',422);
        return parsed.data;
      }
      const document=captureProjectDocumentInside(store),blob=encodeProjectDocument(document);
      const version=storeManualVersionInside(store.db,input.projectId,input.name??null,document.evidence.contentSequence,blob);
      const result={projectId:input.projectId,requestId:input.requestId,version};
      store.db.prepare('INSERT INTO main.project_version_requests(projectId,requestId,operation,inputDigest,response) VALUES(?,?,?,?,?)').run(input.projectId,input.requestId,'project.version.save',inputDigest,JSON.stringify(result));
      return result;
    });
  };
  const preview=(raw:ProjectVersionPreviewInput)=>{
    const input=projectVersionSchemas['project.version.preview'].parse(raw);assertProject(input.projectId);
    return store.tx(()=>{
      const row=readVersion(store.db,input.projectId,input.versionId),version=versionSummary(row);
      const blob=store.db.prepare('SELECT * FROM main.project_version_blobs WHERE hash=?').get(String(row.blobHash));
      if(!blob)throw versionError('PROJECT_VERSION_RECORD_INVALID','版本正文缺失。',422);
      const document=decodeProjectDocument(blob as unknown as EncodedProjectDocument);
      if(document.projectId!==input.projectId||document.evidence.contentSequence!==version.contentSequence)throw versionError('PROJECT_VERSION_RECORD_INVALID','版本正文与摘要不一致。',422);
      const current=captureProjectDocumentInside(store);
      const changes=previewDifferences(store,document,current,Number(row.mioChangeRowid),version.createdAt);
      const previewDigest=createHash('sha256').update(canonicalJson({versionId:version.id,blobHash:row.blobHash,current,changes})).digest('hex');
      const limit=input.limit??100;
      let offset=0;
      if(input.cursor){
        const cursor=decodeCursor(input.cursor);
        if(cursor.operation!=='preview'||cursor.projectId!==input.projectId||cursor.versionId!==input.versionId||cursor.limit!==limit||cursor.digest!==previewDigest||!Number.isSafeInteger(cursor.offset)||Number(cursor.offset)<0||Number(cursor.offset)>changes.length)throw versionError('PROJECT_VERSION_CURSOR_INVALID','预览分页已过期，请重新读取。',400);
        offset=Number(cursor.offset);
      }
      const page=changes.slice(offset,offset+limit),next=offset+page.length;
      return {projectId:input.projectId,version,contentSequence:current.evidence.contentSequence,previewDigest,totalChanges:changes.length,
        keptCurrentCount:changes.filter(change=>change.action==='keep-current').length,changes:page,
        nextCursor:next<changes.length?encodeCursor({operation:'preview',projectId:input.projectId,versionId:input.versionId,limit,digest:previewDigest,offset:next}):null,restoreAvailable:false as const};
    });
  };
  return {list,save,preview};
}
