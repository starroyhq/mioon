import {isProjectWindowId} from './project-window-protocol.ts';

export interface NativeProjectEntryOwner {
  readonly window: {readonly webContents: {executeJavaScript(code: string): Promise<unknown>}};
  isCurrent(): boolean;
}

/** Consume a previously sealed renderer entry ticket. This fixed script neither
 * saves nor submits business data and accepts no arbitrary code or target URL. */
export async function consumeNativeProjectEntry(
  owner: NativeProjectEntryOwner, entryToken: string, projectId: string, timeoutMs = 1500,
): Promise<unknown> {
  if (!isProjectWindowId(entryToken) || !isProjectWindowId(projectId) || !owner.isCurrent()) return null;
  const budget = Math.max(1, Math.min(1500, Number.isSafeInteger(timeoutMs) ? timeoutMs : 1500));
  const code = `typeof globalThis.__mioonProjectEntryAdmission?.consume === 'function' ? globalThis.__mioonProjectEntryAdmission.consume(${JSON.stringify(entryToken)},${JSON.stringify(projectId)}) : null`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => owner.isCurrent() ? owner.window.webContents.executeJavaScript(code) : null).catch(() => null),
      new Promise<null>(resolve => {timer = setTimeout(() => resolve(null), budget);}),
    ]);
    return owner.isCurrent() ? result : null;
  } catch { return null; }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
