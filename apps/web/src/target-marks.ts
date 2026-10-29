// Short-lived marks on canvas and timeline targets: a soft glow on the target
// element itself and, optionally, a clickable label in a floating layer. The
// caller names the label (Mio's "Mio 修改"; C6's "待核对"). A mark never
// selects, scrolls or switches modes; locating a target is the caller's job.
import { coveredInsets, measuredOverlays } from './canvas-fit.ts';

export interface MarkTarget { kind: string; id: string }
export type MarkPhase = 'shown' | 'fading';
export interface TargetMark { key: string; target: MarkTarget; owner: string; label: boolean; phase: MarkPhase; held: boolean }
export interface MarkEntry { owner: string; targets: readonly MarkTarget[] }
export interface MarkSize { width: number; height: number }
export interface MarkPlacement { key: string; x: number; y: number; visible: boolean }
export interface MarkBox { left: number; top: number; right: number; bottom: number; width: number; height: number }

export const MARK_ATTRIBUTE = 'data-mio-mark';
export const MARK_LAYER_ATTRIBUTE = 'data-mio-mark-layer';
export const MARK_SHOWN_MS = 4000;
export const MARK_FADE_MS = 400;
// After the pointer or focus leaves a held label, it stays this long before fading.
export const MARK_RELEASE_MS = 1500;

const CANVAS = '.react-flow', TIMELINE = '[data-testid="timeline-scroll"]', STORYBOARD = '[data-testid="storyboard"]';
// The nearest scroll area of a target: a storyboard frame floats over the canvas in its own scrolling strip.
const AREAS = `${STORYBOARD}, ${CANVAS}, ${TIMELINE}`;
// Sticky timeline headers scroll over the lanes; a label never sits on them.
const STICKY = '.track-label, .timeline-ruler-row';
const SPECIFIC = new Set(['shot', 'node', 'storyboard_shot', 'timeline_clip', 'timeline_subtitle']);
const canvasKind = (kind: string): boolean => kind === 'shot' || kind === 'node';
const escapeId = (id: string): string => typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(id) : id.replace(/[^A-Za-z0-9_-]/gu, '');

function selectors(target: MarkTarget): string[] {
  const id = escapeId(target.id);
  switch (target.kind) {
    case 'shot': return [`[data-testid="shot-node-${id}"]`];
    case 'node': return [`[data-testid="asset-node-${id}"]`, `[data-testid="text-node-${id}"]`, `[data-testid="previs-node-${id}"]`];
    // A shot's frame in the storyboard strip; the thumbnail carries the glow, not its title and buttons.
    case 'storyboard_shot': return [`[data-testid="storyboard-shot-${id}"] > .storyboard-preview`];
    case 'timeline_clip': return [`[data-testid="timeline-clip-${id}"]`];
    case 'timeline_subtitle': return [`[data-testid="subtitle-cue-${id}"]`];
    // A whole row would glow across the timeline; its header stands for the track.
    case 'timeline_track': return [`[data-testid="timeline-track-${id}"] > .track-label`];
    default: return [];
  }
}

/** Elements that show a target on the canvas, storyboard or timeline; copies elsewhere (inspector, lists) are left alone. */
export function markTargetElements(target: MarkTarget, document: Document): Element[] {
  const container = canvasKind(target.kind) ? CANVAS : target.kind === 'storyboard_shot' ? STORYBOARD : TIMELINE;
  return selectors(target).flatMap(selector => [...document.querySelectorAll(selector)]).filter(element => element.closest(container) !== null);
}

/** The most specific targets: a clip edit also names its track, which must not light up the whole row. */
export function markableTargets(targets: readonly MarkTarget[]): MarkTarget[] {
  const specific = targets.filter(target => SPECIFIC.has(target.kind));
  const chosen = specific.length ? specific : targets.filter(target => target.kind === 'timeline_track');
  const seen = new Set<string>();
  return chosen.filter(target => { const key = `${target.kind}:${target.id}`; if (seen.has(key)) return false; seen.add(key); return true; });
}

function box(left: number, top: number, width: number, height: number): MarkBox { return { left, top, right: left + width, bottom: top + height, width, height }; }
function intersect(a: MarkBox, b: MarkBox): MarkBox | null {
  const left = Math.max(a.left, b.left), top = Math.max(a.top, b.top), right = Math.min(a.right, b.right), bottom = Math.min(a.bottom, b.bottom);
  return right - left >= 1 && bottom - top >= 1 ? box(left, top, right - left, bottom - top) : null;
}
/** The topmost element at a point, skipping the mark layer itself; null outside the window. */
function topElement(document: Document, x: number, y: number): Element | null {
  const view = document.defaultView;
  if (view && (x < 0 || y < 0 || x >= view.innerWidth || y >= view.innerHeight)) return null;
  for (const element of document.elementsFromPoint(x, y)) if (!element.closest(`[${MARK_LAYER_ATTRIBUTE}]`)) return element;
  return null;
}
const inner = (area: MarkBox): Array<[number, number]> => ([[0.5, 0.5], [0.15, 0.5], [0.85, 0.5], [0.5, 0.15], [0.5, 0.85]] as const).map(([x, y]) => [area.left + area.width * x, area.top + area.height * y]);
const corners = (area: MarkBox): Array<[number, number]> => [[area.left + 1, area.top + 1], [area.right - 1, area.top + 1], [area.left + 1, area.bottom - 1], [area.right - 1, area.bottom - 1], [area.left + area.width / 2, area.top + area.height / 2]];

