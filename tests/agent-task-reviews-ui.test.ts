import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTargetMarks, markLabelPosition, markTargetElements, MARK_ATTRIBUTE } from '../apps/web/src/target-marks.ts';
import { createAgentReviewMarks, createReviewArrivals, parseReviewIssueOwner, revealReviewIssue, reviewIssueOwner, reviewMarkTargets, taskContinuityReportOf, taskSkillReadOf, taskSkillTitleKey } from '../apps/web/src/agent-task-reviews.ts';
import { taskStepTitle } from '../apps/web/src/agent-task-presentation.ts';
import { projectNotesOf, projectNotesProblem, saveProjectNotes } from '../apps/web/src/project-notes.ts';
import type { ProjectNotesCall } from '../apps/web/src/project-notes.ts';
import { ApiError } from '../apps/web/src/api.ts';
import type { AgentTaskSnapshot, AgentTaskStep } from '../packages/contracts/src/agent-tasks-v2.ts';
import { AGENT_TASK_CONTINUITY_CATEGORIES, AGENT_TASK_SKILL_NAMES } from '../packages/contracts/src/agent-tasks-v2.ts';
import { LOCALES, translate } from '../packages/i18n/src/index.ts';
import type { MessageKey } from '../packages/i18n/src/index.ts';

const read = (name: string) => readFileSync(new URL(`../apps/web/src/${name}`, import.meta.url), 'utf8');

// A minimal DOM: attribute and class selectors (with ',' and '>'), layout boxes, a paint order for hit tests.
interface Rect { left: number; top: number; width: number; height: number }
class FakeElement {
  readonly attributes = new Map<string, string>();
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  rect: Rect = { left: 0, top: 0, width: 0, height: 0 };
  scrolls: unknown[] = [];
  focused: unknown[] = [];
  scrollTop = 0; scrollHeight = 0; clientHeight = 0;
  readonly owner: FakeDocument;
  constructor(owner: FakeDocument, attributes: Record<string, string> = {}) { this.owner = owner; for (const [name, value] of Object.entries(attributes)) this.attributes.set(name, value); }
  get ownerDocument(): FakeDocument { return this.owner; }
  getClientRects(): Rect[] { return this.rect.width > 0 && this.rect.height > 0 ? [this.rect] : []; }
  get isConnected(): boolean { for (let node: FakeElement | null = this; node; node = node.parent) if (node === this.owner.root) return true; return false; }
  append(...children: FakeElement[]): this { for (const child of children) { child.parent = this; this.children.push(child); } return this; }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  setAttribute(name: string, value: string): void { this.attributes.set(name, String(value)); }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  hasAttribute(name: string): boolean { return this.attributes.has(name); }
  matches(selector: string): boolean { return selector.split(',').some(part => matchesChain(this, part.trim().split(/\s*>\s*/u))); }
  closest(selector: string): FakeElement | null { for (let node: FakeElement | null = this; node; node = node.parent) if (node.matches(selector)) return node; return null; }
  contains(other: FakeElement | null): boolean { for (let node = other; node; node = node.parent) if (node === this) return true; return false; }
  getBoundingClientRect() { const { left, top, width, height } = this.rect; return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top }; }
  scrollIntoView(options?: unknown): void { this.scrolls.push(options); }
  focus(options?: unknown): void { this.focused.push(options); }
  querySelectorAll(selector: string): FakeElement[] { return descendants(this).filter(element => element.matches(selector)); }
  querySelector(selector: string): FakeElement | null { return this.querySelectorAll(selector)[0] ?? null; }
}
function matchesCompound(element: FakeElement, compound: string): boolean {
  const pattern = /\.([\w-]+)|#([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/gyu;
  let index = 0;
  while (index < compound.length) {
    pattern.lastIndex = index;
    const match = pattern.exec(compound);
    if (!match) throw new Error(`Unsupported selector: ${compound}`);
    index = pattern.lastIndex;
    if (match[1] && !(element.getAttribute('class') ?? '').split(/\s+/u).includes(match[1])) return false;
    if (match[2] && element.getAttribute('id') !== match[2]) return false;
    if (match[3] && (match[4] === undefined ? !element.hasAttribute(match[3]) : element.getAttribute(match[3]) !== match[4])) return false;
  }
  return true;
}
function matchesChain(element: FakeElement, steps: string[]): boolean {
  if (!matchesCompound(element, steps.at(-1)!)) return false;
  let node: FakeElement | null = element;
  for (let index = steps.length - 2; index >= 0; index--) { node = node?.parent ?? null; if (!node || !matchesCompound(node, steps[index]!)) return false; }
  return true;
}
const descendants = (element: FakeElement): FakeElement[] => element.children.flatMap(child => [child, ...descendants(child)]);
class FakeDocument {
  readonly root: FakeElement;
  readonly defaultView = { innerWidth: 1440, innerHeight: 900 };
  constructor() { this.root = new FakeElement(this); }
  element(attributes: Record<string, string>, box?: Rect): FakeElement { const element = new FakeElement(this, attributes); if (box) element.rect = box; return element; }
  querySelectorAll(selector: string): FakeElement[] { return this.root.querySelectorAll(selector); }
  // Later elements paint over earlier ones.
  elementsFromPoint(x: number, y: number): FakeElement[] {
    return descendants(this.root).filter(({ rect }) => rect.width > 0 && rect.height > 0 && x >= rect.left && x < rect.left + rect.width && y >= rect.top && y < rect.top + rect.height).reverse();
  }
  get dom(): Document { return this as unknown as Document; }
}
const rect = (left: number, top: number, width: number, height: number): Rect => ({ left, top, width, height });

