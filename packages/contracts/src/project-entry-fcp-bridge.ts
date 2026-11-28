import {z} from 'zod';
import {projectIdSchema} from './project-file.ts';

export const fcpNativeRequest = z.discriminatedUnion('kind', [
  z.object({kind: z.literal('chooseDestination')}).strict(),
  z.object({kind: z.literal('reveal'), identity: z.object({projectId: projectIdSchema, exportId: z.string().uuid()}).strict()}).strict(),
  z.object({kind: z.literal('openInFinalCut'), identity: z.object({projectId: projectIdSchema, exportId: z.string().uuid()}).strict()}).strict(),
  z.object({kind: z.literal('finalCutInstalled')}).strict(),
]);
export const fcpNativeDestination = z.object({token: z.string().uuid(), displayPath: z.string().min(1).max(4096)}).strict();
export const fcpNativeReply = z.discriminatedUnion('ok', [
  z.object({ok: z.literal(true), data: z.union([z.boolean(), fcpNativeDestination, z.null()])}).strict(),
  z.object({ok: z.literal(false), error: z.discriminatedUnion('code', [
    z.object({code: z.literal('FCP_EXPORT_NATIVE_INVALID'), status: z.literal(400)}).strict(),
    z.object({code: z.literal('FCP_EXPORT_NATIVE_UNAVAILABLE'), status: z.literal(503)}).strict(),
  ])}).strict(),
]);
export const fcpNativeInvalid = () => ({ok: false, error: {code: 'FCP_EXPORT_NATIVE_INVALID', status: 400}} as const);
export const fcpNativeUnavailable = () => ({ok: false, error: {code: 'FCP_EXPORT_NATIVE_UNAVAILABLE', status: 503}} as const);
