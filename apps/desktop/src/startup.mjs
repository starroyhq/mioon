import { terminateMediaProcesses, waitForMediaProcesses } from '@mioon/business/media-processes';

// One scope per start/restart. Validation children share its signal; unrelated
// media operations are never included in this main-process drain.
export function createDesktopStartup({ terminate = terminateMediaProcesses, wait = waitForMediaProcesses } = {}) {
  const controller = new AbortController();
  let drain;
  return {
    signal: controller.signal,
    checkpoint() {
      if (controller.signal.aborted) throw Object.assign(new Error('本地服务启动已取消。'), {
        code: 'DESKTOP_START_CANCELLED'
      });
    },
    abort({ onUnconfirmed = () => {} } = {}) {
      controller.abort();
      return drain ??= (async () => {
        const results = await terminate({ signal: controller.signal });
        if (results.some(result => result.status !== 'exited')) {
          try { void Promise.resolve(onUnconfirmed()).catch(() => {}); } catch {}
          // The bounded signal attempt has completed. Retain the app while the
          // actual owned handles remain unconfirmed; this does not signal again.
          await wait({ signal: controller.signal });
        }
      })();
    }
  };
}
