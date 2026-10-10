// A bounded stop may finish without an exit event. Keep the already-requested
// native quit pending in that case; never retry signals, restart the utility or
// close settings while the original owned utility could still be draining.
function confirmOwnedExit(backend, child) {
  return new Promise(resolve => {
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

export async function stopBackendForQuit({ backend, cleanup, onUnconfirmed = () => {} }) {
  const child = backend?.child;
  let failure;
  try { await backend?.stop(); }
  catch (error) {
    if (error?.code === 'BACKEND_STOP_UNCONFIRMED' && child) {
      const confirmation = confirmOwnedExit(backend, child);
      // Notification failure cannot discard the owned child or trigger a quit
      // retry. Install the exact-child observer before showing a native dialog.
      try { void Promise.resolve(onUnconfirmed()).catch(() => {}); } catch {}
      await confirmation;
      if (backend.hasUnconfirmedMedia) throw Object.assign(new Error('本地服务已退出，但媒体子进程是否退出尚无法确认。'), {
        code: 'BACKEND_MEDIA_EXIT_UNCONFIRMED', exitConfirmed: true, mediaExitConfirmed: false
      });
      if (backend.shutdownFailed || (!backend.stopOutcome?.forced && backend.stopOutcome?.code !== 0)) {
        failure = Object.assign(new Error('本地服务退出时未能完成正常清理。'), {
          code: 'BACKEND_STOP_FAILED', exitConfirmed: true
        });
      }
    } else if (error?.exitConfirmed && error?.mediaExitConfirmed !== false && !backend?.child) failure = error;
    else throw error;
  }
  await cleanup();
  if (failure) throw failure;
}
