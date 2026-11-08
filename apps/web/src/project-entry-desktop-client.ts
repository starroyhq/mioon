import {projectEntryDesktopRequestSchema, projectDesktopCapabilitiesSchema, projectDesktopSelectionSchema, projectDesktopOpenResultSchema, projectDesktopCreatedSchema, projectDesktopLocationSchema} from '../../../packages/contracts/src/project-entry-desktop.ts';
import type {ProjectEntriesDesktopBridge} from '../../../packages/contracts/src/project-entry-desktop.ts';
import {projectEntriesResponseSchema} from '../../../packages/contracts/src/project-entry.ts';
import {projectCopyResponseSchema} from '../../../packages/contracts/src/project-copies.ts';
import {projectEntryControlErrorSchema} from '../../../packages/contracts/src/project-entry-control.ts';

interface Parser<T> {parse(value: unknown): T}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
/** Only the exposed S6-B/B2 methods are admitted. Renderer paths never become
 * filesystem authority; all selected files remain opaque host tickets. */
export function readProjectEntryDesktopClient(source: unknown): ProjectEntriesDesktopBridge | null {
  if (!record(source) || typeof source.__mioonProjectEntries !== 'object' || source.__mioonProjectEntries === null) return null;
  const candidate = source.__mioonProjectEntries;
  if (!record(candidate) || typeof candidate.capabilities !== 'function') return null;
  const raw: Record<string, unknown> = candidate;
  async function call<T>(action: string, input: Record<string, unknown>, parser: Parser<T>): Promise<T> {
    const request = projectEntryDesktopRequestSchema.parse({action, ...input}), method = raw[action];
    if (typeof method !== 'function') throw Object.assign(new Error('Native entry unavailable'), {code: 'PROJECT_ENTRY_UNAVAILABLE'});
    const {action: _action, ...args} = request;
    try {return parser.parse(await Reflect.apply(method, raw, Object.keys(args).length ? [args] : []));}
    catch (error) {
      const parsed = projectEntryControlErrorSchema.safeParse(error);
      if (parsed.success) throw Object.assign(new Error(parsed.data.code), parsed.data);
      throw error;
    }
  }
  const nullable = <T>(parser: Parser<T>): Parser<T | null> => ({parse: value => value === null ? null : parser.parse(value)});
  const empty: Parser<void> = {parse(value) {if (value !== undefined && value !== null) throw new Error('Invalid native acknowledgement');}};
  return Object.freeze({
    capabilities: async () => ({...await call('capabilities', {}, projectDesktopCapabilitiesSchema), saveAs: false}),
    listRecent: () => call('listRecent', {}, projectEntriesResponseSchema),
    chooseLocation: async input => {const selection=await call('chooseLocation', input, nullable(projectDesktopSelectionSchema));if(selection!==null&&(input.purpose==='template'?!selection.template:Object.hasOwn(selection,'template')))throw new Error('Invalid project selection');return selection;},
    createAtSelection: input => call('createAtSelection', input, projectDesktopCreatedSchema),
    openSelectedFile: () => call('openSelectedFile', {}, projectDesktopOpenResultSchema),
    takePendingOpen: () => call('takePendingOpen', {}, nullable(projectDesktopOpenResultSchema)),
    ...(typeof raw.subscribePendingOpen === 'function' ? {subscribePendingOpen(listener: () => void) {
      let active = true;
      const release: unknown = Reflect.apply(raw.subscribePendingOpen as (...args: unknown[]) => unknown, raw, [() => {if (active) listener();}]);
      if (typeof release !== 'function') {active = false; throw new Error('Invalid native pending-open subscription');}
      return () => {if (active) {active = false; release();}};
    }} : {}),
    openPrivacySettings: () => call('openPrivacySettings', {}, empty),
    reveal: input => call('reveal', input, empty),
    openOriginal: input => call('openOriginal', input, projectDesktopOpenResultSchema),
    currentLocation: () => call('currentLocation', {}, projectDesktopLocationSchema),
    openRecent: input => call('openRecent', input, projectDesktopOpenResultSchema),
    adoptCopy: input => call('adoptCopy', input, projectDesktopOpenResultSchema),
    saveAs: async () => {throw Object.assign(new Error('Window replacement unavailable'), {code: 'PROJECT_ENTRY_UNAVAILABLE'});},
    duplicate: input => call('duplicate', input, projectCopyResponseSchema),
    ...(typeof raw.instantiateTemplate === 'function' ? {instantiateTemplate: (input: Parameters<NonNullable<ProjectEntriesDesktopBridge['instantiateTemplate']>>[0]) => call('instantiateTemplate', input, projectCopyResponseSchema)} : {}),
    copyTo: input => call('copyTo', input, projectCopyResponseSchema),
  } satisfies ProjectEntriesDesktopBridge);
}
