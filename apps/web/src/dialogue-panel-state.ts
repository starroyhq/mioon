/** DL-a shot dialogue panel state (DOM-free).
 *
 * The shot properties panel shows one visual line per dialogue line; a line with
 * a speaker is written as `名字：台词`. This module formats the stored lines into
 * that text and turns an edited text back into the edits of one `dialogueIntent`
 * action. All of it is pure so the panel logic can be tested without a browser.
 */
import type {SequenceEditDialogueEdit} from '../../../packages/contracts/src/sequence-edit.ts';

export interface DialogueLineView {
  readonly id: string;
  readonly text: string;
  readonly speakerSubjectId?: string;
}
export interface DialogueDraftLine {
  readonly text: string;
  readonly speakerSubjectId: string | null;
}

const SPEAKER_SEPARATOR = '：';
const uuid = (): string => globalThis.crypto?.randomUUID?.() ??
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, character => {
    const value = Math.floor(Math.random() * 16);
    return (character === 'x' ? value : (value & 0x3) | 0x8).toString(16);
  });
export const newDialogueLineId = (): string => uuid();

/** Subject id -> display name; lines whose speaker is unknown fall back to raw text. */
export function dialogueSubjectNames(subjects: readonly {readonly id: string; readonly name?: string}[]): Record<string, string> {
  const names: Record<string, string> = {};
  for (const subject of subjects) if (subject.name) names[subject.id] = subject.name;
  return names;
}

/** Render the stored lines as the editable panel text. */
export function formatDialogueText(lines: readonly DialogueLineView[], subjectNames: Readonly<Record<string, string>>): string {
  return lines.map(line => {
    const name = line.speakerSubjectId === undefined ? undefined : subjectNames[line.speakerSubjectId];
    return name ? `${name}${SPEAKER_SEPARATOR}${line.text}` : line.text;
  }).join('\n');
}

function speakerByName(subjectNames: Readonly<Record<string, string>>): Map<string, string> {
  const byName = new Map<string, string>();
  for (const [id, name] of Object.entries(subjectNames)) byName.set(name, id);
  return byName;
}

/** Parse the panel text back into lines. A known subject name followed by the
 * full-width colon selects the speaker; anything else stays in the line text so
 * a dialogue line that happens to contain a colon is never truncated silently. */
export function parseDialogueText(text: string, subjectNames: Readonly<Record<string, string>>): DialogueDraftLine[] {
  const byName = speakerByName(subjectNames);
  if (text === '') return [];
  return text.split('\n').map(raw => {
    const line = raw.replace(/\s+$/u, '');
    for (const name of [...byName.keys()].sort((left, right) => right.length - left.length)) {
      const prefix = `${name}${SPEAKER_SEPARATOR}`;
      if (line.startsWith(prefix)) return {text: line.slice(prefix.length), speakerSubjectId: byName.get(name)!};
    }
    return {text: line, speakerSubjectId: null};
  });
}

function sameLine(line: DialogueLineView, draft: DialogueDraftLine,
  subjectNames: Readonly<Record<string, string>>): boolean {
  if (line.text !== draft.text) return false;
  if ((line.speakerSubjectId ?? null) === draft.speakerSubjectId) return true;
  // A speaker whose name is not loaded yet cannot be shown in the text; keeping
  // the stored speaker must not look like an unsaved change (otherwise saving an
  // untouched panel would strip it).
  return line.speakerSubjectId !== undefined && subjectNames[line.speakerSubjectId] === undefined;
}

/** Diff stored lines against the edited text into one action's edits.
 *
 * Unchanged prefix/suffix lines keep their ids. The middle is paired by position
 * as `update` edits so a text change never loses a line identity; extra new
 * lines become `add` edits (fresh ids) and extra old lines become `remove`
 * edits. Editing order therefore never needs a separate reorder action. */
export function dialogueEdits(
  shotId: string, lines: readonly DialogueLineView[], draft: readonly DialogueDraftLine[],
  allocateId: () => string = newDialogueLineId,
  subjectNames: Readonly<Record<string, string>> = {},
): SequenceEditDialogueEdit[] {
  let prefix = 0;
  while (prefix < lines.length && prefix < draft.length && sameLine(lines[prefix]!, draft[prefix]!, subjectNames)) prefix++;
  let suffix = 0;
  while (suffix < lines.length - prefix && suffix < draft.length - prefix
    && sameLine(lines[lines.length - 1 - suffix]!, draft[draft.length - 1 - suffix]!, subjectNames)) suffix++;
  const oldMiddle = lines.slice(prefix, lines.length - suffix);
  const newMiddle = draft.slice(prefix, draft.length - suffix);
  const edits: SequenceEditDialogueEdit[] = [];
  const paired = Math.min(oldMiddle.length, newMiddle.length);
  for (let index = 0; index < paired; index++) {
    const oldLine = oldMiddle[index]!, draftLine = newMiddle[index]!;
    if (sameLine(oldLine, draftLine, subjectNames)) continue;
    const speakerUnknown = oldLine.speakerSubjectId !== undefined
      && subjectNames[oldLine.speakerSubjectId] === undefined && draftLine.speakerSubjectId === null;
    edits.push({kind: 'update', shotId, lineId: oldLine.id, text: draftLine.text,
      ...(speakerUnknown ? {} : {speakerSubjectId: draftLine.speakerSubjectId})});
  }
  for (let index = paired; index < newMiddle.length; index++) {
    const draftLine = newMiddle[index]!;
    edits.push({kind: 'add', shotId,
      line: {...(draftLine.speakerSubjectId === null ? {} : {speakerSubjectId: draftLine.speakerSubjectId}),
        id: allocateId(), text: draftLine.text}});
  }
  for (let index = paired; index < oldMiddle.length; index++) {
    edits.push({kind: 'remove', shotId, lineId: oldMiddle[index]!.id});
  }
  return edits;
}

/** Presence of any edit means the panel has unsaved changes. */
export function dialoguePanelDirty(lines: readonly DialogueLineView[], draft: readonly DialogueDraftLine[],
  subjectNames: Readonly<Record<string, string>> = {}): boolean {
  if (lines.length !== draft.length) return true;
  return lines.some((line, index) => !sameLine(line, draft[index]!, subjectNames));
}
