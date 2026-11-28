import {FCP_EXPORT_NATIVE_CHANNEL} from '../../../packages/contracts/src/fcp-export-native.ts';
import type {FcpExportNativeBridge} from '../../../packages/contracts/src/fcp-export-native.ts';
import {fcpNativeDestination, fcpNativeInvalid, fcpNativeReply, fcpNativeRequest, fcpNativeUnavailable} from '../../../packages/contracts/src/project-entry-fcp-bridge.ts';

export function createFcpExportBridge(invoke: (channel: string, request: unknown) => Promise<unknown>): FcpExportNativeBridge {
  async function request(value: unknown) {
    const input = fcpNativeRequest.safeParse(value);
    if (!input.success) throw fcpNativeInvalid().error;
    let wire: unknown;
    try {wire = await invoke(FCP_EXPORT_NATIVE_CHANNEL, input.data);}
    catch {throw fcpNativeUnavailable().error;}
    const reply = fcpNativeReply.safeParse(wire);
    if (!reply.success) throw fcpNativeUnavailable().error;
    if (!reply.data.ok) throw reply.data.error;
    return reply.data.data;
  }
  async function booleanRequest(value: unknown): Promise<boolean> {
    const result = await request(value);
    if (typeof result !== 'boolean') throw fcpNativeUnavailable().error;
    return result;
  }
  return Object.freeze({
    async chooseDestination() {
      const result = await request({kind: 'chooseDestination'});
      const checked = fcpNativeDestination.nullable().safeParse(result);
      if (!checked.success) throw fcpNativeUnavailable().error;
      return checked.data;
    },
    reveal: (identity: Parameters<FcpExportNativeBridge['reveal']>[0]) => booleanRequest({kind: 'reveal', identity}),
    openInFinalCut: (identity: Parameters<FcpExportNativeBridge['openInFinalCut']>[0]) => booleanRequest({kind: 'openInFinalCut', identity}),
    finalCutInstalled: () => booleanRequest({kind: 'finalCutInstalled'}),
  });
}
