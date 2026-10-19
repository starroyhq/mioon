import type {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {AppError,timelineFormatSchemas} from '@mioon/contracts';
export const canonicalFormatValue=(value: unknown): string|undefined=>JSON.stringify(value,(_key: string,item: unknown)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
export const formatRequestHash=(input: unknown): string=>createHash('sha256').update(canonicalFormatValue({operation:'timeline.format.set',input}) as string).digest('hex');
const invalid=()=>{throw new AppError('INVALID_TIMELINE_SNAPSHOT','时间线或已保存的请求响应无效',409);};
export function readTimelineFormatProvenance(db: DatabaseSync,input: {projectId: string;requestId?: string},requestHash: string|undefined): void{
 const row=db.prepare(`SELECT requestId,projectId,CASE WHEN typeof(input)='text' AND length(CAST(input AS BLOB)) BETWEEN 1 AND 2048 THEN input END AS input FROM timeline_format_requests WHERE requestId=?`).get(input.requestId as string);
 let saved;try{saved=JSON.parse(row?.input as string);}catch{invalid();}
 if(!row||!timelineFormatSchemas['timeline.format.set'].safeParse(saved).success||row.projectId!==input.projectId||row.requestId!==input.requestId||
  row.input!==canonicalFormatValue(saved)||row.input!==canonicalFormatValue(input)||requestHash!==formatRequestHash(saved))invalid();
 return saved;
}
