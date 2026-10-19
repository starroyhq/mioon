import React from 'react';
import {useI18n} from './i18n/I18nProvider.tsx';
interface Props{shots:readonly {id:string;duration?:number;selectedVersionId?:string|null}[];versions:readonly {id:string;snapshot?:{duration?:number}}[];jobs:readonly {shotId:string;status:string;createdAt:string}[];nodes:readonly {type:string}[]}
const active=new Set(['queued','submitting','running','downloading','submission_unknown']);
export default function CanvasOverview({shots,versions,jobs,nodes}:Props){
  const {t,formatNumber}=useI18n(),latest=new Map<string,Props['jobs'][number]>();
  for(const job of jobs){const previous=latest.get(job.shotId);if(!previous||job.createdAt>previous.createdAt)latest.set(job.shotId,job);}
  const duration=shots.reduce((sum,shot)=>sum+Math.max(0,Number(versions.find(version=>version.id===shot.selectedVersionId)?.snapshot?.duration??shot.duration)||0),0);
  const rows=[['redesign.board.shots',shots.length],['redesign.board.completed',shots.filter(shot=>versions.some(version=>version.id===shot.selectedVersionId)).length],['redesign.board.generating',shots.filter(shot=>active.has(latest.get(shot.id)?.status??'')).length],['redesign.board.failed',shots.filter(shot=>latest.get(shot.id)?.status==='failed').length],['redesign.board.referenceImages',nodes.filter(node=>node.type==='image').length]] as const;
  return <section className="canvas-overview" data-testid="canvas-overview"><h3>{t('redesign.board.overview')}</h3><dl>{rows.map(([label,value])=><div key={label}><dt>{t(label)}</dt><dd>{formatNumber(value)}</dd></div>)}<div><dt>{t('redesign.board.totalDuration')}</dt><dd>{Math.floor(duration/60)}:{String(Math.floor(duration%60)).padStart(2,'0')}</dd></div></dl></section>;
}
