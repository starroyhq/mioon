import {
  DESKTOP_UPDATE_CHANNEL, DESKTOP_UPDATE_EVENT, desktopUpdateReplySchema,
  desktopUpdateRequestSchema, desktopUpdateViewSchema,
} from '../../../packages/contracts/src/desktop-update.ts';
import type {DesktopUpdateBridge, DesktopUpdateError, DesktopUpdateRequest} from '../../../packages/contracts/src/desktop-update.ts';

type Listener = (event: unknown, value: unknown) => void;
interface Transport {
  invoke(channel: string, request: DesktopUpdateRequest): Promise<unknown>;
  on(channel: string, listener: Listener): void;
  removeListener(channel: string, listener: Listener): void;
}
const unavailable = (): DesktopUpdateError => ({code: 'UPDATE_UNAVAILABLE', status: 503});

export function createDesktopUpdateBridge(transport: Transport): DesktopUpdateBridge {
  const call = async (input: DesktopUpdateRequest) => {
    const request = desktopUpdateRequestSchema.safeParse(input);
    if (!request.success) throw {code: 'UPDATE_INVALID', status: 400} satisfies DesktopUpdateError;
    let raw: unknown;
    try {raw = await transport.invoke(DESKTOP_UPDATE_CHANNEL, request.data);}
    catch {throw unavailable();}
    const reply = desktopUpdateReplySchema.safeParse(raw);
    if (!reply.success) throw unavailable();
    if (!reply.data.ok) throw reply.data.error;
    return reply.data.data;
  };
  return Object.freeze<DesktopUpdateBridge>({
    read: () => call({kind: 'read'}),
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      const handle: Listener = (_event, input) => {
        const result = desktopUpdateViewSchema.safeParse(input);
        if (result.success) listener(result.data);
      };
      transport.on(DESKTOP_UPDATE_EVENT, handle);
      return () => transport.removeListener(DESKTOP_UPDATE_EVENT, handle);
    },
    check: () => call({kind: 'check'}),
    download: expectedVersion => call({kind: 'download', expectedVersion}),
    cancel: () => call({kind: 'cancel'}),
    install: (expectedVersion, mode, acknowledgeExports) => call({kind: 'install', expectedVersion, mode, acknowledgeExports}),
  });
}
