import test from 'node:test';
import assert from 'node:assert/strict';
import { createTargetMarks, markLabelPosition, markableTargets, MARK_ATTRIBUTE, MARK_FADE_MS, MARK_RELEASE_MS, MARK_SHOWN_MS } from '../apps/web/src/target-marks.ts';
import { createAgentChangeMarks, locateAgentTaskChange, revealAgentTaskChangeRow } from '../apps/web/src/agent-task-location.ts';
import { createAgentTaskSession } from '../apps/web/src/agent-tasks-v2.ts';
import type { AgentTaskClient, AgentTaskPending, AgentTaskProjectSnapshot, AgentTaskReceiptStore } from '../apps/web/src/agent-tasks-v2.ts';
import type { AgentTaskChange, AgentTaskEvent, AgentTaskSnapshot } from '../packages/contracts/src/agent-tasks-v2.ts';
import { DEFAULT_AGENT_TASK_POLICY } from '../packages/contracts/src/agent-tasks-v2.ts';
import { LOCALES, translate } from '../packages/i18n/src/index.ts';

// A minimal DOM: attribute and class selectors (with ',' and '>'), layout boxes, a paint order for hit tests.
interface Rect { left: number; top: number; width: number; height: number }
class FakeElement {
  readonly attributes = new Map<string, string>();
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  rect: Rect = { left: 0, top: 0, width: 0, height: 0 };
  z = 0;
  scrolls: unknown[] = [];
  focused: unknown[] = [];
  scrollTop = 0; scrollHeight = 0; clientHeight = 0;
  readonly owner: FakeDocument;
  constructor(owner: FakeDocument, attributes: Record<string, string> = {}) { this.owner = owner; for (const [name, value] of Object.entries(attributes)) this.attributes.set(name, value); }
  get ownerDocument(): FakeDocument { return this.owner; }
  getClientRects(): Rect[] { return this.rect.width > 0 && this.rect.height > 0 ? [this.rect] : []; }
  get isConnected(): boolean { for (let node: FakeElement | null = this; node; node = node.parent) if (node === this.owner.root) return true; return false; }
  append(...children: FakeElement[]): this { for (const child of children) { child.parent = this; this.children.push(child); } return this; }
  remove(): void { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
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
const paintLayer = (element: FakeElement): number => { let z = 0; for (let node: FakeElement | null = element; node; node = node.parent) z = Math.max(z, node.z); return z; };
class FakeDocument {
  readonly root: FakeElement;
  reducedMotion = false;
  readonly defaultView = { innerWidth: 1440, innerHeight: 900, matchMedia: (query: string) => ({ matches: this.reducedMotion && query.includes('reduce') }) };
  constructor() { this.root = new FakeElement(this); }
  element(attributes: Record<string, string>, rect?: Rect, z = 0): FakeElement { const element = new FakeElement(this, attributes); if (rect) element.rect = rect; element.z = z; return element; }
  querySelectorAll(selector: string): FakeElement[] { return this.root.querySelectorAll(selector); }
  elementsFromPoint(x: number, y: number): FakeElement[] {
    return descendants(this.root).map((element, order) => ({ element, order, z: paintLayer(element) }))
      .filter(({ element: { rect } }) => rect.width > 0 && rect.height > 0 && x >= rect.left && x < rect.left + rect.width && y >= rect.top && y < rect.top + rect.height)
      .filter(({ element }) => !element.closest('[hidden]'))
      .sort((a, b) => b.z - a.z || b.order - a.order).map(({ element }) => element);
  }
  get dom(): Document { return this as unknown as Document; }
}
const rect = (left: number, top: number, width: number, height: number): Rect => ({ left, top, width, height });

function canvasScene() {
  const doc = new FakeDocument();
  const flow = doc.element({ class: 'react-flow' }, rect(0, 44, 1440, 856));
  const shot = (id: string, box: Rect, attributes: Record<string, string> = {}) => { const node = doc.element({ class: 'canvas-node shot-node', 'data-testid': `shot-node-${id}` }, box); flow.append(doc.element({ class: 'react-flow__node', ...attributes }, box).append(node)); return node; };
  const visible = shot('visible', rect(520, 400, 240, 200));
  const away = shot('away', rect(1500, 400, 240, 200));
  const covered = shot('covered', rect(1150, 400, 240, 200));
  const edge = shot('edge', rect(1000, 640, 240, 200));
  const hidden = shot('hidden', rect(200, 120, 240, 200), { hidden: '' });
  const dock = doc.element({ id: 'dock-inspector', 'data-visible': 'true' }, rect(1120, 44, 320, 856), 10);
  doc.root.append(flow, dock);
  return { doc, visible, away, covered, edge, hidden };
}
function timelineScene() {
  const doc = new FakeDocument();
  const scroll = doc.element({ 'data-testid': 'timeline-scroll' }, rect(0, 596, 1440, 280));
  const header = doc.element({ class: 'track-label' }, rect(0, 620, 160, 52), 5);
  const lane = doc.element({ class: 'track-lane' }, rect(160, 620, 1280, 52));
  const clip = (id: string, left: number, width: number) => { const element = doc.element({ class: 'timeline-clip video', 'data-testid': `timeline-clip-${id}` }, rect(left, 624, width, 44)); lane.append(element); return element; };
  const a = clip('a', 400, 290), b = clip('b', 700, 300), c = clip('c', 1010, 260), under = clip('under', 60, 150);
  scroll.append(doc.element({ class: 'timeline-ruler-row' }, rect(0, 596, 1440, 24), 7), doc.element({ class: 'timeline-track video', 'data-testid': 'timeline-track-t1' }, rect(0, 620, 1440, 52)).append(header, lane));
  doc.root.append(doc.element({ 'data-testid': 'timeline-panel' }, rect(0, 560, 1440, 340)).append(scroll));
  return { doc, header, a, b, c, under };
}

const projectId = '11111111-1111-4111-8111-111111111111', runId = '22222222-2222-4222-8222-222222222222', stepId = '33333333-3333-4333-8333-333333333333', time = '2026-10-24T00:00:00.000Z';
const change = (targets: AgentTaskChange['targets'], patch: Partial<AgentTaskChange> = {}): AgentTaskChange => ({ id: crypto.randomUUID(), runId, stepId, projectId, operation: 'timeline.clip.update', targets, before: null, after: null, reversible: true, status: 'applied', createdAt: time, ...patch });
const target = (kind: string, id: string) => ({ kind, id, revision: 1 });
const snapshot = (changes: AgentTaskChange[], revision = 1, status: AgentTaskSnapshot['run']['status'] = 'running'): AgentTaskSnapshot => ({ run: { id: runId, projectId, conversationId: runId, requestId: '44444444-4444-4444-8444-444444444444', text: 'synthetic round', status, revision, stepLimit: 30, budget: 30, stepsUsed: 1, configuration: {}, createdAt: time, updatedAt: time }, steps: [], changes });
const nowFrames = (callback: () => void): void => callback();
const marked = (doc: FakeDocument) => descendants(doc.root).filter(element => element.hasAttribute(MARK_ATTRIBUTE));

test('a newly saved change marks its visible clip once, with one label, and fades after about four seconds', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { doc, header, a } = timelineScene(), frames: Array<() => void> = [];
  const marks = createAgentChangeMarks({ document: doc.dom, afterLayout: callback => { frames.push(callback); } });
  const edit = change([target('timeline_clip', 'a'), target('timeline_track', 't1')]), current = snapshot([edit]);
  const fresh = marks.accept(current, [edit.id]);
  assert.deepEqual(fresh.map(item => item.id), [edit.id]);
  marks.show(fresh);
  assert.equal(a.getAttribute(MARK_ATTRIBUTE), null, 'nothing is marked before the refreshed view has rendered');
  frames.shift()!();
  assert.equal(a.getAttribute(MARK_ATTRIBUTE), 'shown');
  assert.equal(header.getAttribute(MARK_ATTRIBUTE), null, 'the clip edit does not light up its whole track');
  assert.deepEqual(marks.marks.list().map(mark => [mark.key, mark.owner, mark.label]), [['timeline_clip:a', edit.id, true]]);
  assert.deepEqual(marks.accept(current, [edit.id]), [], 'the same change is never marked a second time');
  t.mock.timers.tick(MARK_SHOWN_MS - 1); assert.equal(a.getAttribute(MARK_ATTRIBUTE), 'shown');
  t.mock.timers.tick(1); assert.equal(a.getAttribute(MARK_ATTRIBUTE), 'fading'); assert.equal(marks.marks.list()[0]?.phase, 'fading');
  t.mock.timers.tick(MARK_FADE_MS); assert.equal(a.getAttribute(MARK_ATTRIBUTE), null); assert.deepEqual(marks.marks.list(), []);
  assert.equal(MARK_SHOWN_MS, 4000);
});

test('a Mio session reports only changes saved while their round is on screen', async () => {
  const old = change([target('timeline_clip', 'a')]);
  const receipts = new Map<string, AgentTaskPending>();
  const store: AgentTaskReceiptStore = { read: id => receipts.get(id) ?? null, write(id, value) { if (value) receipts.set(id, value); else receipts.delete(id); } };
  const project: AgentTaskProjectSnapshot = { version: 2, instanceId: '55555555-5555-4555-8555-555555555555', projectId, runs: [snapshot([old]).run], policy: structuredClone(DEFAULT_AGENT_TASK_POLICY), authorization: { revision: 1, scopes: ['project_agent'] }, settings: { revision: 0, configuration: { presetId: 'openai', platformId: 'global', baseUrl: 'https://example.invalid/v1', model: 'synthetic', protocol: 'responses' }, secret: { configured: false, storage: 'none' }, storage: { persistentAvailable: false, sessionScope: 'server', reasonCode: null }, presets: [], scope: 'settings_only', verification: 'not_tested' } } as unknown as AgentTaskProjectSnapshot;
  const streams: Array<(event: AgentTaskEvent) => void> = [], reports: Array<[number, string[]]> = [];
  const client = {
    list: async () => project, read: async () => snapshot([old]), history: async () => ({ conversations: [], nextCursor: null }),
    conversation: async () => ({ conversation: { id: runId, projectId, title: 'synthetic round', createdAt: time, updatedAt: time, lastRunId: runId, lastRunStatus: 'running', changeCount: 1, runCount: 1 }, runs: [snapshot([old]).run], nextCursor: null }),
    stream: async (_project: string, _run: string, _after: number, signal: AbortSignal, onEvent: (event: AgentTaskEvent) => void) => { streams.push(onEvent); return new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); },
  } as unknown as AgentTaskClient;
  const session = createAgentTaskSession({ projectId, client, receipts: store, onChangeApplied: (next, landed) => { reports.push([next.run.revision, [...landed]]); } });
  try {
    await session.load();
    assert.equal(session.getState().rounds.length, 1);
    assert.ok(reports.every(([, landed]) => landed.length === 0), 'opening a conversation announces none of its saved changes');
    const emit = (revision: number, changes: AgentTaskChange[]) => streams[0]!({ runId, sequence: revision, type: 'snapshot', createdAt: time, data: snapshot(changes, revision) as unknown as AgentTaskEvent['data'] });
    const fresh = change([target('timeline_clip', 'b')]);
    emit(2, [old, fresh]);
    assert.deepEqual(reports.at(-1), [2, [fresh.id]]);
    emit(3, [{ ...old, status: 'reverted', revertedAt: time }, fresh]);
    assert.deepEqual(reports.at(-1), [3, []], 'an undo reverts an old change; nothing new landed');
    emit(4, [{ ...old, status: 'reverted', revertedAt: time }, fresh, change([target('timeline_clip', 'c')], { status: 'superseded' }), change([target('timeline_clip', 'c')], { status: 'reverted', revertedAt: time })]);
    assert.deepEqual(reports.at(-1), [4, []], 'superseded and already undone changes are not new Mio edits on screen');
    emit(5, [{ ...old, status: 'reverted', revertedAt: time }, { ...fresh, modifiedAfter: true }]);
    assert.deepEqual(reports.at(-1), [5, []], 'the user editing a target afterwards reports no Mio change');
  } finally { session.dispose(); }
});

