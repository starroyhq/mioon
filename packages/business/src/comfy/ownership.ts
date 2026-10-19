import {canonicalImageInput as canonical} from '../../../contracts/src/images.ts';
import {comfyRemoteRunResponseSchema} from '../../../contracts/src/comfy-images.ts';
import {validateImageTaskReview} from '../images/reviews.ts';
import type {ImageGenerationInput} from '../images/reviews.ts';
import type {DatabaseSync} from 'node:sqlite';

export interface ComfyReceiptLike {sha256: string; byteLength: number; schemaVersion: number; providerId?: string; width: number; height: number}
export interface ComfyTaskLike {readonly projectId: string; readonly id: string}
export interface ComfyOwnershipOptions {fail?: () => never; consume?: (value: string) => void}
const bounded = (name: string, max: number | string, nullable = false): string => `CASE WHEN ${nullable ? `${name} IS NULL OR ` : ''}(typeof(${name})='text' AND length(CAST(${name} AS BLOB)) BETWEEN 1 AND ${max}) THEN ${name} ELSE 0 END AS ${name}`;
const columns = [...Object.entries({taskId: 36, projectId: 36, reviewId: 36, promptId: 36, clientId: 36, outputNonce: 36, filenamePrefix: 80, workflowId: 80, comfyVersion: 40, baseUrl: 64, graphHash: 64, rawGraph: 32768, state: 40, createdAt: 40, updatedAt: 40}).map(([key, max]) => bounded(key, max)), 'workflowVersion', 'seed', 'revision', 'contentVerified', 'resultBytes', bounded('resultSha256', 64, true), bounded('outputDescriptor', 4096, true), bounded('errorCode', 80, true), bounded('lastObservedAt', 40, true)].join(',');
const defaultFail = (): never => { throw Object.assign(Error('The ComfyUI result cannot be verified.'), {code: 'IMAGE_RESULT_INVALID'}); };
/** Read-only, bounded lineage check without recursively entering the task reader.
 * A remote DTO or current settings cannot attest that a result belongs here. */
export function validateComfyReceiptOwnership(db: DatabaseSync, task: ComfyTaskLike, input: ImageGenerationInput, receipt: ComfyReceiptLike, {fail = defaultFail, consume = (): void => {}}: ComfyOwnershipOptions = {}): void {
  if (input.providerId !== 'comfy-local') return;
  const review = validateImageTaskReview(db, task.projectId, task.id, input, {consume});
  if (!review) {fail(); return;}
  if (!('execution' in review) || !('configuration' in review)) {fail(); return;}
  const row = db.prepare(`SELECT ${columns} FROM image_remote_runs WHERE taskId=? AND projectId=? LIMIT 1`).get(task.id, task.projectId) as Record<string, unknown> | undefined;
  if (!row) {fail(); return;}
  consume(JSON.stringify(row));
  let descriptor: unknown;
  try {descriptor = row.outputDescriptor === null ? null : JSON.parse(row.outputDescriptor as string);} catch {fail();}
  const {rawGraph, ...dto} = row;
  dto.contentVerified = row.contentVerified === 1; dto.outputDescriptor = descriptor;
  if (!comfyRemoteRunResponseSchema.safeParse(dto).success || row.state !== 'completed' || row.contentVerified !== 1 || row.reviewId !== review.id ||
      row.taskId !== task.id || row.projectId !== task.projectId || row.baseUrl !== review.configuration.baseUrl || row.rawGraph !== canonical(review.execution.graph)) fail();
  for (const key of ['promptId', 'clientId', 'outputNonce', 'filenamePrefix', 'workflowId', 'workflowVersion', 'comfyVersion', 'seed', 'graphHash']) if (row[key] !== review.execution[key as keyof typeof review.execution]) fail();
  if (receipt.sha256 !== row.resultSha256 || receipt.byteLength !== row.resultBytes || receipt.schemaVersion !== 2 || receipt.providerId !== 'comfy-local' || receipt.width !== 512 || receipt.height !== 512) fail();
}
