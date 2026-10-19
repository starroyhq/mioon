import { message as msg } from '../../../packages/i18n/src/index.ts';
import type { DisplayMessage } from '../../../packages/i18n/src/index.ts';
import type { ProjectWindowContext, ProjectWindowSettingsSlot } from './desktop-window-client.ts';
import type { SettingsNavigationRegistry } from './settings-navigation-state.ts';
export type SettingsPage = ProjectWindowSettingsSlot | 'general' | 'workspace' | 'video-tools' | 'models' | 'extensions' | 'shortcuts' | 'about';
export const isSettingsConnectionPage = (page: SettingsPage): page is ProjectWindowSettingsSlot => page === 'agent' || page === 'official' || page === 'custom' || page === 'comfy';
/** Slot requests own no form data. All form owners stay mounted and a later
 * intent or input invalidates consent before the selected pane can change. */
export function createSettingsWindowNavigation({ context: initial, registry, confirm, onChange = () => {} }: {
  context: ProjectWindowContext; registry: SettingsNavigationRegistry; confirm: (message: string | DisplayMessage) => Promise<boolean>; onChange?: () => void;
}) {
  let active = true, context = initial, intent = 0, seenVersion = initial.settingsVersion;
  let selected: ProjectWindowSettingsSlot = initial.settingsSlot ?? 'agent';
  let page: SettingsPage = selected;
  let notice: string | DisplayMessage = '';
  async function selectPage(next: SettingsPage): Promise<boolean> {
    const serial = ++intent;
    if (!active || context.quitting) return false;
    if (next === page) return true;
    const capture = registry.capture();
    const current = () => active && !context.quitting && intent === serial && registry.canLeave(capture);
    if (!current()) { notice = msg('shell.settingsBusy'); onChange(); return false; }
    if (registry.needsConfirmation(capture) && !await confirm(msg('shell.changeConnectionConfirm'))) return false;
    if (!current()) return false;
    page = next; if (isSettingsConnectionPage(next)) selected = next; notice = ''; onChange(); return true;
  }
  const select = (slot: ProjectWindowSettingsSlot) => selectPage(slot);
  return {
    select, selectPage,
    receive(next: ProjectWindowContext) {
      if (!active || next.role !== 'settings' || next.contextId !== context.contextId || next.backendId !== context.backendId || next.windowId !== context.windowId) return;
      context = next;
      if (next.settingsVersion <= seenVersion) return;
      seenVersion = next.settingsVersion;
      if (next.settingsSlot) void select(next.settingsSlot);
    },
    activate() { active = true; }, dispose() { active = false; intent++; },
    get page() { return page; }, get selected() { return selected; }, get notice() { return notice; }, get version() { return intent; },
  };
}