/** A canvas with two shot nodes and the storyboard strip floating over its bottom, as in 09-09. */
function boardScene() {
  const doc = new FakeDocument();
  const flow = doc.element({ class: 'react-flow' }, rect(0, 44, 1440, 856));
  const node = (id: string, box: Rect) => { const element = doc.element({ class: 'canvas-node shot-node', 'data-testid': `shot-node-${id}` }, box); flow.append(doc.element({ class: 'react-flow__node' }, box).append(element)); return element; };
  const a = node('a', rect(200, 200, 180, 160)), b = node('b', rect(500, 200, 180, 160));
  const track = doc.element({ class: 'storyboard-track', 'data-testid': 'storyboard' }, rect(300, 760, 700, 90));
  const frame = (id: string, left: number) => { const preview = doc.element({ class: 'storyboard-preview' }, rect(left, 770, 46, 70)); track.append(doc.element({ class: 'storyboard-shot', 'data-testid': `storyboard-shot-${id}` }, rect(left, 770, 46, 90)).append(preview)); return preview; };
  const frameA = frame('a', 320), frameB = frame('b', 380);
  // A copy in the inspector is never marked.
  const copy = doc.element({ class: 'inspector' }).append(doc.element({ 'data-testid': 'storyboard-shot-a' }).append(doc.element({ class: 'storyboard-preview' })));
  doc.root.append(flow, doc.element({ class: 'board-storyboard' }, rect(280, 740, 740, 120)).append(track), copy);
  return { doc, a, b, frameA, frameB };
}

const projectId = '11111111-1111-4111-8111-111111111111', runId = '22222222-2222-4222-8222-222222222222', time = '2026-10-29T00:00:00.000Z';
const shotA = '55555555-5555-4555-8555-555555555555', shotB = '66666666-6666-4666-8666-666666666666';
let position = 1;
function toolStep(name: string, args: unknown, patch: Partial<AgentTaskStep> = {}): AgentTaskStep {
  return { id: crypto.randomUUID(), runId, position: position++, kind: 'tool', status: 'completed', createdAt: time, updatedAt: time, toolCall: { id: `call_${position}`, name, arguments: args as never }, tier: 'read_only', ...patch };
}
const report = (issues: unknown[], patch: Partial<AgentTaskStep> = {}) => toolStep('mioon_continuity_report', { issues }, patch);
const round = (steps: AgentTaskStep[], id = runId): AgentTaskSnapshot => ({ run: { id, projectId, conversationId: runId, requestId: '44444444-4444-4444-8444-444444444444', text: '检查一下连续性', status: 'running', revision: steps.length + 1, stepLimit: 30, budget: 30, stepsUsed: steps.length, configuration: {}, createdAt: time, updatedAt: time }, steps, changes: [] });