test('undone, superseded and since-edited changes never mark, and an active mark ends when its change is undone', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { doc, a, b } = timelineScene(), marks = createAgentChangeMarks({ document: doc.dom, afterLayout: nowFrames });
  const edit = change([target('timeline_clip', 'a')]);
  marks.show(marks.accept(snapshot([edit]), [edit.id]));
  assert.equal(a.getAttribute(MARK_ATTRIBUTE), 'shown');
  const later = [change([target('timeline_clip', 'b')], { status: 'reverted', revertedAt: time }), change([target('timeline_clip', 'b')], { status: 'superseded' }), change([target('timeline_clip', 'b')], { modifiedAfter: true })];
  marks.show(marks.accept(snapshot([{ ...edit, status: 'reverted', revertedAt: time }, ...later], 2), later.map(item => item.id)));
  assert.equal(a.getAttribute(MARK_ATTRIBUTE), null, 'undoing the change removes its mark at once');
  assert.equal(b.getAttribute(MARK_ATTRIBUTE), null);
  assert.deepEqual(marks.marks.list(), []);
});

test('targets scrolled away, covered by a panel or in a hidden pane are not marked, and marking never scrolls', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const scene = canvasScene(), marks = createAgentChangeMarks({ document: scene.doc.dom, afterLayout: nowFrames });
  const edits = ['visible', 'away', 'covered', 'hidden'].map(id => change([target('shot', id)], { operation: 'shot.update' }));
  marks.show(marks.accept(snapshot(edits), edits.map(item => item.id)));
  assert.deepEqual(marked(scene.doc), [scene.visible]);
  for (const element of [scene.visible, scene.away, scene.covered, scene.hidden]) assert.deepEqual(element.scrolls, []);
  const timeline = timelineScene(), timelineMarks = createAgentChangeMarks({ document: timeline.doc.dom, afterLayout: nowFrames });
  const under = change([target('timeline_clip', 'under')]);
  timelineMarks.show(timelineMarks.accept(snapshot([under]), [under.id]));
  assert.equal(timeline.under.getAttribute(MARK_ATTRIBUTE), 'shown', 'a clip still partly visible beside the sticky header is marked');
  timeline.under.rect = rect(10, 624, 140, 44);
  const hiddenUnder = change([target('timeline_clip', 'under')]);
  timelineMarks.clear();
  timelineMarks.show(timelineMarks.accept(snapshot([hiddenUnder]), [hiddenUnder.id]));
  assert.equal(timeline.under.getAttribute(MARK_ATTRIBUTE), null, 'a clip entirely under the sticky track header is not visible');
});

