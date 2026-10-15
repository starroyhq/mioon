import { CLIP_LUT_RECOVERY_CHANNEL, parseClipLutRecoveryRequest, parseClipLutRecoveryResponse,
  ClipLutRecoveryError } from '../../../packages/contracts/src/clip-lut-recovery.ts';
import type { DesktopLutRecoveryBridge, ClipLutRecoveryRequest, ClipLutRecoveryResponse } from '../../../packages/contracts/src/clip-lut-recovery.ts';
interface Transport { invoke(channel: typeof CLIP_LUT_RECOVERY_CHANNEL, request: ClipLutRecoveryRequest): Promise<unknown> }
/** Only four fixed metadata operations; never exposes Electron events or transport. */
export function createDesktopLutRecoveryBridge(transport: Transport): DesktopLutRecoveryBridge {
  async function invoke(input: ClipLutRecoveryRequest): Promise<ClipLutRecoveryResponse> {
    try {
      const request = parseClipLutRecoveryRequest(input);
      const response = parseClipLutRecoveryResponse(await transport.invoke(CLIP_LUT_RECOVERY_CHANNEL, request), request);
      return Object.freeze(response.ok ? { ok: true, value: response.value === null ? null : Object.freeze(response.value) } : response);
    } catch (error) { return Object.freeze({ ok: false, code: error instanceof ClipLutRecoveryError ? error.code : 'LUT_RECOVERY_UNAVAILABLE' }); }
  }
  return Object.freeze({
    read: identity => invoke({ action: 'read', identity }),
    reserve: value => invoke({ action: 'reserve', value }),
    verify: value => invoke({ action: 'verify', value }),
    complete: value => invoke({ action: 'complete', value }),
  } satisfies DesktopLutRecoveryBridge);
}