test('saved continuity reports and method reads are read only from their saved arguments', () => {
  const issues = [{ category: 'props', shotIds: [shotA], text: '镜头 04 左手持伞，镜头 03 是右手。' }];
  assert.deepEqual(taskContinuityReportOf(report(issues)), issues);
  assert.equal(taskContinuityReportOf(report(issues, { status: 'dispatch_started' })), null, 'an unfinished report shows nothing');
  assert.equal(taskContinuityReportOf(report([{ category: 'weather', shotIds: [shotA], text: 'x' }])), null, 'an invalid report shows nothing');
  assert.equal(taskContinuityReportOf(toolStep('mioon_shot_list', { issues })), null);
  assert.equal(taskSkillReadOf(toolStep('mioon_skill_read', { name: 'continuity-check' })), 'continuity-check');
  assert.equal(taskSkillReadOf(toolStep('mioon_skill_read', { name: 'unknown-method' })), null);
  assert.equal(taskSkillTitleKey('script-to-shots'), 'agent.skill.title.scriptToShots');
  const owner = reviewIssueOwner(runId, 3);
  assert.deepEqual(parseReviewIssueOwner(owner), { stepId: runId, index: 3 });
  assert.equal(parseReviewIssueOwner('change:x'), null);
});

test('a method read is titled with the method name in every locale, never with the model explanation', () => {
  const step = toolStep('mioon_skill_read', { name: 'continuity-check', section: '步骤' }, { text: '我先读一下方法' });
  assert.equal(taskStepTitle(step, 'zh-Hans'), '读取方法：连续性检查');
  assert.equal(taskStepTitle(step, 'en'), 'Read method: Continuity check');
  for (const locale of LOCALES) for (const name of AGENT_TASK_SKILL_NAMES) {
    const title = translate(locale, taskSkillTitleKey(name) as MessageKey);
    assert.ok(title && !title.startsWith('agent.'), `${locale} ${name}`);
    assert.ok(taskStepTitle(toolStep('mioon_skill_read', { name }), locale).includes(title));
  }
  for (const locale of LOCALES) for (const category of AGENT_TASK_CONTINUITY_CATEGORIES) assert.ok(!translate(locale, `agent.review.category.${category}` as MessageKey).startsWith('agent.'), `${locale} ${category}`);
  assert.equal(taskStepTitle(toolStep('mioon_skill_read', { name: 'other' }, { text: '读取方法' }), 'zh-Hans'), '读取方法', 'an unknown method falls back to the plain step title');
});

test('only reports that arrive while their round is on screen are announced, once each', () => {
  const arrivals = createReviewArrivals(), issues = [{ category: 'wardrobe', shotIds: [shotA, shotB], text: '手表' }];
  const old = report(issues);
  assert.deepEqual(arrivals.arrived([round([old])]), [], 'a first read of a round announces none of its reports');
  const live = report([{ category: 'eyeline', shotIds: [shotB], text: '视线' }, { category: 'sound', shotIds: [shotA], text: '雨声' }]);
  const fresh = arrivals.arrived([round([old, live])]);
  assert.deepEqual(fresh, [{ owner: reviewIssueOwner(live.id, 0), category: 'eyeline', shotIds: [shotB] }, { owner: reviewIssueOwner(live.id, 1), category: 'sound', shotIds: [shotA] }]);
  assert.deepEqual(arrivals.arrived([round([old, live])]), [], 'a report is announced once');
  const other = '77777777-7777-4777-8777-777777777777';
  assert.deepEqual(arrivals.arrived([round([old, live]), round([report(issues)], other)]), [], 'an opened older round announces nothing');
  assert.deepEqual(arrivals.arrived([round([old, live, report(issues, { status: 'dispatch_started' })])]), [], 'an unfinished report is not announced');
});

test('storyboard frames are markable targets inside the strip only, and review labels sit inside the node footer', () => {
  const { doc, a, frameA } = boardScene();
  assert.deepEqual(markTargetElements({ kind: 'storyboard_shot', id: 'a' }, doc.dom), [frameA], 'the inspector copy is left alone');
  assert.deepEqual(markTargetElements({ kind: 'shot', id: 'a' }, doc.dom), [a]);
  const node = { left: 200, top: 200, right: 380, bottom: 360, width: 180, height: 160 }, size = { width: 52, height: 18 };
  assert.deepEqual(markLabelPosition('shot', node, size), { x: 316, y: 176 }, '"Mio 修改" stays above the corner');
  assert.deepEqual(markLabelPosition('shot', node, size, 'inside'), { x: 320, y: 336 });
  assert.deepEqual(reviewMarkTargets([shotA, shotB]).map(target => target.kind), ['shot', 'shot', 'storyboard_shot', 'storyboard_shot']);
});

