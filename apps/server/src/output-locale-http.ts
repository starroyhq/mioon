import type {IncomingMessage} from 'node:http';
import {AppError} from '@mioon/contracts';
import {OUTPUT_LOCALE_HEADER, outputLocaleSchema} from '../../../packages/contracts/src/output-locale.ts';
import type {OutputLocale} from '../../../packages/contracts/src/output-locale.ts';

const operations = new Set(['timeline.render', 'export.create', 'generation.submit', 'job.retry', 'image.generate', 'image.review.prepare', 'image.service.review.prepare']);

export function readOutputLocale(request: IncomingMessage, operation: string): OutputLocale | undefined {
  const value = request.headers[OUTPUT_LOCALE_HEADER.toLowerCase()];
  if (value === undefined || !operations.has(operation)) return undefined;
  const parsed = outputLocaleSchema.safeParse(value);
  if (!parsed.success) throw new AppError('VALIDATION_ERROR', '产物名称语言无效。', 400);
  return parsed.data;
}