test('the same target changed again restarts its timer and keeps a single label; a multi-target change labels one', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { doc, a, b, c } = timelineScene(), marks = createAgentChangeMarks({ document: doc.dom, afterLayout: nowFrames });
  const first = change([target('timeline_clip', 'a')]), second = change([target('timeline_clip', 'a')]);
  marks.show(marks.accept(snapshot([first]), [first.id]));
  t.mock.timers.tick(3000);
  marks.show(marks.accept(snapshot([first, second], 2), [second.id]));
  t.mock.timers.tick(3000);
  assert.equal(a.getAttribute(MARK_ATTRIBUTE), 'shown', 'the second change restarted the four seconds');
  assert.deepEqual(marks.marks.list().map(mark => [mark.key, mark.owner, mark.label]), [['timeline_clip:a', second.id, true]]);
  t.mock.timers.tick(1000); assert.equal(a.getAttribute(MARK_ATTRIBUTE), 'fading');
  const moved = change([target('timeline_clip', 'b'), target('timeline_clip', 'c'), target('timeline_track', 't1')], { operation: 'timeline.clip.rippleRemove' });
  marks.show(marks.accept(snapshot([first, second, moved], 3), [moved.id]));
  assert.equal(b.getAttribute(MARK_ATTRIBUTE), 'shown'); assert.equal(c.getAttribute(MARK_ATTRIBUTE), 'shown');
  assert.deepEqual(marks.marks.list().filter(mark => mark.owner === moved.id).map(mark => [mark.key, mark.label]), [['timeline_clip:b', true], ['timeline_clip:c', false]]);
  assert.deepEqual(markableTargets([target('timeline_track', 't1'), target('lut', 'x')]).map(item => item.kind), ['timeline_track'], 'a track change alone marks its header');
});