test('review marks glow on canvas nodes and storyboard frames, with one label per issue on its first visible node', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { doc, a, b, frameA, frameB } = boardScene(), frames: Array<() => void> = [];
  const marks = createAgentReviewMarks({ document: doc.dom, afterLayout: callback => { frames.push(callback); } });
  const entry = { owner: 'review:x:0', category: 'wardrobe' as const, shotIds: ['a', 'b'] };
  marks.show([entry]);
  assert.equal(a.getAttribute(MARK_ATTRIBUTE), null, 'nothing is marked before the view has rendered');
  frames.shift()!();
  for (const element of [a, b, frameA, frameB]) assert.equal(element.getAttribute(MARK_ATTRIBUTE), 'shown');
  assert.deepEqual(marks.marks.list().filter(mark => mark.label).map(mark => mark.key), ['shot:a']);
  assert.equal(marks.category('review:x:0'), 'wardrobe');
  const placed = marks.marks.sync(() => ({ width: 52, height: 18 }));
  assert.deepEqual(placed, [{ key: 'shot:a', x: 320, y: 336, visible: true }]);
  marks.clear();
  assert.equal(a.getAttribute(MARK_ATTRIBUTE), null);
  marks.show([entry]); marks.clear(); frames.shift()!();
  assert.deepEqual(marks.marks.list(), [], 'a mode or project switch drops marks still waiting for layout');
  // Only frames visible: they glow, and no label is placed on the strip.
  const strip = createAgentReviewMarks({ document: doc.dom, afterLayout: callback => callback() });
  strip.locate({ owner: 'review:y:1', category: 'props', shotIds: ['missing', 'b'] });
  assert.deepEqual(strip.marks.list().map(mark => [mark.key, mark.label]), [['shot:b', true], ['storyboard_shot:b', false]]);
  const glowOnly = createTargetMarks({ document: doc.dom, labelKinds: new Set(['shot']) });
  glowOnly.mark([{ owner: 'o', targets: [{ kind: 'storyboard_shot', id: 'a' }] }]);
  assert.deepEqual(glowOnly.list().map(mark => mark.label), [false], 'a frame alone glows without a label');
  strip.reset(); assert.equal(strip.category('review:y:1'), undefined);
  marks.dispose(); strip.dispose(); glowOnly.dispose();
});

test('a clicked review label opens its issue card and highlights it for a moment', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const doc = new FakeDocument(), log = doc.element({ role: 'log' });
  const locate = doc.element({ class: 'mio-review-locate' }), card = doc.element({ 'data-review-owner': 'review:s:1' }).append(locate);
  log.append(doc.element({ 'data-review-owner': 'review:s:0' }), card);
  log.scrollHeight = 1000; log.clientHeight = 400; log.scrollTop = 600;
  const shown = revealReviewIssue(log as unknown as HTMLElement, 'review:s:1')!;
  assert.deepEqual(card.scrolls, [{ block: 'nearest' }]);
  assert.deepEqual(locate.focused, [{ preventScroll: true }]);
  assert.equal(card.getAttribute('data-revealed'), 'true');
  assert.equal(shown.following, true);
  t.mock.timers.tick(1600); assert.equal(card.getAttribute('data-revealed'), null);
  assert.equal(revealReviewIssue(log as unknown as HTMLElement, 'review:other:0'), null);
});

