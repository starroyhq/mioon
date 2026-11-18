import {z} from 'zod';

// Release-compatible fields used only while planning a format-5 conversion.
const id = z.string().uuid();
const integer = z.number().int().safe().nonnegative();
const shotSchema = z.object({id, projectId: id, orderIndex: integer, duration: z.number().positive(), selectedVersionId: id.nullable()}).passthrough();
const nodeSchema = z.object({id, projectId: id, type: z.string(), assetId: id.nullable().optional()}).passthrough();
const edgeSchema = z.object({id, projectId: id, source: id, target: id}).passthrough();
const assetSchema = z.object({id, projectId: id, mimeType: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/u).nullable(), duration: z.number().nonnegative().nullable().optional()}).passthrough();
const versionSchema = z.object({id, projectId: id, shotId: id, assetId: id, jobId: id, sha256: z.string().regex(/^[a-f0-9]{64}$/u).optional()}).passthrough();
const bindingSchema = z.object({id, projectId: id, shotId: id, subjectId: id, subjectVersionId: id.nullable()}).passthrough();
const trackSchema = z.object({id, kind: z.string(), orderIndex: integer, hidden: z.boolean(), muted: z.boolean()}).passthrough();
const clipSchema = z.object({id, trackId: id, assetId: id, startFrame: integer, durationFrames: integer, sourceInFrame: integer,
  rect: z.object({x: z.number(), y: z.number(), width: z.number(), height: z.number()}), gain: z.number(),
  shotId: id.optional(), versionId: id.optional(), jobId: id.optional(),
}).passthrough();
const timelineSchema = z.object({id, projectId: id, revision: integer, width: integer, height: integer, fps: integer,
  tracks: z.array(trackSchema), clips: z.array(clipSchema), durationFrames: integer,
  subtitles: z.object({profileId: z.string().optional(), basisPresetId: z.string().optional(),
    cues: z.array(z.object({id, text: z.string(), startFrame: integer, durationFrames: integer}).passthrough()),
  }).passthrough().optional(),
}).passthrough();

export const format5LegacySourceSchemas = Object.freeze({shotSchema,nodeSchema,edgeSchema,assetSchema,versionSchema,bindingSchema,timelineSchema});
