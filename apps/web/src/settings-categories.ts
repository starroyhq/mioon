import type { SettingsPage } from './settings-window-state.ts';

export const settingsCategories = ['general', 'workspace', 'video-tools', 'models', 'agent', 'external-agents', 'shortcuts', 'about'] as const;
export type SettingsCategory = typeof settingsCategories[number];
export const visibleSettingsCategories = (externalAgentsAvailable: boolean): readonly SettingsCategory[] =>
  externalAgentsAvailable ? settingsCategories : settingsCategories.filter(category => category !== 'external-agents');
export const settingsCategoryFor = (page: SettingsPage): SettingsCategory =>
  page === 'official' || page === 'custom' || page === 'comfy' || page === 'extensions' ? 'models' : page;
