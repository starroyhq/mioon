import type {BackendSupervisor, BackendUtilityProcess} from './supervisor.ts';

interface CodedError {
  code?: string;
  exitConfirmed?: boolean;
  mediaExitConfirmed?: boolean;
}
function codedError(error: unknown): CodedError | null {
  return error !== null && typeof error === 'object' ? error as CodedError : null;
}
function stopError(code: string, message: string): Error {
  return Object.assign(new Error(message), {code});
}

// A bounded stop may finish without an exit event. Keep the already-requested
// native quit pending in that case; never retry signals, restart the utility or
// close settings while the original owned utility could still be draining.
function confirmOwnedExit(backend: BackendSupervisor, child: BackendUtilityProcess): Promise<void> {
  return new Promise<void>(resolve => {
    const confirmed = () => {
      if (backend.child === child) return;
      child.removeListener('exit', confirmed);
      resolve();
    };
    child.on('exit', confirmed);
    // The exit could have arrived between the rejected stop and this listener.
    confirmed();
  });
}

export async function stopBackendForQuit({ backend, cleanup, onUnconfirmed = () => {} }: {
  backend: BackendSupervisor | null | undefined;
  cleanup(): unknown | Promise<unknown>;
  onUnconfirmed?: () => unknown;
}): Promise<void> {
  const child = backend?.child;
  let failure: unknown = null;
  try { await backend?.stop(); }
  catch (error) {
    const coded = codedError(error);
    if (coded?.code === 'BACKEND_STOP_UNCONFIRMED' && child && backend) {
      const confirmation = confirmOwnedExit(backend, child);
      // Notification failure cannot discard the owned child or trigger a quit
      // retry. Install the exact-child observer before showing a native dialog.
      try { void Promise.resolve(onUnconfirmed()).catch(() => {}); } catch {}
      await confirmation;
      if (backend.hasUnconfirmedMedia) throw Object.assign(
        stopError('BACKEND_MEDIA_EXIT_UNCONFIRMED', '本地服务已退出，但媒体子进程是否退出尚无法确认。'),
        { exitConfirmed: true, mediaExitConfirmed: false });
      if (backend.shutdownFailed || (!backend.stopOutcome?.forced && backend.stopOutcome?.code !== 0)) {
        failure = Object.assign(new Error('本地服务退出时未能完成正常清理。'), {
          code: 'BACKEND_STOP_FAILED', exitConfirmed: true
        });
      }
    } else if (coded?.exitConfirmed && coded.mediaExitConfirmed !== false && !backend?.child) failure = error;
    else throw error;
  }
  await cleanup();
  if (failure) throw failure;
}