test('a project switch, a mode switch or unmounting ends marks, timers and pending marks', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { doc, a, b } = timelineScene(), frames: Array<() => void> = [];
  const marks = createAgentChangeMarks({ document: doc.dom, afterLayout: callback => { frames.push(callback); } });
  const edit = change([target('timeline_clip', 'a')]), pending = change([target('timeline_clip', 'b')]);
  marks.show(marks.accept(snapshot([edit]), [edit.id])); frames.shift()!();
  marks.show(marks.accept(snapshot([edit, pending], 2), [pending.id]));
  marks.clear();
  frames.shift()!();
  assert.deepEqual(marked(doc), [], 'a mode switch drops marks and the refresh that was still pending');
  assert.deepEqual(marks.accept(snapshot([edit, pending], 2), [pending.id]), [], 'a mode switch keeps the record of announced changes');
  marks.reset();
  assert.equal(marks.accept(snapshot([edit, pending], 2), [pending.id]).length, 1, 'another project starts with a fresh record');
  marks.show([pending]); frames.shift()!(); assert.equal(b.getAttribute(MARK_ATTRIBUTE), 'shown');
  marks.dispose(); assert.deepEqual(marked(doc), []);
  t.mock.timers.tick(MARK_SHOWN_MS + MARK_FADE_MS);
  assert.equal(a.getAttribute(MARK_ATTRIBUTE), null);
  assert.deepEqual(marks.marks.mark([{ owner: edit.id, targets: edit.targets }]), [], 'a disposed controller marks nothing');
});

