import path from 'node:path';
import type {BrowserWindow, DownloadItem, Event, SaveDialogOptions, WebContents} from 'electron';
import {parseTimelineDeliveryContentDisposition} from '@mioon/contracts/timeline-delivery';

const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const mediaPath = new RegExp(`^/media/(${UUID})$`, 'i');
const responseBinding = new RegExp(`^(.*); mioon-export-id="(${UUID})"; mioon-asset-id="(${UUID})"$`, 'i');
const MAX_HEADER_BYTES = 2048;
const MAX_URL_BYTES = 2048;
const MAX_REDIRECTS = 32;

type DownloadIdentity = {assetId: string; exportId: string | null};
export type TimelineDownloadDirectory =
  | {downloadsDirectory: string; downloadsPath?: never}
  | {downloadsPath: string; downloadsDirectory?: never};
type Item = Pick<DownloadItem, 'getURL' | 'getURLChain' | 'getMimeType' | 'getInitiatorOrigin' | 'getContentDisposition' | 'setSaveDialogOptions'>;
type Contents = Pick<WebContents, 'getURL'>;
type Window = Pick<BrowserWindow, 'isDestroyed'> & {webContents: Contents};

/** URLs prove only identity, never a filename or native destination. */
export function timelineDownloadIdentity(value: unknown, origin: string): DownloadIdentity | null {
  if (typeof value !== 'string' || !value || /[\u0000-\u0020\u007f]/u.test(value) || Buffer.byteLength(value) > MAX_URL_BYTES) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  const matched = mediaPath.exec(url.pathname);
  if (url.origin !== origin || url.username || url.password || url.hash || !matched) return null;
  const keys = [...url.searchParams.keys()];
  if (keys.length === 0) return {assetId: matched[1], exportId: null};
  if (keys.length === 1 && keys[0] === 'download' && ['', '1'].includes(url.searchParams.get('download') ?? '')) {
    return {assetId: matched[1], exportId: null};
  }
  const exportId = url.searchParams.get('exportId');
  if (keys.length !== 2 || keys.filter(key => key === 'download').length !== 1 || keys.filter(key => key === 'exportId').length !== 1 ||
      url.searchParams.get('download') !== '1' || !exportId || exportId.length !== 36 || !new RegExp(`^${UUID}$`, 'i').test(exportId)) return null;
  return {assetId: matched[1], exportId};
}

/** Consume the actual response header, not Chromium's suggested filename (which
 * can come from a renderer download attribute). Full response IDs must agree
 * with the final URL before the shared bounded filename policy is consulted. */
export function namedTimelineDownloadBasename(header: unknown, identity: DownloadIdentity): string | null {
  if (!identity.exportId || typeof header !== 'string' || Buffer.byteLength(header) > MAX_HEADER_BYTES || /[\r\n\0]/.test(header)) return null;
  const match = responseBinding.exec(header);
  if (!match || match[2] !== identity.exportId || match[3] !== identity.assetId) return null;
  return parseTimelineDeliveryContentDisposition(match[1], identity.exportId);
}

function saveOptions(item: Item, origin: string, directory: TimelineDownloadDirectory): SaveDialogOptions | null {
  // Electron 44.7 exposes this from the actual initiating frame. A trusted
  // top-level tab alone cannot authorize an opaque or foreign child initiator.
  if (item.getInitiatorOrigin() !== origin || item.getMimeType() !== 'video/mp4') return null;
  const finalUrl = item.getURL(), final = timelineDownloadIdentity(finalUrl, origin), chain = item.getURLChain();
  if (!final || !Array.isArray(chain) || chain.length === 0 || chain.length > MAX_REDIRECTS || chain.at(-1) !== finalUrl) return null;
  for (const value of chain) {
    const current = timelineDownloadIdentity(value, origin);
    if (!current || current.assetId !== final.assetId || current.exportId !== final.exportId) return null;
  }
  const downloadsDirectory = directory.downloadsDirectory ?? path.dirname(directory.downloadsPath);
  if (!path.isAbsolute(downloadsDirectory) || downloadsDirectory.includes('\0')) return null;
  const legacyName = directory.downloadsPath === undefined ? 'mioon.mp4' : path.basename(directory.downloadsPath);
  const basename = final.exportId ? namedTimelineDownloadBasename(item.getContentDisposition(), final) : legacyName;
  if (!basename || basename === '.' || basename === '..' || /[\\/\u0000-\u001f\u007f-\u009f]/u.test(basename)) return null;
  return {title: '保存视频', defaultPath: path.join(downloadsDirectory, basename),
    filters: [{name: 'MP4 视频', extensions: ['mp4']}], properties: ['showOverwriteConfirmation']};
}

/** No automatic writes or IPC. Chromium retains its native Save As flow,
 * cancellation and overwrite confirmation; only its safe default is supplied. */
export function configureTimelineDeliveryDownload(
  event: Pick<Event, 'preventDefault'>,
  item: Item,
  webContents: Contents | undefined,
  win: Window | null | undefined,
  origin: string,
  directory: TimelineDownloadDirectory,
  isAllowedNavigation: (value: string, origin: string) => boolean,
): void {
  try {
    if (!win || win.isDestroyed() || !webContents || webContents !== win.webContents || !isAllowedNavigation(webContents.getURL(), origin)) {
      event.preventDefault(); return;
    }
    const options = saveOptions(item, origin, directory);
    if (!options) { event.preventDefault(); return; }
    item.setSaveDialogOptions(options);
  } catch {
    // Missing native evidence or an unexpected runtime value always denies.
    event.preventDefault();
  }
}

/** Resolve only the actual native initiator. A missing/stale registry result is
 * not permission to substitute the first or focused editor. */
export function configureOwnedTimelineDeliveryDownload(
  event: Pick<Event, 'preventDefault'>,
  item: Item,
  webContents: Contents | undefined,
  resolveWindow: (contents: Contents | undefined) => Window | null | undefined,
  origin: string,
  directory: TimelineDownloadDirectory,
  isAllowedNavigation: (value: string, origin: string) => boolean,
): void {
  let owner: Window | null | undefined;
  try { owner = resolveWindow(webContents); }
  catch { event.preventDefault(); return; }
  configureTimelineDeliveryDownload(event, item, webContents, owner, origin, directory, isAllowedNavigation);
}
