import {z} from 'zod';
const id=z.string().uuid(),revision=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const projectRenameInputSchema=z.object({requestId:id,projectId:id,expectedRevision:revision,name:z.string().trim().min(1).max(150)}).strict();
export const projectDeleteInputSchema=z.object({requestId:id,projectId:id,expectedRevision:revision,confirmPermanentDeletion:z.literal(true)}).strict();
export const projectLifecycleSchemas={'project.rename':projectRenameInputSchema,'project.delete':projectDeleteInputSchema};
export const projectLifecycleDescriptions={
  'project.rename':'按项目版本重命名；稳定requestId精确重放，不改时间线或镜头。',
  'project.delete':'危险操作：明确确认后永久删除无运行或待对账任务的项目及独占托管文件、项目草稿；保留外部源文件和原备份。清理未完成时返回pending，原requestId可安全查询并继续本地清理。',
};
export const projectDeleteResponseSchema=z.object({requestId:id,projectId:id,deleted:z.literal(true),cleanup:z.enum(['complete','pending'])}).strict();
const fileIdentity=z.object({relativePath:z.string().regex(/^(?:media|image-staging|frame-staging|agent-imports)\/[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u),dev:z.number().int().nonnegative(),ino:z.number().int().nonnegative(),size:z.number().int().nonnegative(),mtimeMs:z.number().nonnegative(),birthtimeMs:z.number().nonnegative()}).strict();
export const projectDeleteManifestSchema=z.object({version:z.literal(1),projectId:id,files:z.array(fileIdentity).max(8192),companions:z.boolean()}).strict();
export type ProjectDeleteManifest=z.infer<typeof projectDeleteManifestSchema>;
export type ProjectRenameInput=z.infer<typeof projectRenameInputSchema>;
export type ProjectDeleteInput=z.infer<typeof projectDeleteInputSchema>;
