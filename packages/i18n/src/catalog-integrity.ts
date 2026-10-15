import type { MessageCatalog } from './types.ts';
export function assertNoDuplicateMessageKeys(...fragments: readonly MessageCatalog[]): void {
  const seen = new Set<string>();
  for (const fragment of fragments) for (const key of Object.keys(fragment)) {
    if (seen.has(key)) throw new TypeError(`Duplicate message key: ${key}`);
    seen.add(key);
  }
}