const project = (revision: number, notes?: string) => ({ id: projectId, name: '雨夜', revision, ...(notes === undefined ? {} : { notes }) });
function notesServer(start: { revision: number; notes: string }) {
  let state = { ...start };
  const calls: Array<[string, unknown]> = [], receipts = new Map<string, unknown>();
  const call: ProjectNotesCall & { fail?: unknown; edit(notes: string): void } = Object.assign(async (operation: string, input: unknown) => {
    calls.push([operation, input]);
    if (operation === 'project.get') return { project: project(state.revision, state.notes || undefined) };
    if (call.fail) { const error = call.fail; call.fail = undefined; throw error; }
    const value = input as { requestId: string; expectedRevision: number; notes: string };
    if (receipts.has(value.requestId)) return receipts.get(value.requestId);
    if (value.expectedRevision !== state.revision) throw new ApiError('conflict', 'REVISION_CONFLICT', undefined, true, 409);
    state = { revision: state.revision + 1, notes: value.notes.trim() ? value.notes : '' };
    const saved = project(state.revision, state.notes || undefined); receipts.set(value.requestId, saved); return saved;
  }, { edit(notes: string) { state = { revision: state.revision + 1, notes }; } }) as never;
  return { call, calls, state: () => state };
}

test('project notes save on their revision and are read back on a conflict', async () => {
  let ids = 0; const newRequestId = () => `8888888${ids++}-8888-4888-8888-888888888888`;
  const server = notesServer({ revision: 4, notes: '旧说明' }), base = { projectId, revision: 4, notes: '旧说明' };
  assert.deepEqual(await saveProjectNotes(server.call, { base, notes: '新说明', newRequestId }), { kind: 'saved', base: { projectId, revision: 5, notes: '新说明' } });
  // Another project edit (a rename, a shot change) moved the revision but left the notes alone: saved on the new one.
  const moved = notesServer({ revision: 7, notes: '旧说明' });
  assert.deepEqual(await saveProjectNotes(moved.call, { base, notes: '新说明', newRequestId }), { kind: 'saved', base: { projectId, revision: 8, notes: '新说明' } });
  assert.deepEqual(moved.calls.map(([operation]) => operation), ['project.notes.set', 'project.get', 'project.notes.set']);
  assert.notEqual((moved.calls[0]![1] as { requestId: string }).requestId, (moved.calls[2]![1] as { requestId: string }).requestId, 'a rebased save is a new request');
  // The notes themselves changed elsewhere: handed back, nothing overwritten.
  const changed = notesServer({ revision: 4, notes: '旧说明' }); changed.call.edit('Mio 改过的说明');
  assert.deepEqual(await saveProjectNotes(changed.call, { base, notes: '新说明', newRequestId }), { kind: 'conflict', latest: { projectId, revision: 5, notes: 'Mio 改过的说明' } });
  assert.equal(changed.state().notes, 'Mio 改过的说明');
  // No confirmed answer: the exact request is kept and replayed from the receipt.
  const flaky = notesServer({ revision: 4, notes: '旧说明' });
  flaky.call.fail = new TypeError('network');
  const unknown = await saveProjectNotes(flaky.call, { base, notes: '新说明', newRequestId });
  assert.equal(unknown.kind, 'unknown');
  const retained = unknown.kind === 'unknown' ? unknown.input : null;
  assert.deepEqual(await saveProjectNotes(flaky.call, { base, notes: '新说明', retained, newRequestId }), { kind: 'saved', base: { projectId, revision: 5, notes: '新说明' } });
  assert.deepEqual(await saveProjectNotes(flaky.call, { base, notes: '新说明', retained, newRequestId }), { kind: 'saved', base: { projectId, revision: 5, notes: '新说明' } }, 'a repeated retry replays and never saves twice');
  assert.equal(flaky.state().revision, 5);
  const rejected = notesServer({ revision: 4, notes: '' }); rejected.call.fail = new ApiError('bad', 'VALIDATION_ERROR', undefined, true, 400);
  assert.deepEqual(await saveProjectNotes(rejected.call, { base: { projectId, revision: 4, notes: '' }, notes: 'x', newRequestId }), { kind: 'rejected', code: 'VALIDATION_ERROR' });
  const cleared = notesServer({ revision: 4, notes: '旧说明' });
  assert.deepEqual(await saveProjectNotes(cleared.call, { base, notes: '  \n', newRequestId }), { kind: 'saved', base: { projectId, revision: 5, notes: '' } }, 'blank text clears the notes');
});

