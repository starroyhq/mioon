import {z} from 'zod';
import {projectIdSchema} from './project-file.ts';

const identity = z.object({projectId: projectIdSchema, exportId: z.string().uuid()}).strict();
export const nativeExportDestination = z.object({token: z.string().uuid(), displayPath: z.string().min(1).max(4096)}).strict();

type Parser<T> = {safeParse(input: unknown): {success: true; data: T} | {success: false}};
export type NativeExportRequest = {kind: string} | {kind: string; identity: z.infer<typeof identity>};
type NativeExportFailure = {ok: false; error: {code: string; status: number}};
type NativeExportReply = {ok: true; data: boolean | z.infer<typeof nativeExportDestination> | null} | NativeExportFailure;
export interface NativeExportWire {
  readonly request: Parser<NativeExportRequest>;
  readonly reply: Parser<NativeExportReply>;
  invalid(): NativeExportFailure;
  unavailable(): NativeExportFailure;
}

export function createNativeExportWire<const Open extends string, const Installed extends string, const Prefix extends string>(
  open: Open, installed: Installed, errorPrefix: Prefix,
) {
  const invalidCode = `${errorPrefix}_INVALID` as const;
  const unavailableCode = `${errorPrefix}_UNAVAILABLE` as const;
  const request = z.discriminatedUnion('kind', [
    z.object({kind: z.literal('chooseDestination')}).strict(),
    z.object({kind: z.literal('reveal'), identity}).strict(),
    z.object({kind: z.literal(open), identity}).strict(),
    z.object({kind: z.literal(installed)}).strict(),
  ]);
  const reply = z.discriminatedUnion('ok', [
    z.object({ok: z.literal(true), data: z.union([z.boolean(), nativeExportDestination, z.null()])}).strict(),
    z.object({ok: z.literal(false), error: z.discriminatedUnion('code', [
      z.object({code: z.literal(invalidCode), status: z.literal(400)}).strict(),
      z.object({code: z.literal(unavailableCode), status: z.literal(503)}).strict(),
    ])}).strict(),
  ]);
  return {
    request,
    reply,
    invalid: () => ({ok: false, error: {code: invalidCode, status: 400}} as const),
    unavailable: () => ({ok: false, error: {code: unavailableCode, status: 503}} as const),
  };
}
