import {CANVAS_CLIPBOARD_HANDLE_MIME as HANDLE_TYPE, canvasClipboardHandle} from '../../../packages/contracts/src/canvas-clipboard.ts';

const WEB_HANDLE_TYPE = `web ${HANDLE_TYPE}`;
const HANDLE_SIZE = 36;

export type CanvasClipboardReader = () => string | null | Promise<string | null>;
export interface CanvasClipboardWriter {
  kind: 'event' | 'web';
  write(handle: string): void | Promise<void>;
}
type CanvasClipboardTransport = CanvasClipboardWriter & {read: CanvasClipboardReader};

export function eventCanvasClipboard(event: Pick<ClipboardEvent, 'isTrusted' | 'clipboardData'>): CanvasClipboardTransport | null {
  const data = event.clipboardData;
  if (!event.isTrusted || !data) return null;
  return {
    kind: 'event',
    write(handle) {
      data.clearData();
      data.setData(HANDLE_TYPE, handle);
    },
    read: () => data.types.length === 1 && data.types[0] === HANDLE_TYPE ? canvasClipboardHandle(data.getData(HANDLE_TYPE)) : null,
  };
}

export function webCanvasClipboard(): CanvasClipboardTransport | null {
  const clipboard = globalThis.navigator?.clipboard, Item = globalThis.ClipboardItem;
  if (!clipboard?.read || !clipboard.write || !Item || Item.supports && !Item.supports(WEB_HANDLE_TYPE)) return null;
  return {
    kind: 'web',
    write: handle => clipboard.write([new Item({[WEB_HANDLE_TYPE]: new Blob([handle], {type: HANDLE_TYPE})})]),
    async read() {
      const items = await clipboard.read();
      if (items.length !== 1) return null;
      const item = items.find(candidate => candidate.types.length === 1 && candidate.types[0] === WEB_HANDLE_TYPE);
      if (!item) return null;
      const blob = await item.getType(WEB_HANDLE_TYPE);
      return blob.size === HANDLE_SIZE ? canvasClipboardHandle(await blob.text()) : null;
    },
  };
}

type ClipboardCopy = {
  handle: string;
  expiresAt: number;
  transport: CanvasClipboardWriter['kind'];
  snapshot: Promise<string | null>;
};

export function createCanvasClipboard({
  lifetimeMs, now = Date.now, nonce = () => globalThis.crypto.randomUUID(),
}: {lifetimeMs: number; now?: () => number; nonce?: () => string}) {
  let current: ClipboardCopy | null = null;
  const valid = (copy: ClipboardCopy | null): copy is ClipboardCopy => Boolean(copy && copy.expiresAt > now());
  return {
    clear() { current = null; },
    available() { return valid(current); },
    expired() { return current !== null && !valid(current); },
    transport() { return valid(current) ? current.transport : undefined; },
    async copy(transport: CanvasClipboardWriter, freeze: () => Promise<{snapshotId: string; count: number} | null>,
      isCurrent: () => boolean): Promise<number | null> {
      if (!isCurrent()) return null;
      const handle = canvasClipboardHandle(nonce());
      if (!handle) throw new TypeError('Invalid clipboard handle');
      current = null;
      const expiresAt = now() + lifetimeMs;
      const pending = transport.write(handle);
      const frozen = freeze();
      const confirmed = Promise.all([pending, frozen]);
      const entry = {handle, expiresAt, transport: transport.kind, snapshot: confirmed.then(([, result]) => result?.snapshotId ?? null, () => null)};
      current = entry;
      try {
        const [, result] = await confirmed;
        if (current === entry && valid(entry) && isCurrent() && result) return result.count;
        if (current === entry) current = null;
        return null;
      } catch (error) {
        if (current === entry) current = null;
        throw error;
      }
    },
    async paste(read: CanvasClipboardReader, isCurrent: () => boolean): Promise<string | null> {
      const entry = current;
      if (!valid(entry) || !isCurrent()) return null;
      const handle = canvasClipboardHandle(await read());
      if (entry !== current || !isCurrent()) return null;
      if (handle !== entry.handle || !valid(entry)) {
        current = null;
        return null;
      }
      const snapshot = await entry.snapshot;
      return current === entry && isCurrent() && valid(entry) ? snapshot : null;
    },
  };
}