test('hovering or focusing a label holds its mark; leaving lets it fade', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { doc, a } = timelineScene(), marks = createTargetMarks({ document: doc.dom });
  marks.mark([{ owner: 'change', targets: [{ kind: 'timeline_clip', id: 'a' }] }]);
  marks.hold('timeline_clip:a', true);
  t.mock.timers.tick(MARK_SHOWN_MS * 3);
  assert.equal(a.getAttribute(MARK_ATTRIBUTE), 'shown');
  marks.hold('timeline_clip:a', false);
  t.mock.timers.tick(MARK_RELEASE_MS - 1); assert.equal(a.getAttribute(MARK_ATTRIBUTE), 'shown');
  t.mock.timers.tick(1); assert.equal(a.getAttribute(MARK_ATTRIBUTE), 'fading');
  marks.hold('timeline_clip:a', true); assert.equal(a.getAttribute(MARK_ATTRIBUTE), 'shown', 'pointing at a fading label brings it back');
  marks.dispose();
});

test('labels sit above a canvas node and inside a clip, and hide over panels and sticky headers', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const size = { width: 66, height: 18 };
  const canvas = canvasScene(), canvasMarks = createTargetMarks({ document: canvas.doc.dom });
  canvasMarks.mark([{ owner: 'visible', targets: [{ kind: 'shot', id: 'visible' }] }, { owner: 'edge', targets: [{ kind: 'shot', id: 'edge' }] }]);
  const placed = Object.fromEntries(canvasMarks.sync(() => size).map(item => [item.key, item]));
  assert.deepEqual(placed['shot:visible'], { key: 'shot:visible', x: 760 - 12 - 66, y: 400 - 6 - 18, visible: true });
  assert.deepEqual(placed['shot:edge'], { key: 'shot:edge', x: 1120 - 12 - 66, y: 640 - 6 - 18, visible: true }, 'a node partly under the docked panel keeps its label beside the panel');
  canvas.edge.rect = rect(1080, 640, 240, 200); canvas.edge.parent!.rect = canvas.edge.rect;
  assert.equal(canvasMarks.sync(() => size).find(item => item.key === 'shot:edge')?.visible, false, 'a sliver too narrow for the label leaves it at the node, under the panel and hidden');
  canvas.visible.rect = rect(-400, 400, 240, 200);
  assert.equal(canvasMarks.sync(() => size).find(item => item.key === 'shot:visible')?.visible, false, 'panning the node away hides its label');
  const timeline = timelineScene(), timelineMarks = createTargetMarks({ document: timeline.doc.dom });
  timelineMarks.mark([{ owner: 'a', targets: [{ kind: 'timeline_clip', id: 'a' }] }]);
  assert.deepEqual(timelineMarks.sync(() => size)[0], { key: 'timeline_clip:a', x: 690 - 20 - 66, y: 668 - 4 - 18, visible: true });
  timeline.a.rect = rect(40, 624, 200, 44);
  assert.deepEqual(timelineMarks.sync(() => size)[0], { key: 'timeline_clip:a', x: 160 + (80 - 66) / 2, y: 646, visible: true }, 'a clip half under the sticky header labels its visible part');
  timeline.a.rect = rect(40, 624, 130, 44);
  assert.equal(timelineMarks.sync(() => size)[0]?.visible, false, 'a label that would sit on the sticky track header is hidden');
  timeline.a.rect = rect(1200, 624, 500, 44);
  assert.deepEqual(timelineMarks.sync(() => size)[0], { key: 'timeline_clip:a', x: 1440 - 20 - 66, y: 646, visible: true }, 'a long clip running past the window keeps its label on screen');
  timeline.a.rect = rect(400, 624, 290, 44);
  assert.deepEqual(markLabelPosition('timeline_clip', { left: 100, top: 10, right: 150, bottom: 54, width: 50, height: 44 }, size), { x: 100 + (50 - 66) / 2, y: 54 - 4 - 18 }, 'a narrow clip keeps its label centred');
  assert.deepEqual(markLabelPosition('timeline_track', { left: 0, top: 620, right: 160, bottom: 672, width: 160, height: 52 }, size), { x: 166, y: 637 });
  // React replaced the clip element: the glow moves to the live element.
  const replacement = timeline.doc.element({ class: 'timeline-clip video', 'data-testid': 'timeline-clip-a' }, rect(400, 624, 290, 44));
  const lane = timeline.a.parent!; timeline.a.remove(); lane.append(replacement);
  timelineMarks.sync(() => size);
  assert.equal(replacement.getAttribute(MARK_ATTRIBUTE), 'shown');
  canvasMarks.dispose(); timelineMarks.dispose();
});

