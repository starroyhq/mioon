/** Observe only redacted capability while a native Keychain request is pending.
 * Stop with the owning settings view and never restart its draft or write. */
export function watchPendingSecretStorage(refresh: (signal: AbortSignal) => Promise<void>) {
  let owner: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function schedule(current: AbortController, delay: number) {
    timer = setTimeout(async () => {
      try {await refresh(current.signal);} catch { /* Keep the last confirmed status. */ }
      if (!current.signal.aborted) schedule(current, 1000);
    }, delay);
  }
  return (active: boolean) => {
    if (active && !owner) {
      // Confirm the initial pending snapshot before showing authorization help.
      owner = new AbortController(); schedule(owner, 300);
    } else if (!active && owner) {
      owner.abort(); owner = undefined; clearTimeout(timer);
    }
  };
}
