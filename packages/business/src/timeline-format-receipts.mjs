import {createHash} from 'node:crypto';
import {AppError,timelineFormatSchemas} from '@mioon/contracts';
export const canonicalFormatValue=value=>JSON.stringify(value,(_,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
export const formatRequestHash=input=>createHash('sha256').update(canonicalFormatValue({operation:'timeline.format.set',input})).digest('hex');
const invalid=()=>{throw new AppError('INVALID_TIMELINE_SNAPSHOT','时间线或已保存的请求响应无效',409);};
export function readTimelineFormatProvenance(db,input,requestHash){
 const row=db.prepare(`SELECT requestId,projectId,CASE WHEN typeof(input)='text' AND length(CAST(input AS BLOB)) BETWEEN 1 AND 2048 THEN input END AS input FROM timeline_format_requests WHERE requestId=?`).get(input.requestId);
 let saved;try{saved=JSON.parse(row?.input);}catch{invalid();}
 if(!row||!timelineFormatSchemas['timeline.format.set'].safeParse(saved).success||row.projectId!==input.projectId||row.requestId!==input.requestId||
  row.input!==canonicalFormatValue(saved)||row.input!==canonicalFormatValue(input)||requestHash!==formatRequestHash(saved))invalid();
 return saved;
}
