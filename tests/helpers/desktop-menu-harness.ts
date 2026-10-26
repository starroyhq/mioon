import type {DesktopHarnessMenu, DesktopHarnessMenuList} from './strict-desktop-harness-types.ts';

/** Only native Menu construction is synthetic. Its lookup walks the current
 * mutable submenu tree so production state refreshes exercise real IDs. */
export function desktopMenuHarness(template: readonly DesktopHarnessMenu[]): DesktopHarnessMenuList {
  const menu = template.map(item => ({...item, ...(Array.isArray(item.submenu) ? {submenu: desktopMenuHarness(item.submenu)} : {})})) as DesktopHarnessMenuList;
  Object.defineProperty(menu, 'getMenuItemById', {value: (id: string): DesktopHarnessMenu | null => {
    for (const item of menu) {
      if (item.id === id) return item;
      const nested = item.submenu?.getMenuItemById(id);
      if (nested) return nested;
    }
    return null;
  }});
  return menu;
}