test('project notes accept plain text up to 8192 bytes', () => {
  assert.equal(projectNotesProblem('画幅与时长\n\t9:16'), null);
  assert.equal(projectNotesProblem('a'.repeat(8192)), null);
  assert.equal(projectNotesProblem('a'.repeat(8193)), 'tooLong');
  assert.equal(projectNotesProblem('雨'.repeat(2731)), 'tooLong', 'bytes, not characters, are counted');
  assert.equal(projectNotesProblem('bell\u0007'), 'invalid');
  assert.equal(projectNotesOf(project(1, '说明')), '说明');
  assert.equal(projectNotesOf({ notes: 3 }), '');
  assert.equal(projectNotesOf(null), '');
});

test('the project menu opens the notes between import and duplicate, and saves through project.notes.set', () => {
  const app = read('App.tsx'), dialog = read('ProjectNotesDialog.tsx');
  assert.match(app, /\{t\('projectPackage\.menu\.import'\)\}<\/DropdownMenuItem><DropdownMenuSeparator \/><DropdownMenuItem data-testid="project-menu-notes" disabled=\{Boolean\(application\) \|\| opacityRestored \|\| loading \|\| !data\.project\} onClick=\{\(\) => \{ setShowProjects\(false\); if \(data\.project\) setNotesOpen\(true\); \}\}><Icon name="note" size=\{15\} \/>\{t\('projectNotes\.menu'\)\}<\/DropdownMenuItem><DropdownMenuSeparator \/><DropdownMenuItem data-testid="project-menu-duplicate"/);
  assert.match(app, /<ProjectNotesDialog open=\{notesOpen && Boolean\(data\.project\)\}[^\n]*readOnly=\{restored\}/, 'a restored copy shows its notes read-only');
  assert.match(dialog, /saveProjectNotes\(call, \{ base, notes: retained\?\.notes \?\? draft, retained \}\)/);
  assert.match(dialog, /\{!readOnly && <Button variant="primary" data-testid="project-notes-save"/);
  assert.doesNotMatch(dialog, /<textarea|<button|<input/, 'shared controls only');
});

test('App wires review marks apart from the "Mio 修改" marks and clears them on project and mode switches', () => {
  const app = read('App.tsx'), workspace = read('AgentWorkspace.tsx'), panel = read('AgentTaskPanel.tsx');
  assert.match(app, /<TargetMarkLayer marks=\{changeMarks\.marks\} label=\{t\('agent\.mark\.label'\)\} ariaLabel=\{t\('agent\.mark\.open'\)\} onActivate=\{revealTaskChange\} \/>\n    <TargetMarkLayer marks=\{reviewMarks\.marks\} label=\{t\('agent\.review\.mark'\)\} icon="search" describe=/);
  assert.match(app, /onTaskReview=\{\(projectId, entries\) => \{ if \(currentProject\.current === projectId\) reviewMarks\.show\(entries\); \}\}/);
  assert.match(app, /useLayoutEffect\(\(\) => \{ reviewMarks\.reset\(\); setReviewReveal\(null\); setNotesOpen\(false\); \}, \[reviewMarks, data\.project\?\.id\]\);/);
  assert.match(app, /useLayoutEffect\(\(\) => \{ reviewMarks\.clear\(\); \}, \[reviewMarks, workspaceMode\]\);/);
  const locate = app.slice(app.indexOf('  async function locateReviewIssue('), app.indexOf('  useEffect(() => () => reviewMarks.reset()'));
  assert.match(locate, /if \(!await inspect\(first\)\) return;/, '"定位" selects the shot through the normal navigation guard');
  // A new selection remounts the canvas inside its editing boundary, which reopens on the saved viewport.
  assert.match(locate, /updateView\('canvas', \{ viewport \}\); void flow\.setViewport\(viewport\);/);
  assert.doesNotMatch(locate, /fitView\(/, 'a queued fit would be undone by the remount');
  assert.match(workspace, /shotNumber=\{shotNumber\} onReview=\{onTaskReview\} onReviewLocate=\{onTaskReviewLocate\} reviewReveal=\{reviewReveal\}/);
  // The report sits before the reply that followed it.
  assert.match(panel, /\{reviewCards\(reportedBefore\)\}\n        \{latest && <p className="agent-task-text mio-reply"/);
  assert.match(panel, /revealReviewIssue\(log\.current, reviewReveal\.owner\)/);
  assert.match(panel, /data-read=\{readIcon\(step\) \? 'true' : undefined\}/);
});
