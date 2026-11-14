import type { SettingsDiagnosticsRead, SettingsDiagnosticsBridge } from '../../desktop/src/settings-diagnostics-protocol.ts';

let nextRead = 0;
function diagnostics() {
  return typeof window === 'undefined' ? undefined :
    (window as Window & {__mioonSettingsDiagnostics?: SettingsDiagnosticsBridge}).__mioonSettingsDiagnostics;
}

export type SettingsClick = Pick<Event, 'isTrusted' | 'timeStamp'>;
export type SettingsReadPurpose = 'keychain-poll';

/** A browser event can predate its handler when the renderer is busy. */
export function markSettingsClick(event?: SettingsClick): void {
  if (event?.isTrusted !== true || !Number.isFinite(event.timeStamp) || event.timeStamp < 0) return;
  try { diagnostics()?.markClick(Math.floor(performance.timeOrigin + event.timeStamp)); } catch { /* Measurement is optional. */ }
}

export function measureSettingsRead<T>(page: SettingsDiagnosticsRead, read: () => Promise<T>, purpose?: SettingsReadPurpose): Promise<T> {
  // Shared clients are also used by editor and launcher documents. Only the
  // settings window receives this presentation metadata from its preload.
  if (purpose === 'keychain-poll' || typeof window === 'undefined' || !Object.hasOwn(window, '__mioonSettingsBootAppearance')) return read();
  const bridge = diagnostics();
  if (!bridge || nextRead >= 2 ** 31 - 1) return read();
  const requestId = ++nextRead;
  const mark = (phase: 'start' | 'end') => {
    try { bridge.markRead(page, phase, requestId, Date.now()); } catch { /* Measurement is optional. */ }
  };
  return (async () => {
    mark('start');
    try { return await read(); } finally { mark('end'); }
  })();
}
