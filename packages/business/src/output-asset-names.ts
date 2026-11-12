import type {DatabaseSync} from 'node:sqlite';
import {isLocale, LOCALES, translate} from '../../i18n/src/index.ts';
import type {OutputLocale} from '../../contracts/src/output-locale.ts';

const scopePrefix = 'output-locale:';
const scopes = LOCALES.map(locale => scopePrefix + locale);

/** Record presentation metadata in the same transaction as the acceptance.
 * The output/review ID addresses its own receipt independently of RPC keys. */
export function recordOutputLocale(db: DatabaseSync, id: string, requestHash: string, locale: unknown): void {
  if (!isLocale(locale)) return;
  if (!db.isTransaction) throw new TypeError('Output language requires the acceptance transaction');
  db.prepare('INSERT INTO idempotency(scope,requestId,requestHash,resourceId) VALUES(?,?,?,?)')
    .run(scopePrefix + locale, id, requestHash, id);
}

export function outputLocaleFor(db: DatabaseSync, id: string): OutputLocale | undefined {
  const rows = db.prepare('SELECT scope FROM idempotency WHERE scope IN (?,?,?,?) AND requestId=? AND resourceId=? LIMIT 2')
    .all(...scopes, id, id);
  const locale = rows.length === 1 ? String(rows[0]?.scope).slice(scopePrefix.length) : undefined;
  return isLocale(locale) ? locale : undefined;
}

function availableName(db: DatabaseSync, projectId: string, stem: string, extension: '.mp4' | '.png'): string {
  const nameWith = (suffix: string): string =>
    stem.slice(0, 200 - suffix.length - extension.length).replace(/[\uD800-\uDBFF]$/u, '') + suffix + extension;
  const names = new Set(db.prepare("SELECT json_extract(data,'$.name') AS name FROM assets WHERE projectId=?")
    .all(projectId).map(row => row.name));
  const original = nameWith('');
  if (!names.has(original)) return original;
  for (let index = 2; ; index++) {
    const next = nameWith(` (${index})`);
    if (!names.has(next)) return next;
  }
}

function outputTitle(title: string): string {
  // Leave room for the translated kind, image number and duplicate suffix.
  return title.length <= 160 ? title : title.slice(0, 159).replace(/[\uD800-\uDBFF]$/u, '') + '…';
}

export function exportAssetName(db: DatabaseSync, output: {id: string; projectId: string; mode?: unknown; purpose?: unknown}, ratio: string): string {
  const locale = outputLocaleFor(db, output.id);
  if (!locale) return output.mode === 'timeline' ? `多轨时间线-${output.purpose === 'preview' ? '预览' : '导出'}-${ratio}.mp4` : `分镜拼接-${ratio}.mp4`;
  const key = output.mode === 'timeline' ? (output.purpose === 'preview' ? 'outputAsset.timelinePreview' : 'outputAsset.timelineExport') : 'outputAsset.storyboard';
  return availableName(db, output.projectId, translate(locale, key, {ratio}), '.mp4');
}

export function generatedVideoAssetName(db: DatabaseSync, job: {id: string; projectId: string; providerId: string}, title: string): string {
  const locale = outputLocaleFor(db, job.id);
  const mock = job.providerId === 'mock';
  if (!locale) return `${title} ${mock ? '模拟' : '生成'}视频.mp4`;
  return availableName(db, job.projectId, translate(locale, mock ? 'outputAsset.mockVideo' : 'outputAsset.generatedVideo', {title:outputTitle(title)}), '.mp4');
}

export function generatedImageAssetName(db: DatabaseSync, taskId: string, projectId: string, title: string, number: number): string {
  const locale = outputLocaleFor(db, taskId);
  if (!locale) return `${title} · 图像 ${number}.png`;
  return availableName(db, projectId, translate(locale, 'outputAsset.image', {title:outputTitle(title), number}), '.png');
}
