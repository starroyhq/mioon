const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => isRecord(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item) as string;

/** Complete retained identity includes operation, input, key and renderer proof.
 * Missing and explicit null remain distinct; a late ACK cannot clear a replacement. */
export function samePendingIntent(left: unknown, right: unknown): boolean {
  return isRecord(left) && isRecord(right) && canonical(left) === canonical(right);
}
export function pendingStorageKey(projectId: string, key: string): string {
  return `mioon.pending.v1:${projectId}:${key}`;
}
export function removeExactPending(storage: { getItem(key: string): string | null; removeItem(key: string): void }, storageKey: string, expectedRaw: unknown): boolean {
  if (typeof expectedRaw !== 'string' || storage.getItem(storageKey) !== expectedRaw) return false;
  storage.removeItem(storageKey);
  return storage.getItem(storageKey) === null;
}
