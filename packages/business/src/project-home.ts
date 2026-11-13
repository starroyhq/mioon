import {timelineOutputPreset,DEFAULT_TIMELINE_OUTPUT_PRESET} from '../../contracts/src/timeline-output-geometry.ts';
import {projectSummaryListSchema,projectSummaryCoverSchema} from '../../contracts/src/project-home.ts';
import type {ProjectSummary} from '../../contracts/src/project-home.ts';
import type {DatabaseSync} from 'node:sqlite';
import {canvasActiveCondition,canvasActiveEdgeCondition} from './canvas-active.ts';

interface Store{db:DatabaseSync}
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(value);
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function invalid():never{throw Object.assign(new Error('项目首页数据无法安全读取。'),{code:'PROJECT_SUMMARY_UNAVAILABLE',status:409});}
function date(value:unknown):value is string{return typeof value==='string'&&Number.isFinite(Date.parse(value));}
const visual=new Set(['image/png','image/jpeg','image/webp','video/mp4','video/webm']);
type Table='projects'|'shots'|'assets'|'versions'|'timelines'|'nodes'|'edges';

function rows(db:DatabaseSync,table:Table,projectId?:string):Record<string,unknown>[] {
    const active=table==='edges'?canvasActiveEdgeCondition(db,'record'):table==='shots'||table==='nodes'?canvasActiveCondition(db,'record'):'1';
    const scope=projectId?`${table==='projects'?'id':'projectId'}=? AND `:'';
    const found=db.prepare(`SELECT id,CASE WHEN typeof(data)='text' AND length(CAST(data AS BLOB)) BETWEEN 1 AND 2097152 THEN data END AS data FROM ${table} record WHERE ${scope}${active} ORDER BY id LIMIT 4097`).all(...(projectId?[projectId]:[]));
    if(found.length>4096)invalid();let bytes=0;
    return found.map(row=>{
      if(!object(row)||!uuid(row.id)||typeof row.data!=='string'||(bytes+=Buffer.byteLength(row.data))>16*1024*1024)invalid();
      let value:unknown;try{value=JSON.parse(row.data);}catch{invalid();}
      if(!object(value)||value.id!==row.id||projectId!==undefined&&table!=='projects'&&value.projectId!==projectId)invalid();return value;
    });
  }

function selectCover(projectId:string,shots:Record<string,unknown>[],sourceById:ReadonlyMap<unknown,Record<string,unknown>>,versionById:ReadonlyMap<unknown,Record<string,unknown>>,timeline:Record<string,unknown>|undefined):ProjectSummary['cover']{
    let cover:ProjectSummary['cover']=null;
    function chooseCover(assetId:unknown):void{
      const asset=sourceById.get(assetId);
      if(!cover&&asset&&uuid(asset.id)&&typeof asset.mimeType==='string'&&visual.has(asset.mimeType)){
        const parsed=projectSummaryCoverSchema.safeParse({assetId:asset.id,mimeType:asset.mimeType,url:`/api/project-covers/${projectId}`});
        if(parsed.success)cover=parsed.data;
      }
    }
    for(const shot of shots){
      const version=versionById.get(shot.selectedVersionId);
      if(version&&version.shotId===shot.id)chooseCover(version.assetId);
    }
    if(!cover&&timeline&&Array.isArray(timeline.clips)){
      const clips=timeline.clips.filter(object).sort((a,b)=>Number(a.startFrame)-Number(b.startFrame)||String(a.id).localeCompare(String(b.id)));
      for(const clip of clips)chooseCover(clip.assetId);
    }
  return cover;
}

/** Cover-only background read. The public summary retains all seven table
 * checks; background covers validate the same four source tables and selection
 * order without loading graph nodes/edges or calculating the full summary. */