/**
 * Visible means part of the element lies inside its canvas or timeline scroll area and is the topmost thing
 * there: not scrolled away, not hidden and not covered by a floating panel, sticky header or dialog.
 */
export function markTargetVisible(element: Element, document: Document): boolean {
  if (!element.isConnected || element.closest('[hidden], [inert]')) return false;
  const container = element.closest(AREAS);
  const area = container ? intersect(element.getBoundingClientRect(), container.getBoundingClientRect()) : null;
  return Boolean(area && inner(area).some(([x, y]) => { const hit = topElement(document, x, y); return hit !== null && (hit === element || element.contains(hit)); }));
}

/**
 * Where a label sits on a canvas node: above its top-right corner ("Mio 修改"), or inside its bottom-right corner
 * over the footer ("待核对", 09-09).
 */
export type MarkLabelPlacement = 'above' | 'inside';
/** Label position from the design: on a canvas node by placement; inside a clip's bottom-right corner. */
export function markLabelPosition(kind: string, target: MarkBox, size: MarkSize, placement: MarkLabelPlacement = 'above'): { x: number; y: number } {
  if (canvasKind(kind)) return placement === 'inside' ? { x: target.right - 8 - size.width, y: target.bottom - 6 - size.height } : { x: target.right - 12 - size.width, y: target.top - 6 - size.height };
  if (kind === 'timeline_track') return { x: target.right + 6, y: target.top + (target.height - size.height) / 2 };
  // A clip too narrow for the label keeps it centred over the clip instead of spilling to one side.
  const x = target.width >= size.width + 40 ? target.right - 20 - size.width : target.left + (target.width - size.width) / 2;
  return { x, y: target.bottom - 4 - size.height };
}

/** A label shows only while all of it lies over its own canvas or timeline, never over panels or sticky headers. */
function labelVisible(element: Element, label: MarkBox, document: Document): boolean {
  if (!markTargetVisible(element, document)) return false;
  const container = element.closest(AREAS);
  return Boolean(container && corners(label).every(([x, y]) => { const hit = topElement(document, x, y); return hit !== null && container.contains(hit) && hit.closest(STICKY) === null; }));
}

/**
 * The part of a target's scroll area that is really on view: a timeline without its sticky track headers and
 * ruler; a full-bleed canvas without the docks, toolbar and storyboard floating over it.
 */
function visibleArea(element: Element): MarkBox | null {
  const container = element.closest(AREAS);
  if (!container) return null;
  const pane = container.getBoundingClientRect();
  let { left, top, right, bottom } = pane;
  if (container.matches(TIMELINE)) {
    const header = [...container.querySelectorAll('.track-label')].map(node => node.getBoundingClientRect()).find(rect => rect.width > 0 && rect.height > 0);
    const ruler = container.querySelector('.timeline-ruler-row')?.getBoundingClientRect();
    if (header) left = Math.max(left, header.right);
    if (ruler && ruler.height > 0) top = Math.max(top, ruler.bottom);
  } else if (container.matches(CANVAS)) {
    const inset = coveredInsets(pane, measuredOverlays(container));
    left += Math.max(0, inset.left); right -= Math.max(0, inset.right); top += Math.max(0, inset.top); bottom -= Math.max(0, inset.bottom);
  }
  return right - left >= 1 && bottom - top >= 1 ? box(left, top, right - left, bottom - top) : null;
}
/** Where a label anchors: the visible part of a long clip, or of a node partly under a panel, so it stays reachable. */
function labelAnchor(kind: string, target: MarkBox, area: MarkBox | null, size: MarkSize): MarkBox {
  const seen = area && kind !== 'timeline_track' ? intersect(target, area) : null;
  if (!seen) return target;
  // A sliver of a node too narrow for the label keeps the label at the node itself (and hidden by the panel).
  if (canvasKind(kind)) return seen.width >= size.width + 12 ? box(seen.left, target.top, seen.width, target.height) : target;
  return seen;
}

