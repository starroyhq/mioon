import {prepareGenerationAspect} from './generation-settings.ts';
import type {GenerationFrame, GenerationProvider, GenerationShot} from './generation-settings.ts';
import type {GenerationAspectSource} from '../../../packages/contracts/src/generation-aspect.ts';
import {message} from '../../../packages/i18n/src/index.ts';
import type {DisplayMessage} from '../../../packages/i18n/src/index.ts';

/** Format-5 generation runs the same project-frame step as formats 3/4.
 *
 * The board property panel and the editing 21-09 panel share this entry so a
 * new generation always carries `aspectSource`; without it the server derives
 * no aspect and providers such as Mock reject the request. Format 5 always has
 * a frame timeline, but keep the caller's flag path explicit for old projects. */
export interface Format5GenerationEntryInput<T extends GenerationShot> {
  readonly shot: T;
  readonly provider: GenerationProvider | undefined;
  readonly model: string;
  readonly options: Record<string, unknown>;
  readonly frame: GenerationFrame | null;
}
export type Format5GenerationEntryResult<T extends GenerationShot> =
  | {readonly issue: DisplayMessage; readonly shot?: never; readonly aspectSource?: never}
  | {readonly shot: T; readonly aspectSource?: GenerationAspectSource; readonly issue?: never};

export function format5GenerationEntry<T extends GenerationShot>(input: Format5GenerationEntryInput<T>): Format5GenerationEntryResult<T> {
  const frame = input.frame;
  if (!frame) return {issue: message('shell.generationFrameChanged')};
  const aspect = prepareGenerationAspect(frame, input.shot, input.provider, input.model, input.options);
  if (aspect.issue) return {issue: aspect.issue};
  return {shot: aspect.shot, ...(aspect.source ? {aspectSource: aspect.source} : {})};
}
