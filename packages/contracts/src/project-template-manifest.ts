import {z} from 'zod';

const name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u);
const relative = z.string().min(1).max(4096).refine(value => !/[\\\u0000]/u.test(value)
  && value.split('/').every(part => part !== '' && !part.startsWith('.') && !['AGENTS.md', 'history.db', 'cache', 'imports', 'tmp', 'local'].includes(part)), 'Use a non-private relative template path.');
const file = z.object({path: relative, sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), sha256: z.string().regex(/^[a-f0-9]{64}$/u)}).strict();
/** Private server configuration, selected through a trusted catalog. */
export const projectTemplateManifestSchema = z.object({templateId: name, version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), projectFile: file, assets: z.array(file)}).strict();
export type ProjectTemplateManifest = z.infer<typeof projectTemplateManifestSchema>;