export function readProjectCover({db}:Store,projectId:string):ProjectSummary['cover']{
  if(!uuid(projectId))invalid();
  const project=rows(db,'projects',projectId)[0];if(!project)return null;
  if(typeof project.name!=='string'||!date(project.createdAt)||!date(project.updatedAt)||!Number.isSafeInteger(project.revision))invalid();
  const shots=rows(db,'shots',projectId).sort((a,b)=>Number(a.orderIndex)-Number(b.orderIndex)||String(a.id).localeCompare(String(b.id))),
    assets=rows(db,'assets',projectId),versions=rows(db,'versions',projectId),timelines=rows(db,'timelines',projectId);
  if(timelines.length>1)invalid();const timeline=timelines[0];
  if(!timelineOutputPreset(timeline??DEFAULT_TIMELINE_OUTPUT_PRESET)||timeline&&(!Number.isSafeInteger(timeline.durationFrames)||Number(timeline.durationFrames)<0))invalid();
  return selectCover(projectId,shots,new Map(assets.map(asset=>[asset.id,asset])),new Map(versions.map(version=>[version.id,version])),timeline);
}

/** SQL reads only: never calls the initializing project.get/timeline.get path or
 * starts a media process while rendering the project list. */
export function createProjectHomeServices({db}:Store,{readRecentOpened=()=>({})}:{readRecentOpened?:()=>Readonly<Record<string,string>>}={}){
  function summary(project:Record<string,unknown>,recent:Readonly<Record<string,string>>):ProjectSummary{
    if(!uuid(project.id)||typeof project.name!=='string'||!date(project.createdAt)||!date(project.updatedAt)||!Number.isSafeInteger(project.revision))invalid();
    const projectId=project.id,shots=rows(db,'shots',projectId).sort((a,b)=>Number(a.orderIndex)-Number(b.orderIndex)||String(a.id).localeCompare(String(b.id))),
      assets=rows(db,'assets',projectId),versions=rows(db,'versions',projectId),timelines=rows(db,'timelines',projectId),nodes=rows(db,'nodes',projectId),edges=rows(db,'edges',projectId);
    if(timelines.length>1)invalid();const timeline=timelines[0],preset=timelineOutputPreset(timeline??DEFAULT_TIMELINE_OUTPUT_PRESET);if(!preset)invalid();
    const sourceById=new Map(assets.map(asset=>[asset.id,asset])),versionById=new Map(versions.map(version=>[version.id,version]));
    const cover=selectCover(projectId,shots,sourceById,versionById,timeline);
    const timelineDuration=timeline?.durationFrames;
    if(timeline&&(!Number.isSafeInteger(timelineDuration)||Number(timelineDuration)<0))invalid();
    const durationFrames=Number(timelineDuration)>0?Number(timelineDuration):shots.reduce((total,shot)=>{
      const version=versionById.get(shot.selectedVersionId),asset=version&&version.shotId===shot.id?sourceById.get(version.assetId):null;
      const duration=typeof asset?.duration==='number'&&Number.isFinite(asset.duration)&&asset.duration>0?asset.duration:shot.duration;
      return total+(typeof duration==='number'&&Number.isFinite(duration)&&duration>0?Math.round(duration*30):0);
    },0);
    const updatedAt=[project,...shots,...assets,...versions,...timelines,...nodes,...edges].reduce((latest,row)=>{
      for(const value of [row.updatedAt,row.createdAt])if(date(value)&&Date.parse(value)>Date.parse(latest))latest=value;return latest;
    },project.updatedAt);
    const opened=recent[projectId];
    return {id:projectId,name:project.name,description:typeof project.description==='string'?project.description:'',revision:Number(project.revision),
      createdAt:project.createdAt,updatedAt,fps:30,width:preset.width,height:preset.height,presetId:preset.id,shotCount:shots.length,durationFrames,
      lastOpenedAt:date(opened)?opened:null,cover};
  }
  return {handlers:{'project.summary.list':():ProjectSummary[]=>{
    const recent=readRecentOpened(),result=rows(db,'projects').map(project=>summary(project,recent));
    result.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||a.id.localeCompare(b.id));
    const parsed=projectSummaryListSchema.safeParse(result);if(!parsed.success)invalid();return parsed.data;
  }}};
}
