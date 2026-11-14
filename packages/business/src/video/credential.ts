import {videoCredentialDiagnosticForCode} from '@mioon/contracts/video-credential-diagnostic';
import type {VideoCredentialDiagnostic} from '@mioon/contracts/video-credential-diagnostic';
import {awaitProvider,operationCancelled} from '../operation-lifecycle.ts';
import {providerError} from '../providers/live-common.ts';

const diagnostics = new WeakMap<object, VideoCredentialDiagnostic>();

export function videoCredentialDiagnostic(error: unknown): VideoCredentialDiagnostic | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const recorded = diagnostics.get(error);
  if (recorded) return recorded;
  try {return videoCredentialDiagnosticForCode('code' in error ? error.code : undefined);}
  catch {return undefined;}
}

function unavailable(diagnostic?: VideoCredentialDiagnostic): Error {
  const error = providerError('VIDEO_CREDENTIAL_UNAVAILABLE','The credential bound to this video task is unavailable.',{beforeDispatch:true});
  diagnostics.set(error, diagnostic ?? videoCredentialDiagnosticForCode('VIDEO_CREDENTIAL_UNAVAILABLE')!);
  return error;
}

export async function acquireBoundVideoCredential(acquire: ()=>Promise<string>, signal?: AbortSignal): Promise<string> {
  const check = () => {if (signal?.aborted) throw operationCancelled({beforeDispatch:true});};
  check();
  let value: unknown;
  try {value = await awaitProvider(acquire, signal);}
  catch (error) {check(); throw unavailable(videoCredentialDiagnostic(error));}
  check();
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 8192 || /[\u0000-\u0020\u007f]/.test(value)) {
    throw unavailable(videoCredentialDiagnosticForCode('VIDEO_CREDENTIAL_INVALID'));
  }
  return value;
}