export interface TargetMarksOptions {
  document?: Document;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  shownMs?: number;
  fadeMs?: number;
  releaseMs?: number;
  /** Where labels sit on canvas nodes; above them unless a caller asks otherwise. */
  placement?: MarkLabelPlacement;
  /** Target kinds that may carry an entry's label; any kind when omitted. Other targets only glow. */
  labelKinds?: ReadonlySet<string>;
}
export interface TargetMarks {
  /** Marks each entry's targets; the first marked target of an entry carries the label. Returns the owners marked. */
  mark(entries: readonly MarkEntry[], options?: { requireVisible?: boolean }): string[];
  /** Removes the marks of these owners at once, without fading (for example after an undo). */
  release(owners: Iterable<string>): void;
  /** Keeps a mark while its label is hovered or focused. */
  hold(key: string, held: boolean): void;
  clear(): void;
  list(): readonly TargetMark[];
  /** Keeps the glow on the live elements and returns label positions; call once per animation frame. */
  sync(measure: (key: string) => MarkSize | null): MarkPlacement[];
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

export function createTargetMarks(options: TargetMarksOptions = {}): TargetMarks {
  const document = options.document ?? globalThis.document;
  const setTimer = options.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const shownMs = options.shownMs ?? MARK_SHOWN_MS, fadeMs = options.fadeMs ?? MARK_FADE_MS, releaseMs = options.releaseMs ?? MARK_RELEASE_MS;
  const placement = options.placement ?? 'above', labelKinds = options.labelKinds;
  interface Entry extends TargetMark { timer: unknown; elements: Element[] }
  const marks = new Map<string, Entry>(), listeners = new Set<() => void>();
  let snapshot: readonly TargetMark[] = [], disposed = false;

  const publish = () => {
    snapshot = [...marks.values()].map(({ key, target, owner, label, phase, held }) => ({ key, target, owner, label, phase, held }));
    for (const listener of [...listeners]) listener();
  };
  const paint = (entry: Entry) => { for (const element of entry.elements) if (element.getAttribute(MARK_ATTRIBUTE) !== entry.phase) element.setAttribute(MARK_ATTRIBUTE, entry.phase); };
  const unpaint = (entry: Entry) => { for (const element of entry.elements) if (element.hasAttribute(MARK_ATTRIBUTE)) element.removeAttribute(MARK_ATTRIBUTE); };
  const stop = (entry: Entry) => { if (entry.timer !== undefined) clearTimer(entry.timer); entry.timer = undefined; };
  const remove = (entry: Entry) => { stop(entry); unpaint(entry); marks.delete(entry.key); };
  function fadeAfter(entry: Entry, delay: number) {
    stop(entry);
    entry.timer = setTimer(() => {
      if (marks.get(entry.key) !== entry) return;
      entry.phase = 'fading'; paint(entry); publish();
      entry.timer = setTimer(() => { if (marks.get(entry.key) === entry) { remove(entry); publish(); } }, fadeMs);
    }, delay);
  }

  return {
    mark(entries, { requireVisible = true } = {}) {
      if (disposed) return [];
      const marked: string[] = [];
      for (const { owner, targets } of entries) {
        let first = true;
        for (const target of markableTargets(targets)) {
          const elements = markTargetElements(target, document).filter(element => !requireVisible || markTargetVisible(element, document));
          if (!elements.length) continue;
          const key = `${target.kind}:${target.id}`, previous = marks.get(key), labelled = !labelKinds || labelKinds.has(target.kind);
          // The same target changed again: restart its timer and keep a single label, now pointing at the latest owner.
          if (previous) { stop(previous); unpaint(previous); }
          const entry: Entry = { key, target: { kind: target.kind, id: target.id }, owner, label: Boolean(previous?.label) || first && labelled, phase: 'shown', held: previous?.held ?? false, timer: undefined, elements };
          marks.set(key, entry); paint(entry);
          if (!entry.held) fadeAfter(entry, shownMs);
          if (labelled) first = false;
          if (!marked.includes(owner)) marked.push(owner);
        }
      }
      if (marked.length) publish();
      return marked;
    },
    release(owners) {
      const set = new Set(owners);
      const gone = [...marks.values()].filter(entry => set.has(entry.owner));
      for (const entry of gone) remove(entry);
      if (gone.length) publish();
    },
    hold(key, held) {
      const entry = marks.get(key);
      if (!entry || entry.held === held) return;
      entry.held = held;
      if (held) { stop(entry); entry.phase = 'shown'; paint(entry); } else fadeAfter(entry, releaseMs);
      publish();
    },
    clear() {
      if (!marks.size) return;
      for (const entry of [...marks.values()]) remove(entry);
      publish();
    },
    list: () => snapshot,
    sync(measure) {
      const placements: MarkPlacement[] = [];
      for (const entry of marks.values()) {
        // React can replace an element (for example when a list re-renders); keep the glow on the live one.
        const live = markTargetElements(entry.target, document);
        if (live.length && (live.length !== entry.elements.length || live.some((element, index) => element !== entry.elements[index]))) { unpaint(entry); entry.elements = live; }
        paint(entry);
        if (!entry.label) continue;
        const element = entry.elements[0], size = measure(entry.key);
        if (!element || !size || !element.isConnected) { placements.push({ key: entry.key, x: 0, y: 0, visible: false }); continue; }
        const position = markLabelPosition(entry.target.kind, labelAnchor(entry.target.kind, element.getBoundingClientRect(), visibleArea(element), size), size, placement);
        placements.push({ key: entry.key, ...position, visible: labelVisible(element, box(position.x, position.y, size.width, size.height), document) });
      }
      return placements;
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispose() { for (const entry of [...marks.values()]) remove(entry); disposed = true; snapshot = []; listeners.clear(); },
  };
}
