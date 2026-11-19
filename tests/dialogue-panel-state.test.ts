import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dialogueEdits, dialoguePanelDirty, dialogueSubjectNames, formatDialogueText, newDialogueLineId, parseDialogueText,
} from '../apps/web/src/dialogue-panel-state.ts';

const line = (n: number, text: string, speakerSubjectId?: string) =>
  ({id: `80000000-0000-4000-8000-${String(n).padStart(12, '0')}`, text, ...(speakerSubjectId ? {speakerSubjectId} : {})});
const subjectA = '80000000-0000-4000-8000-000000000101', subjectB = '80000000-0000-4000-8000-000000000102';
const names = dialogueSubjectNames([{id: subjectA, name: '阿璃'}, {id: subjectB, name: '阿峰'}, {id: 'x'}]);
const shotId = '80000000-0000-4000-8000-000000000001';

test('the panel text shows the speaker name and parses it back to the same line', () => {
  const lines = [line(1, '我们回不去了。', subjectA), line(2, '走吧。', subjectB), line(3, '旁白一行')];
  const text = formatDialogueText(lines, names);
  assert.equal(text, '阿璃：我们回不去了。\n阿峰：走吧。\n旁白一行');
  assert.deepEqual(parseDialogueText(text, names), [
    {text: '我们回不去了。', speakerSubjectId: subjectA},
    {text: '走吧。', speakerSubjectId: subjectB},
    {text: '旁白一行', speakerSubjectId: null},
  ]);
  assert.equal(dialoguePanelDirty(lines, parseDialogueText(text, names)), false);
  // An unknown speaker name stays in the line text instead of being stripped.
  const unknown = parseDialogueText('陌生人：你好', names);
  assert.deepEqual(unknown, [{text: '陌生人：你好', speakerSubjectId: null}]);
  // A known name inside the line (not at the start) is not a speaker prefix.
  assert.deepEqual(parseDialogueText('对阿璃：说', names), [{text: '对阿璃：说', speakerSubjectId: null}]);
  assert.deepEqual(parseDialogueText('', names), []);
});

test('editing text diffing reuses ids, adds and removes only the changed lines', () => {
  const lines = [line(1, '一'), line(2, '二'), line(3, '三')];
  // No change.
  assert.deepEqual(dialogueEdits(shotId, lines, parseDialogueText('一\n二\n三', names)), []);
  // Middle text change keeps the line id.
  assert.deepEqual(dialogueEdits(shotId, lines, parseDialogueText('一\n二改\n三', names)),
    [{kind: 'update', shotId, lineId: lines[1]!.id, text: '二改', speakerSubjectId: null}]);
  // Append and remove.
  assert.deepEqual(dialogueEdits(shotId, lines, parseDialogueText('一\n二\n三\n四', names), () => 'new-id')[0],
    {kind: 'add', shotId, line: {id: 'new-id', text: '四'}});
  assert.deepEqual(dialogueEdits(shotId, lines, parseDialogueText('一\n三', names)),
    [{kind: 'remove', shotId, lineId: lines[1]!.id}]);
  // Replacing one line with two: the first keeps the id, the second is added.
  const split = dialogueEdits(shotId, lines, parseDialogueText('一\n二上\n二下\n三', names), () => 'new-id');
  assert.deepEqual(split, [
    {kind: 'update', shotId, lineId: lines[1]!.id, text: '二上', speakerSubjectId: null},
    {kind: 'add', shotId, line: {id: 'new-id', text: '二下'}},
  ]);
  // Clearing the panel removes every line.
  assert.deepEqual(dialogueEdits(shotId, lines, []), lines.map(item => ({kind: 'remove', shotId, lineId: item.id})));
  // A speaker can be added or changed through the same text edits.
  const withSpeaker = dialogueEdits(shotId, [line(1, '一句')], parseDialogueText('阿璃：一句', names));
  assert.deepEqual(withSpeaker, [{kind: 'update', shotId, lineId: lines[0]!.id, text: '一句', speakerSubjectId: subjectA}]);
});

test('the dirty flag compares lines, speakers and order', () => {
  const lines = [line(1, '一', subjectA), line(2, '二')];
  assert.equal(dialoguePanelDirty(lines, parseDialogueText(formatDialogueText(lines, names), names), names), false);
  assert.equal(dialoguePanelDirty(lines, parseDialogueText('二\n阿璃：一', names), names), true);
  assert.equal(dialoguePanelDirty(lines, parseDialogueText('一\n二', names), names), true, 'a dropped speaker is a change');
});

test('a speaker whose name is not loaded stays on the line instead of looking dirty', () => {
  const unloaded = line(1, '一句', '80000000-0000-4000-8000-000000000199');
  const text = formatDialogueText([unloaded], names);
  assert.equal(text, '一句');
  const draft = parseDialogueText(text, names);
  assert.equal(dialoguePanelDirty([unloaded], draft, names), false, 'an unloaded speaker is not a change');
  assert.deepEqual(dialogueEdits(shotId, [unloaded], draft, () => 'new-id', names), []);
  // Editing the text keeps the stored speaker because the edit carries no speaker field.
  const edited = dialogueEdits(shotId, [unloaded], parseDialogueText('一句改', names), () => 'new-id', names);
  assert.deepEqual(edited, [{kind: 'update', shotId, lineId: unloaded.id, text: '一句改'}]);
  // A line whose speaker name IS loaded still drops the prefix when the user removes it.
  const named = line(1, '一句', subjectA);
  assert.equal(dialoguePanelDirty([named], parseDialogueText('一句', names), names), true);
  assert.deepEqual(dialogueEdits(shotId, [named], parseDialogueText('一句', names), () => 'new-id', names),
    [{kind: 'update', shotId, lineId: named.id, text: '一句', speakerSubjectId: null}]);
});

test('new dialogue line ids are unique uuids', () => {
  const ids = new Set(Array.from({length: 20}, () => newDialogueLineId()));
  assert.equal(ids.size, 20);
  for (const id of ids) assert.match(id, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u);
});
