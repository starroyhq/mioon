import { message as msg } from '../../../packages/i18n/src/index.ts';
import type { DisplayMessage } from '../../../packages/i18n/src/index.ts';
import { isSettingsConnectionPage } from './settings-window-state.ts';
import type { SettingsConnectionPage, SettingsPage } from './settings-window-state.ts';
import type { SettingsNavigationRegistry } from './settings-navigation-state.ts';
/** Web presentation state only. No project ownership or native bridge is invented.
 * Every navigation permission is bound to the same retained form registry. */
export function createWebSettingsNavigation({ registry, confirm, onChange = () => {} }: {
  registry: SettingsNavigationRegistry; confirm: (message: DisplayMessage) => Promise<boolean>; onChange?: () => void;
}) {
  let active = true, opened = false, page: SettingsPage = 'general', selected: SettingsConnectionPage = 'agent', intent = 0;
  let notice: DisplayMessage | '' = '';
  async function navigate(next: SettingsPage, show: boolean) {
    const serial = ++intent;
    if (!active) return false;
    if (page === next && opened === show) return true;
    const capture = registry.capture();
    const current = () => active && intent === serial && registry.canLeave(capture);
    if (!current()) { notice = msg('shell.settingsBusy'); onChange(); return false; }
    if (registry.needsConfirmation(capture) && !await confirm(msg('shell.changeConnectionConfirm'))) return false;
    if (!current()) return false;
    page = next; if (isSettingsConnectionPage(next)) selected = next;
    opened = show; notice = ''; onChange(); return true;
  }
  return {
    open: (next: SettingsPage = 'general') => navigate(next, true),
    selectPage: (next: SettingsPage) => opened ? navigate(next, true) : Promise.resolve(false),
    close: () => navigate(page, false),
    activate() { active = true; }, dispose() { active = false; intent++; },
    get opened() { return opened; }, get page() { return page; }, get selected() { return selected; }, get notice() { return notice; },
  };
}
