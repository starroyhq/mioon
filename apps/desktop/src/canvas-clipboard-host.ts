import {CANVAS_CLIPBOARD_HANDLE_MIME, canvasClipboardHandle} from '../../../packages/contracts/src/canvas-clipboard.ts';

interface ClipboardItem {
  readonly types: readonly string[];
  getType(type: string): Promise<unknown>;
}

const nativeFormats: Partial<Record<NodeJS.Platform, string>> = {
  darwin: 'org.chromium.web-custom-data',
  win32: 'Chromium Web Custom MIME Data Format',
  linux: 'chromium/x-web-custom-data',
};
const metadataFormats: Partial<Record<NodeJS.Platform, readonly string[]>> = {
  darwin: ['org.chromium.internal.source-rfh-token', 'org.chromium.source-url'],
  win32: ['Chromium internal source RFH token', 'Chromium internal source URL'],
  linux: ['chromium/x-internal-source-rfh-token', 'chromium/x-source-url'],
};
const rawFormat = (format: string): string => `electron application/osclipboard;format="${format}"`;

export function canvasClipboardNativeFormat(platform: NodeJS.Platform): string | null {
  const format = nativeFormats[platform];
  return format ? rawFormat(format) : null;
}

const MIMEBytes = Buffer.from(CANVAS_CLIPBOARD_HANDLE_MIME, 'utf16le');
const MIMEOffset = 12;
const handleLengthOffset = MIMEOffset + Math.ceil(MIMEBytes.length / 4) * 4;
const handleOffset = handleLengthOffset + 4;
const handleLength = 36;
const minimumSize = handleOffset + handleLength * 2;

/** Chromium serializes DataTransfer custom strings into a Pickle on all
 * platforms. Only the exact shape written by canvas Copy is accepted. */
export function readCanvasClipboardPickle(data: ArrayBuffer): string | null {
  if (data.byteLength < minimumSize || data.byteLength > minimumSize + 15) return null;
  const bytes = Buffer.from(data);
  if (bytes.readUInt32LE(0) !== minimumSize - 4 || bytes.readUInt32LE(4) !== 1 ||
      bytes.readUInt32LE(8) !== CANVAS_CLIPBOARD_HANDLE_MIME.length ||
      !bytes.subarray(MIMEOffset, MIMEOffset + MIMEBytes.length).equals(MIMEBytes) ||
      bytes.readUInt32LE(handleLengthOffset) !== handleLength) return null;
  // Windows can report an aligned native allocation for these bytes.
  if (bytes.subarray(minimumSize).some(byte => byte !== 0)) return null;
  return canvasClipboardHandle(bytes.toString('utf16le', handleOffset, minimumSize));
}

export async function readNativeCanvasClipboard(platform: NodeJS.Platform, read: () => Promise<readonly ClipboardItem[]>,
  isCurrent: () => boolean): Promise<string | null> {
  const format = canvasClipboardNativeFormat(platform);
  if (!format || !isCurrent()) return null;
  try {
    const items = await read();
    if (!isCurrent()) return null;
    // Native clipboard enumeration also reports Chromium's internal source
    // metadata, plus the unrelated macOS find pasteboard. Ignore those types.
    const allowed = new Set([format, ...(metadataFormats[platform] ?? []).map(rawFormat), 'electron application/findtext']);
    if (items.some(item => item.types.some(type => !allowed.has(type)))) return null;
    const candidates = items.filter(item => item.types.includes(format));
    if (candidates.length !== 1) return null;
    const blob = await candidates[0]!.getType(format);
    if (!isCurrent() || !(blob instanceof Blob) || blob.size < minimumSize || blob.size > minimumSize + 15) return null;
    const data = await blob.arrayBuffer();
    return isCurrent() ? readCanvasClipboardPickle(data) : null;
  } catch { return null; }
}
