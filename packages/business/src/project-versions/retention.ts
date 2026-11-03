import type {DatabaseSync} from 'node:sqlite';
import {isProjectId} from '../../../contracts/src/project-file.ts';
import {versionError,versionSummary} from './repository.ts';

// A pin belongs to the exact live owner. Reopening a database cannot inherit
// the previous connection's in-flight operation or keep it alive accidentally.
const pins=new WeakMap<DatabaseSync,Map<string,number>>();
export function pinProjectVersion(db:DatabaseSync,versionId:string):()=>void{
  if(!isProjectId(versionId))throw new TypeError('A version ID is required');
  if(!db.prepare('SELECT 1 FROM main.project_versions WHERE id=?').get(versionId))throw versionError('PROJECT_VERSION_NOT_FOUND','找不到这个项目版本。',404);
  let owned=pins.get(db);
  if(!owned){owned=new Map();pins.set(db,owned);}
  owned.set(versionId,(owned.get(versionId)??0)+1);
  const counts=owned;
  let released=false;
  return ()=>{
    if(released)return;
    released=true;
    const count=counts.get(versionId)??0;
    if(count>1)counts.set(versionId,count-1);else counts.delete(versionId);
    if(!counts.size)pins.delete(db);
  };
}

export function projectVersionTimeZone(timeZone?:string):string{
  const value=timeZone??new Intl.DateTimeFormat().resolvedOptions().timeZone;
  // UTC and IANA names are persisted in a daily mark. Fixed-offset strings
  // cannot describe a zone's daylight-saving calendar across seven days.
  if(typeof value!=='string'||!value||/^[+-]/u.test(value))throw new TypeError('An IANA time zone is required');
  return new Intl.DateTimeFormat('en-US',{timeZone:value}).resolvedOptions().timeZone;
}
function dateFormatter(timeZone:string):Intl.DateTimeFormat{
  return new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'});
}
function calendarDay(now:Date,formatter:Intl.DateTimeFormat):string{
  if(!(now instanceof Date)||!Number.isFinite(now.getTime()))throw new TypeError('A valid version date is required');
  const parts=formatter.formatToParts(now),part=(type:string)=>parts.find(entry=>entry.type===type)!.value;
  return `${part('year').padStart(4,'0')}-${part('month')}-${part('day')}`;
}
export function projectVersionLocalDay(now:Date,timeZone:string):string{
  return calendarDay(now,dateFormatter(projectVersionTimeZone(timeZone)));
}
export interface PruneProjectVersionsOptions {
  readonly projectId:string;
  readonly now?:Date;
  readonly timeZone?:string;
  readonly protectedIds?:readonly string[];
}
export function pruneProjectVersionsInside(db:DatabaseSync,{projectId,now=new Date(),timeZone,protectedIds=[]}:PruneProjectVersionsOptions):{deletedVersions:number;deletedBlobs:number}{
  if(!db.isTransaction)throw new TypeError('Version retention requires a transaction');
  if(!isProjectId(projectId))throw new TypeError('A project ID is required');
  if(db.prepare('SELECT projectId FROM main.history_state WHERE singleton=1').get()?.projectId!==projectId)throw versionError('PROJECT_ID_MISMATCH','版本清理与项目宿主不一致。',400);
  const formatter=dateFormatter(projectVersionTimeZone(timeZone)),today=calendarDay(now,formatter);
  const calendar=new Date(`${today}T00:00:00.000Z`),recentDays=new Set<string>();
  // Walk calendar dates, not elapsed 24-hour intervals in a DST zone.
  for(let day=0;day<7;day++){recentDays.add(calendar.toISOString().slice(0,10));calendar.setUTCDate(calendar.getUTCDate()-1);}
  const automatic=db.prepare("SELECT * FROM main.project_versions WHERE projectId=? AND trigger<>'manual' ORDER BY createdAt DESC,id DESC").all(projectId).map(versionSummary);
  for(const version of automatic){
    const date=new Date(version.createdAt);
    if(!Number.isFinite(date.getTime())||date.toISOString()!==version.createdAt)throw versionError('PROJECT_VERSION_RECORD_INVALID','版本保存日期无效，未执行清理。',422);
  }
  const keep=new Set([...automatic.slice(0,20).map(version=>version.id),...protectedIds,...(pins.get(db)?.keys()??[])]),represented=new Set<string>();
  for(const version of [...automatic].reverse()){
    const day=calendarDay(new Date(version.createdAt),formatter);
    if(recentDays.has(day)&&!represented.has(day)){represented.add(day);keep.add(version.id);}
  }
  const remove=db.prepare("DELETE FROM main.project_versions WHERE projectId=? AND id=? AND trigger<>'manual'");
  let deletedVersions=0;
  for(const version of automatic)if(!keep.has(version.id))deletedVersions+=Number(remove.run(projectId,version.id).changes);
  // Receipts and capture marks intentionally do not own blobs: their stable
  // acknowledgements survive automatic rotation without resurrecting content.
  const deletedBlobs=Number(db.prepare('DELETE FROM main.project_version_blobs WHERE NOT EXISTS(SELECT 1 FROM main.project_versions WHERE blobHash=project_version_blobs.hash)').run().changes);
  return {deletedVersions,deletedBlobs};
}
