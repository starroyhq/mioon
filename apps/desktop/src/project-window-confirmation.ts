/** A native decision is useful only to the backend/window-context captured
 * before its dialog. A replacement, quit or another restart invalidates it. */
export async function confirmOwnedWindowRestart({ getOwner, canRequest, confirm, restart }: {
  getOwner(): object | null | undefined;
  canRequest(): boolean;
  confirm(): Promise<boolean>;
  restart(): Promise<unknown>;
}): Promise<boolean> {
  const owner = getOwner();
  if (!owner || !canRequest()) return false;
  if (!await confirm() || getOwner() !== owner || !canRequest()) return false;
  await restart();
  return true;
}
