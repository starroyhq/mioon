import {createHash} from 'node:crypto';
import {isProjectStore} from '../project-file/store.ts';
import type {ProjectStore} from '../project-file/store.ts';
import {readProjectContentStamp} from '../project-file/content-stamp.ts';
import {projectVersionSchemas,projectVersionSaveResponseSchema,projectVersionRestoreResponseSchema} from '../../../contracts/src/project-version-operations.ts';
import type {ProjectVersionListInput,ProjectVersionSaveInput,ProjectVersionPreviewInput,ProjectVersionRestoreInput,ProjectVersionRestoreResponse} from '../../../contracts/src/project-version-operations.ts';
import {captureProjectDocumentInside,canonicalJson} from './document.ts';
import {encodeProjectDocument,decodeProjectDocument} from './codec.ts';
import type {EncodedProjectDocument} from './codec.ts';
import {readVersion,storeManualVersionInside,versionError,versionSummary} from './repository.ts';
import {pinProjectVersion} from './retention.ts';
import {encodeCursor,decodeCursor} from './pagination.ts';
import {buildRestorePlan,projectVersionDifferenceForDisplay} from './preview.ts';
import {applyRestorePlanInside} from './restore.ts';
import {saveBeforeBulkChangeInside} from './capture.ts';

export interface ProjectVersionsOptions {
  readonly assertMutationAllowed?: () => void;
  /** Synchronous host admission; it must not wait for its own RPC lease. */
  readonly assertRestoreAllowed?: () => void;
  /** Recovery sessions archive the entire old execution domain. Preview its
   * empty replacement without constructing a worker, Mio or normal services. */
  readonly executionDomain?: 'current' | 'empty';
  /** Trusted host evidence joins the successful restore transaction. An exact
   * ACK replay never invokes this hook, and any hook failure rolls back all. */
  readonly beforeRestoreCommit?: (result: ProjectVersionRestoreResponse) => void;
  /** Kernel-only fresh-history cleanup, after content apply and before the
   * final pair is read. It cannot change the confirmed planning baseline. */
  readonly afterRestoreApplyInside?: () => void;
}

/** All writes stay on the real owner's attached history connection. Preview
 * and list never restore content, replay effects, or read media files. */
