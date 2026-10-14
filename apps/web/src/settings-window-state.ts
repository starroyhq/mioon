import type { ProjectWindowContext, ProjectWindowSettingsSlot } from './desktop-window-client.ts';
import type { SettingsNavigationRegistry } from './settings-navigation-state.ts';
/** Slot requests own no form data. All form owners stay mounted and a later
 * intent or input invalidates consent before the selected pane can change. */
export function createSettingsWindowNavigation({ context: initial, registry, confirm, onChange = () => {} }: {
  context: ProjectWindowContext; registry: SettingsNavigationRegistry; confirm: (message: string) => Promise<boolean>; onChange?: () => void;
}) {
  let active = true, context = initial, intent = 0, seenVersion = initial.settingsVersion;
  let selected: ProjectWindowSettingsSlot = initial.settingsSlot ?? 'agent', notice = '';
  async function select(slot: ProjectWindowSettingsSlot): Promise<boolean> {
    const serial = ++intent;
    if (!active || context.quitting) return false;
    if (slot === selected) return true;
    const capture = registry.capture();
    const current = () => active && !context.quitting && intent === serial && registry.canLeave(capture);
    if (!current()) { notice = '设置仍在读取、保存或核对结果。请先处理当前设置。'; onChange(); return false; }
    if (registry.needsConfirmation(capture) && !await confirm('连接设置有未保存的输入。切换连接会清空尚未提交的密钥；其他草稿仍保留。继续？')) return false;
    if (!current()) return false;
    selected = slot; notice = ''; onChange(); return true;
  }
  return {
    select,
    receive(next: ProjectWindowContext) {
      if (!active || next.role !== 'settings' || next.contextId !== context.contextId || next.backendId !== context.backendId || next.windowId !== context.windowId) return;
      context = next;
      if (next.settingsVersion <= seenVersion) return;
      seenVersion = next.settingsVersion;
      if (next.settingsSlot) void select(next.settingsSlot);
    },
    activate() { active = true; }, dispose() { active = false; intent++; },
    get selected() { return selected; }, get notice() { return notice; }, get version() { return intent; },
  };
}
