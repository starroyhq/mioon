import type { ProjectWindowSettingsSlot } from '../../desktop/src/project-window-protocol.ts';

export const settingsCategories = ['general', 'workspace', 'video-tools', 'models', 'agent', 'shortcuts', 'about'] as const;
export type SettingsCategory = typeof settingsCategories[number];
export const settingsCategoryFor = (page: ProjectWindowSettingsSlot): SettingsCategory =>
  page === 'official' || page === 'custom' || page === 'comfy' || page === 'extensions' ? 'models' : page;
