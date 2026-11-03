import {isProjectStore} from '../project-file/store.ts';
import type {ProjectStore} from '../project-file/store.ts';
import type {ProjectVersionSummary} from '../../../contracts/src/project-versions.ts';
import {captureProjectDocumentInside} from './document.ts';
import {encodeProjectDocument} from './codec.ts';
import {storeProjectVersionInside} from './repository.ts';
import {pruneProjectVersionsInside,projectVersionLocalDay,projectVersionTimeZone} from './retention.ts';

export interface DailyProjectVersionOptions {
  readonly assertMutationAllowed:()=>void;
  readonly now?:()=>Date;
  readonly timeZone?:()=>string;
}
/** Failure must reach the lifecycle hook: only that caller may report a daily
 * failure without failing the open. No mark is committed for a failed capture. */
export function captureDailyProjectVersion(store:ProjectStore,options:DailyProjectVersionOptions):ProjectVersionSummary|null{
  if(!options||typeof options.assertMutationAllowed!=='function')throw new TypeError('Daily versions require application write admission');
  options.assertMutationAllowed();
  if(!isProjectStore(store))throw new TypeError('Daily versions require the exact live project store');
  const now=options.now?.()??new Date(),timeZone=projectVersionTimeZone(options.timeZone?.()),day=projectVersionLocalDay(now,timeZone),key=`${day}|${timeZone}`;
  return store.tx(()=>{
    options.assertMutationAllowed();
    if(store.db.prepare("SELECT 1 FROM main.project_version_capture_marks WHERE projectId=? AND kind='daily-open' AND key=?").get(store.projectId,key))return null;
    const boundary=Number(store.db.prepare('SELECT COALESCE(max(rowid),0) n FROM main.mio_changes').get()?.n);
    const document=captureProjectDocumentInside(store),blob=encodeProjectDocument(document);
    const version=storeProjectVersionInside(store.db,{projectId:store.projectId,trigger:'daily-open',contentSequence:document.evidence.contentSequence,blob,mioChangeRowid:boundary,createdAt:now.toISOString()});
    store.db.prepare("INSERT INTO main.project_version_capture_marks(projectId,kind,key,createdAt) VALUES(?,'daily-open',?,?)").run(store.projectId,key,version.createdAt);
    pruneProjectVersionsInside(store.db,{projectId:store.projectId,now,timeZone,protectedIds:[version.id]});
    return version;
  });
}