export function createProjectVersions(store:ProjectStore,options:ProjectVersionsOptions={}){
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
      const release=pinProjectVersion(store.db,input.versionId);
      try{
      const blob=store.db.prepare('SELECT * FROM main.project_version_blobs WHERE hash=?').get(String(row.blobHash));
      if(!blob)throw versionError('PROJECT_VERSION_RECORD_INVALID','版本正文缺失。',422);
      const document=decodeProjectDocument(blob as unknown as EncodedProjectDocument);
      if(document.projectId!==input.projectId||document.evidence.contentSequence!==version.contentSequence)throw versionError('PROJECT_VERSION_RECORD_INVALID','版本正文与摘要不一致。',422);
      const current=captureProjectDocumentInside(store);
      const {contentToken}=readProjectContentStamp(store.db);
      const {changes}=buildRestorePlan(store,document,current,Number(row.mioChangeRowid),version.createdAt,options);
      const previewDigest=createHash('sha256').update(canonicalJson({versionId:version.id,blobHash:row.blobHash,current,contentToken,changes})).digest('hex');
      const limit=input.limit??100;
      let offset=0;
      if(input.cursor){
        const cursor=decodeCursor(input.cursor);
        if(cursor.operation!=='preview'||cursor.projectId!==input.projectId||cursor.versionId!==input.versionId||cursor.limit!==limit||cursor.digest!==previewDigest||!Number.isSafeInteger(cursor.offset)||Number(cursor.offset)<0||Number(cursor.offset)>changes.length)throw versionError('PROJECT_VERSION_CURSOR_INVALID','预览分页已过期，请重新读取。',400);
        offset=Number(cursor.offset);
      }
      const page=changes.slice(offset,offset+limit),next=offset+page.length;
      return {projectId:input.projectId,version,contentSequence:current.evidence.contentSequence,contentToken,previewDigest,totalChanges:changes.length,
        keptCurrentCount:changes.filter(change=>change.action==='keep-current').length,changes:page.map(projectVersionDifferenceForDisplay),
        nextCursor:next<changes.length?encodeCursor({operation:'preview',projectId:input.projectId,versionId:input.versionId,limit,digest:previewDigest,offset:next}):null,restoreAvailable:typeof options.assertMutationAllowed==='function'};
      }finally{release();}
    });
  };
  const restore=(raw:ProjectVersionRestoreInput)=>{
    const input=projectVersionSchemas['project.version.restore'].parse(raw);assertProject(input.projectId);
    const assertMutationAllowed=options.assertMutationAllowed;
    if(!assertMutationAllowed)throw new TypeError('Version restoration requires application write admission');
    assertMutationAllowed();
    const inputDigest=createHash('sha256').update(canonicalJson({operation:'project.version.restore',...input})).digest('hex');
    let release:(()=>void)|undefined;
    try{return store.tx(()=>{
      const old=store.db.prepare('SELECT operation,inputDigest,response FROM main.project_version_requests WHERE projectId=? AND requestId=?').get(input.projectId,input.requestId);
      if(old){
        if(old.operation!=='project.version.restore'||old.inputDigest!==inputDigest)throw versionError('REQUEST_ID_REUSED','请求 ID 已用于不同的版本操作。');
        let response:unknown;
        try{response=JSON.parse(String(old.response));}catch{throw versionError('PROJECT_VERSION_RECORD_INVALID','版本恢复回执损坏。',422);}
        const result=projectVersionRestoreResponseSchema.safeParse(response);
        if(!result.success||result.data.projectId!==input.projectId||result.data.requestId!==input.requestId||result.data.versionId!==input.versionId)
          throw versionError('PROJECT_VERSION_RECORD_INVALID','版本恢复回执损坏。',422);
        return result.data;
      }
      options.assertRestoreAllowed?.();
      release=pinProjectVersion(store.db,input.versionId);
      const row=readVersion(store.db,input.projectId,input.versionId),version=versionSummary(row);
      const blob=store.db.prepare('SELECT * FROM main.project_version_blobs WHERE hash=?').get(String(row.blobHash));
      if(!blob)throw versionError('PROJECT_VERSION_RECORD_INVALID','版本正文缺失。',422);
      const document=decodeProjectDocument(blob as unknown as EncodedProjectDocument);
      if(document.projectId!==input.projectId||document.evidence.contentSequence!==version.contentSequence)throw versionError('PROJECT_VERSION_RECORD_INVALID','版本正文与摘要不一致。',422);
      const current=captureProjectDocumentInside(store);
      const stamp=readProjectContentStamp(store.db);
      if(current.evidence.contentSequence!==input.expectedContentSequence||stamp.contentToken!==input.expectedContentToken)throw versionError('PROJECT_VERSION_BASELINE_CHANGED','项目内容已变化，请重新预览。');
      const plan=buildRestorePlan(store,document,current,Number(row.mioChangeRowid),version.createdAt,options);
      const digest=createHash('sha256').update(canonicalJson({versionId:version.id,blobHash:row.blobHash,current,contentToken:stamp.contentToken,changes:plan.changes})).digest('hex');
      if(digest!==input.previewDigest)throw versionError('PROJECT_VERSION_PREVIEW_CHANGED','恢复计划已变化，请重新预览。');
      const before=saveBeforeBulkChangeInside(store,{trigger:'restore',requestId:input.requestId,document:current,assertMutationAllowed});
      applyRestorePlanInside(store,plan,{requestId:input.requestId});
      options.afterRestoreApplyInside?.();
      const after=readProjectContentStamp(store.db);
      const result=projectVersionRestoreResponseSchema.parse({projectId:input.projectId,requestId:input.requestId,versionId:input.versionId,beforeVersionId:before.id,
        contentSequence:Number(after.contentSequence),contentToken:after.contentToken,totalChanges:plan.changes.length,appliedChanges:plan.changes.filter(change=>change.action!=='keep-current'),keptCurrent:plan.changes.filter(change=>change.action==='keep-current')});
      const response=JSON.stringify(result);
      if(Buffer.byteLength(response)>65536)throw versionError('PROJECT_VERSION_RECEIPT_LIMIT','完整恢复回执超过容量上限，未应用恢复。',413);
      assertMutationAllowed();
      store.db.prepare('INSERT INTO main.project_version_requests(projectId,requestId,operation,inputDigest,response) VALUES(?,?,?,?,?)')
        .run(input.projectId,input.requestId,'project.version.restore',inputDigest,response);
      options.beforeRestoreCommit?.(result);
      assertMutationAllowed();
      return result;
    });}finally{release?.();}
  };
  return {list,save,preview,restore};
}
