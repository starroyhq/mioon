import type { UiPreferences } from '../../../packages/contracts/src/ui-preferences.ts';

export type ResolvedAppearance = 'dark' | 'light';
export const SYSTEM_APPEARANCE_QUERY = '(prefers-color-scheme: dark)';

export function resolveAppearance(appearance: UiPreferences['theme'], systemDark: boolean): ResolvedAppearance {
  return appearance === 'system' ? systemDark ? 'dark' : 'light' : appearance;
}

/** Each binding owns its listener. Queued events must also match the current
 * preference before touching the document, including before React cleanup. */
export function bindUiAppearance(
  root: HTMLElement,
  appearance: UiPreferences['theme'],
  matchMedia: ((query: string) => MediaQueryList) | null,
  isCurrent: () => boolean,
  onResolved: (appearance: ResolvedAppearance) => void,
): () => void {
  let active = true;
  const media = appearance === 'system' ? matchMedia?.(SYSTEM_APPEARANCE_QUERY) : null;
  const apply = () => {
    if (!active || !isCurrent()) return;
    const resolved = resolveAppearance(appearance, media?.matches ?? true);
    root.classList.toggle('dark', resolved === 'dark');
    root.classList.toggle('light', resolved === 'light');
    root.dataset.theme = resolved;
    root.dataset.appearance = appearance;
    root.style.colorScheme = resolved;
    onResolved(resolved);
  };
  apply();
  media?.addEventListener('change', apply);
  return () => {
    active = false;
    media?.removeEventListener('change', apply);
  };
}
