import {z} from 'zod';
import {timelineOutputPreset} from './timeline-output-geometry.ts';
const id=z.string().uuid(),date=z.string().datetime();
export const projectSummaryCoverSchema=z.object({assetId:id,mimeType:z.enum(['image/png','image/jpeg','image/webp','video/mp4','video/webm']),url:z.string().regex(/^\/media\/[a-f0-9-]{36}$/iu)}).strict().refine(value=>value.url===`/media/${value.assetId}`);
export const projectSummarySchema=z.object({
  id,name:z.string().min(1).max(150),description:z.string().max(2000),revision:z.number().int().positive(),createdAt:date,updatedAt:date,
  fps:z.literal(30),width:z.number().int(),height:z.number().int(),presetId:z.string(),
  shotCount:z.number().int().nonnegative(),durationFrames:z.number().int().nonnegative(),lastOpenedAt:date.nullable(),
  cover:projectSummaryCoverSchema.nullable(),
}).strict().refine(value=>timelineOutputPreset(value)?.id===value.presetId);
export const projectHomeSchemas={'project.summary.list':z.object({}).strict()};
export const projectHomeDescriptions={'project.summary.list':'只读列出项目首页摘要：封面、真实时间线规格、镜头数、时长、内容更新时间与本机最近打开时间；不初始化时间线、不生成缩略图或调用供应商。'};
export type ProjectSummary=z.infer<typeof projectSummarySchema>;
export const projectSummaryListSchema=z.array(projectSummarySchema).max(4096);
