import {nativeExportDestination, type NativeExportWire} from '../../../packages/contracts/src/project-entry-export-bridge.ts';
import type {FcpExportNativeIdentity} from '../../../packages/contracts/src/fcp-export-native.ts';

export function createNativeEditingExportPreload(
  invoke: (channel: string, request: unknown) => Promise<unknown>,
  channel: string, wire: NativeExportWire, openKind: string, installedKind: string,
) {
  async function request(value: unknown) {
    const input = wire.request.safeParse(value);
    if (!input.success) throw wire.invalid().error;
    let result: unknown;
    try {result = await invoke(channel, input.data);}
    catch {throw wire.unavailable().error;}
    const reply = wire.reply.safeParse(result);
    if (!reply.success) throw wire.unavailable().error;
    if (!reply.data.ok) throw reply.data.error;
    return reply.data.data;
  }
  async function booleanRequest(value: unknown): Promise<boolean> {
    const result = await request(value);
    if (typeof result !== 'boolean') throw wire.unavailable().error;
    return result;
  }
  return {
    async chooseDestination() {
      const result = await request({kind: 'chooseDestination'});
      const checked = nativeExportDestination.nullable().safeParse(result);
      if (!checked.success) throw wire.unavailable().error;
      return checked.data;
    },
    reveal: (identity: FcpExportNativeIdentity) => booleanRequest({kind: 'reveal', identity}),
    open: (identity: FcpExportNativeIdentity) => booleanRequest({kind: openKind, identity}),
    installed: () => booleanRequest({kind: installedKind}),
  };
}