test('locating a change marks it right away; only timeline targets are scrolled, without motion when reduced', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const canvas = canvasScene(), canvasMarks = createAgentChangeMarks({ document: canvas.doc.dom, afterLayout: nowFrames });
  const shot = change([target('shot', 'away')], { operation: 'shot.update' });
  locateAgentTaskChange(shot, canvasMarks, canvas.doc.dom);
  assert.deepEqual(canvas.away.scrolls, [], 'the caller frames canvas nodes with fitView');
  assert.equal(canvas.away.getAttribute(MARK_ATTRIBUTE), 'shown', 'the located node is marked while fitView brings it into view');
  const timeline = timelineScene(), marks = createAgentChangeMarks({ document: timeline.doc.dom, afterLayout: nowFrames });
  const clip = change([target('timeline_clip', 'c'), target('timeline_track', 't1')]);
  locateAgentTaskChange(clip, marks, timeline.doc.dom);
  assert.deepEqual(timeline.c.scrolls, [{ behavior: 'smooth', block: 'nearest', inline: 'center' }]);
  assert.equal(timeline.header.getAttribute(MARK_ATTRIBUTE), null);
  timeline.doc.reducedMotion = true;
  locateAgentTaskChange(clip, marks, timeline.doc.dom);
  assert.deepEqual(timeline.c.scrolls.at(-1), { behavior: 'auto', block: 'nearest', inline: 'center' });
  assert.equal(marks.marks.list().length, 1, 'locating twice keeps one mark');
  canvasMarks.dispose(); marks.dispose();
});

test('a clicked label opens its change row: scrolled into view, focused and highlighted briefly', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const doc = new FakeDocument(), log = doc.element({ class: 'mio-log' });
  const row = (id: string) => doc.element({ class: 'mio-change', 'data-change-id': id }).append(doc.element({ class: 'mio-change-locate' }));
  const first = row('first'), second = row('second');
  doc.root.append(log.append(first, second));
  Object.assign(log, { scrollHeight: 900, clientHeight: 300, scrollTop: 200 });
  const shown = revealAgentTaskChangeRow(log as unknown as HTMLElement, 'second');
  assert.ok(shown);
  assert.deepEqual(second.scrolls, [{ block: 'nearest' }]);
  assert.deepEqual(second.querySelector('.mio-change-locate')?.focused, [{ preventScroll: true }]);
  assert.equal(second.getAttribute('data-revealed'), 'true');
  assert.equal(first.getAttribute('data-revealed'), null);
  assert.equal(shown.following, false, 'the log stops following the latest round while an older row is shown');
  t.mock.timers.tick(1600); assert.equal(second.getAttribute('data-revealed'), null);
  assert.equal(revealAgentTaskChangeRow(log as unknown as HTMLElement, 'other-conversation'), null);
});

test('the mark label is localized and keeps the Latin Mio name', () => {
  assert.deepEqual(LOCALES.map(locale => translate(locale, 'agent.mark.label')), ['Mio 修改', 'Mio 修改', 'Edited by Mio', 'Mio が変更']);
  for (const locale of LOCALES) assert.ok(translate(locale, 'agent.mark.open').startsWith(translate(locale, 'agent.mark.label')), `${locale}: the accessible name starts with the visible label`);
});
