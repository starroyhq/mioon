import {z} from 'zod';

// These arguments contain no authority or project selection. A trusted caller
// supplies project scope separately; exposing these schemas does not grant it.
const page = {
  limit: z.number().int().min(1).max(25).default(10),
  cursor: z.string().max(512).optional(),
};
export const inspectionArgumentSchemas = Object.freeze({
  'project.inspect': z.object({}).strict(),
  'asset.inspect': z.object(page).strict(),
  'shot.inspect': z.object(page).strict(),
  'timeline.inspect': z.object({}).strict(),
});

// Existing authenticated RPC/CLI/MCP clients select a project explicitly.
// No model-facing tool dispatch or model-context injection is introduced here.
export const inspectionSchemas = Object.freeze(Object.fromEntries(
  Object.entries(inspectionArgumentSchemas).map(([operation, schema]) =>
    [operation, schema.extend({projectId: z.string().uuid()}).strict()]),
));
