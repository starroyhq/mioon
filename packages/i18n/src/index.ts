import { mioConversationMessages } from './catalogs/mio-conversations.ts';
import { mioPanelMessages } from './catalogs/mio-panel.ts';
import { canvasTimelineMessages } from './catalogs/canvas-timeline.ts';
import { sceneDetectionMessages } from './catalogs/scene-detection.ts';
import { agentTaskMessages } from './catalogs/agent-tasks.ts';
import { agentTaskErrorMessages } from './catalogs/agent-task-errors.ts';
import { videoProviderMessages } from './catalogs/video-providers.ts';
import { round4TaskMessages } from './catalogs/round4-tasks.ts';
import { clipLoudnessMatchMessages } from './catalogs/clip-loudness-match.ts';
import { round3EditingMessages } from './catalogs/round3-editing.ts';
import { round3TimelineMessages } from './catalogs/round3-timeline.ts';
import {workspaceConfigurationMessages} from './catalogs/workspace-configuration.ts';
import { opacityEnvelopeMessages } from './catalogs/opacity-envelope.ts';
import { redesignOutputMessages } from './catalogs/redesign-output.ts';
import { workbenchShellMessages } from './catalogs/workbench-shell.ts';
import { exportWorkflowMessages } from './catalogs/export-workflow.ts';
import { timelineEditingMessages } from './catalogs/timeline-editing.ts';
import { workspaceToolsMessages } from './catalogs/workspace-tools.ts';
import { settingsRedesignMessages } from './catalogs/settings-redesign.ts';
import { exportFileMessages } from './catalogs/export-file.ts';
import { projectBrowserMessages } from './catalogs/project-browser.ts';
import { projectPackageMessages } from './catalogs/project-package.ts';
import { redesignBoardMessages } from './catalogs/redesign-board.ts';
import { appearanceMessages } from './catalogs/appearance.ts';
import { opacityRestoredApplicationMessages } from './catalogs/opacity-restored-application.ts';
import { volumeEnvelopeMessages } from './catalogs/volume-envelope.ts';
import { audioRoleMessages } from './catalogs/audio-role.ts';
import { clipLoudnessMessages } from './catalogs/clip-loudness.ts';
import { comparisonMessages } from './catalogs/comparison.ts';
import { annotationMessages } from './catalogs/annotations.ts';
import { commandMessages } from './catalogs/command.ts';
import { operationMessages } from './catalogs/operations.ts';
import { foundationMessages } from './catalogs/foundation.ts';
import { nativeMessages } from './catalogs/native.ts';
import { shellMessages } from './catalogs/shell.ts';
import { creationMessages } from './catalogs/creation.ts';
import { timelineMessages } from './catalogs/timeline.ts';
import { isLocale, LOCALES } from './locale.ts';
import type { DisplayMessage, Locale, MessageCatalog, MessageParameters, MessageTemplate } from './types.ts';
export * from './types.ts';
export * from './locale.ts';
import { assertNoDuplicateMessageKeys } from './catalog-integrity.ts';
export { assertNoDuplicateMessageKeys } from './catalog-integrity.ts';
assertNoDuplicateMessageKeys(mioConversationMessages, mioPanelMessages, canvasTimelineMessages, sceneDetectionMessages, agentTaskErrorMessages, agentTaskMessages, videoProviderMessages, round4TaskMessages, clipLoudnessMatchMessages, round3EditingMessages, round3TimelineMessages, workspaceConfigurationMessages, projectBrowserMessages, projectPackageMessages, redesignBoardMessages, exportFileMessages, workspaceToolsMessages, settingsRedesignMessages, exportWorkflowMessages, timelineEditingMessages, appearanceMessages, workbenchShellMessages, redesignOutputMessages, opacityRestoredApplicationMessages, opacityEnvelopeMessages, volumeEnvelopeMessages, audioRoleMessages, comparisonMessages, annotationMessages, clipLoudnessMessages, commandMessages, operationMessages, foundationMessages, nativeMessages, shellMessages, creationMessages, timelineMessages);
export const catalogs = Object.freeze({ ...mioConversationMessages, ...mioPanelMessages, ...canvasTimelineMessages, ...sceneDetectionMessages, ...agentTaskErrorMessages, ...agentTaskMessages, ...videoProviderMessages, ...round4TaskMessages, ...clipLoudnessMatchMessages, ...round3EditingMessages, ...round3TimelineMessages, ...workspaceConfigurationMessages, ...projectBrowserMessages, ...projectPackageMessages, ...redesignBoardMessages, ...exportFileMessages, ...workspaceToolsMessages, ...settingsRedesignMessages, ...exportWorkflowMessages, ...timelineEditingMessages, ...appearanceMessages, ...workbenchShellMessages, ...redesignOutputMessages, ...opacityRestoredApplicationMessages, ...opacityEnvelopeMessages, ...volumeEnvelopeMessages, ...audioRoleMessages, ...clipLoudnessMessages, ...comparisonMessages, ...annotationMessages, ...commandMessages, ...operationMessages, ...foundationMessages, ...nativeMessages, ...shellMessages, ...creationMessages, ...timelineMessages });
export type MessageKey = keyof typeof catalogs;
type TemplateText<T> = T extends string ? T : T extends { one: infer O extends string; other: infer R extends string } ? O | R : never;
type Placeholders<T extends string> = T extends `${string}{${infer P}}${infer Rest}` ? P | Placeholders<Rest> : never;
type Parameters<K extends MessageKey> = { readonly [P in Placeholders<TemplateText<(typeof catalogs)[K]['zh-Hans']>>]: P extends 'count' ? number : string | number };
export type MessageArguments<K extends MessageKey> = keyof Parameters<K> extends never ? [params?: never] : [params: Parameters<K>];
export type MessageDescriptor<K extends MessageKey = MessageKey> = Readonly<{ key: K; params?: MessageParameters }>;
export function message<K extends MessageKey>(key: K, ...args: MessageArguments<K>): MessageDescriptor<K> {
  const params = args[0] as MessageParameters | undefined;
  return Object.freeze({ key, ...(params ? { params: Object.freeze({ ...params }) } : {}) });
}
const missing: Readonly<Record<Locale, string>> = Object.freeze({ 'zh-Hans': '此提示暂时无法显示', 'zh-Hant': '此提示暫時無法顯示', en: 'This message cannot be displayed right now', ja: '現在、このメッセージを表示できません' });
function formatTemplate(locale: Locale, template: MessageTemplate, params: MessageParameters = {}): string {
  let value: string;
  if (typeof template === 'string') value = template;
  else {
    const count = Object.getOwnPropertyDescriptor(params, 'count');
    if (!count || !Object.hasOwn(count, 'value') || typeof count.value !== 'number' || !Number.isFinite(count.value)) throw new TypeError('A plural message requires a finite count.');
    value = new Intl.PluralRules(locale).select(count.value) === 'one' ? template.one : template.other;
  }
  return value.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/gu, (_match, name: string) => {
    const descriptor = Object.getOwnPropertyDescriptor(params, name);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || (typeof descriptor.value !== 'string' && typeof descriptor.value !== 'number') ||
      typeof descriptor.value === 'number' && !Number.isFinite(descriptor.value)) throw new TypeError(`Invalid message parameter: ${name}`);
    // Count selection uses the raw numeric value; its human-readable form is
    // locale-aware. IDs, frame/revision parameters and wire data are untouched.
    return name === 'count' && typeof descriptor.value === 'number'
      ? new Intl.NumberFormat(locale, { maximumFractionDigits: 20 }).format(descriptor.value)
      : String(descriptor.value);
  });
}
/** Strict for app calls: a missing key/parameter is a bug, never silent Chinese fallback. */
export function translate<K extends MessageKey>(locale: Locale, key: K, ...args: MessageArguments<K>): string {
  if (!isLocale(locale) || !Object.hasOwn(catalogs, key)) throw new TypeError('Unknown locale or message key.');
  const entry = (catalogs as MessageCatalog)[key];
  return formatTemplate(locale, entry[locale], args[0] as MessageParameters | undefined);
}
/** Presentation boundary for persisted-in-memory descriptors, not arbitrary server messages. */
export function renderMessage(locale: Locale, value: DisplayMessage | string | null | undefined): string {
  if (value == null) return '';
  if (typeof value === 'string') return value; // Staged migration and user content remain unchanged.
  try {
    if (!isLocale(locale) || !Object.hasOwn(catalogs, value.key)) return missing[isLocale(locale) ? locale : 'en'];
    return formatTemplate(locale, (catalogs as MessageCatalog)[value.key][locale], value.params);
  } catch { return missing[isLocale(locale) ? locale : 'en']; }
}
export function formatNumber(locale: Locale, value: number, options?: Intl.NumberFormatOptions): string { return new Intl.NumberFormat(locale, options).format(value); }
export function formatDate(locale: Locale, value: string | number | Date, options?: Intl.DateTimeFormatOptions): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(locale, options).format(date) : translate(locale, 'common.unknownTime');
}
/** Used by tests and authoring checks; not a runtime translation service. */
export function validateCatalogs(catalog: MessageCatalog = catalogs): readonly string[] {
  const errors: string[] = [];
  const placeholders = (text: string) => [...new Set([...text.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/gu)].map(match => match[1]))].sort().join(',');
  for (const [key, entry] of Object.entries(catalog)) {
    if (Object.keys(entry).sort().join(',') !== [...LOCALES].sort().join(',')) errors.push(`${key}: locales differ`);
    const source = entry['zh-Hans'];
    for (const locale of LOCALES) {
      const target = entry[locale];
      if (typeof target !== typeof source || !target) { errors.push(`${key}/${locale}: missing or different template kind`); continue; }
      if (typeof source === 'string' && typeof target === 'string') {
        if (!target.trim() || placeholders(source) !== placeholders(target)) errors.push(`${key}/${locale}: empty or different placeholders`);
      } else if (typeof source === 'object' && typeof target === 'object') {
        if (Object.keys(target).sort().join(',') !== 'one,other') errors.push(`${key}/${locale}: plural branches differ`);
        for (const branch of ['one', 'other'] as const) if (!target[branch]?.trim() || placeholders(source[branch]) !== placeholders(target[branch]) || !placeholders(target[branch]).split(',').includes('count')) errors.push(`${key}/${locale}/${branch}: invalid plural parameters`);
      }
    }
  }
  return errors;
}
