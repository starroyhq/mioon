import { IMAGE_EDIT_LIMITS, IMAGE_EDIT_SOURCE_MIME_TYPES } from '@mioon/contracts';
export interface ImageEditIntentAsset {
  readonly id: string; readonly projectId: string; readonly sha256: string; readonly name: string;
  readonly mimeType: string; readonly provenance: string; readonly sizeBytes: number; readonly width: number; readonly height: number;
}
export interface ImageEditIntent { readonly id: string; readonly scope: string; readonly projectId: string; readonly assetId: string; readonly sourceKey: string }
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(value);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function asset(value: unknown): value is ImageEditIntentAsset {
  return object(value) && uuid(value.id) && uuid(value.projectId) && typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(value.sha256) && typeof value.name === 'string' &&
    (IMAGE_EDIT_SOURCE_MIME_TYPES as readonly unknown[]).includes(value.mimeType) && typeof value.provenance === 'string' && ['user-import', 'generated', 'synthetic-mock', 'extracted-frame'].includes(value.provenance) &&
    typeof value.sizeBytes === 'number' && Number.isSafeInteger(value.sizeBytes) && value.sizeBytes > 0 && value.sizeBytes <= IMAGE_EDIT_LIMITS.sourceBytes &&
    [value.width, value.height].every(edge => typeof edge === 'number' && Number.isSafeInteger(edge) && edge > 0 && edge <= IMAGE_EDIT_LIMITS.sourceMaxEdge) &&
    (value.width as number) * (value.height as number) <= IMAGE_EDIT_LIMITS.sourceMaxPixels;
}
const sourceKey = (value: ImageEditIntentAsset) => JSON.stringify([value.id, value.projectId, value.sha256, value.name, value.mimeType, value.provenance, value.sizeBytes, value.width, value.height]);
export function captureImageEditIntent({ id, scope, projectId, asset: source }: { id: string; scope: string; projectId: string; asset: unknown }): ImageEditIntent | null {
  return uuid(id) && scope.length > 0 && scope.length <= 4096 && uuid(projectId) && asset(source) && source.projectId === projectId ? Object.freeze({ id, scope, projectId, assetId: source.id, sourceKey: sourceKey(source) }) : null;
}
export function imageEditIntentSource(intent: ImageEditIntent, context: { scope: string; projectId: string | undefined; assets: readonly unknown[] }): ImageEditIntentAsset | null {
  if (intent.scope !== context.scope || intent.projectId !== context.projectId) return null;
  const matches = context.assets.filter(value => object(value) && value.id === intent.assetId);
  return matches.length === 1 && asset(matches[0]) && sourceKey(matches[0]) === intent.sourceKey ? matches[0] : null;
}
interface Session {
  getState(): unknown; requestTarget(groupId: null): boolean | Promise<boolean>; confirmTarget(): boolean | Promise<boolean>;
  keepDraft(): void; selectMode(mode: 'edit'): boolean; selectSource(source: ImageEditIntentAsset): boolean;
}
export interface ImageEditIntentTicket { readonly intent: ImageEditIntent; readonly draftKey: string }
export type ImageEditIntentState = { readonly phase: 'idle' | 'applied' | 'unavailable' } | { readonly phase: 'confirm'; readonly ticket: ImageEditIntentTicket };
interface Options {
  getContext(): { visible: boolean; scope: string; projectId: string | undefined; assets: readonly unknown[]; session: Session | null; isCurrent(intent: ImageEditIntent): boolean };
  isDirty(state: unknown): boolean; onChange(state: ImageEditIntentState): void;
}
function draftKey(value: unknown): string {
  if (!object(value)) return 'invalid';
  return JSON.stringify([value.draft, value.target, value.mode, value.inputImage, value.providerId]);
}
/** Pre-fills only through the existing target/draft guard. Tickets bind the
 * exact form, source and visible session; they never generate or approve work. */
export function createImageEditIntentController(options: Options) {
  const seen = new WeakSet<ImageEditIntent>();
  let epoch = 0, pending: { ticket: ImageEditIntentTicket; session: Session } | null = null;
  function context(intent: ImageEditIntent, expected?: Session) {
    const value = options.getContext(), source = imageEditIntentSource(intent, value);
    return value.visible && value.session && (!expected || value.session === expected) && source && value.isCurrent(intent) ? { session: value.session, source } : null;
  }
  function apply(intent: ImageEditIntent, session: Session, captured: number): boolean {
    const value = context(intent, session);
    if (captured !== epoch || !value || options.isDirty(session.getState())) return false;
    return session.selectMode('edit') && session.selectSource(value.source);
  }
  function clearGuard(held: { ticket: ImageEditIntentTicket; session: Session }) {
    const state = held.session.getState();
    if (draftKey(state) === held.ticket.draftKey && object(state) && object(state.targetRequest) && state.targetRequest.groupId === null) held.session.keepDraft();
  }
  return {
    async receive(intent: ImageEditIntent) {
      if (seen.has(intent)) return; seen.add(intent); pending = null;
      const captured = ++epoch, value = context(intent);
      if (!value) { options.onChange({ phase: 'unavailable' }); return; }
      const before = draftKey(value.session.getState());
      const refused = () => {
        const state = value.session.getState();
        if (draftKey(state) === before && object(state) && object(state.targetRequest) && state.targetRequest.groupId === null) {
          const ticket = Object.freeze({ intent, draftKey: before }); pending = { ticket, session: value.session }; options.onChange({ phase: 'confirm', ticket }); return;
        }
        options.onChange({ phase: 'unavailable' });
      };
      let accepted: boolean;
      try {
        const request = value.session.requestTarget(null);
        // The real dirty-form guard is synchronous. Bind its ticket before
        // yielding, so a hide immediately after the click can retire that guard.
        if (request === false) { refused(); return; }
        accepted = await request;
      }
      catch { if (captured === epoch) options.onChange({ phase: 'unavailable' }); return; }
      if (captured !== epoch || !context(intent, value.session)) return;
      if (!accepted) { refused(); return; }
      options.onChange({ phase: apply(intent, value.session, captured) ? 'applied' : 'unavailable' });
    },
    async confirm(ticket: ImageEditIntentTicket) {
      const held = pending;
      if (!held || held.ticket !== ticket) return false;
      if (!context(ticket.intent, held.session) || draftKey(held.session.getState()) !== ticket.draftKey) {
        pending = null; epoch++; clearGuard(held); options.onChange({ phase: 'unavailable' }); return false;
      }
      pending = null; const captured = ++epoch;
      let accepted: boolean;
      try { accepted = await held.session.confirmTarget(); }
      catch { if (captured === epoch) options.onChange({ phase: 'unavailable' }); return false; }
      if (captured !== epoch || !context(ticket.intent, held.session)) return false;
      const applied = accepted && apply(ticket.intent, held.session, captured);
      options.onChange({ phase: applied ? 'applied' : 'unavailable' }); return applied;
    },
    keep(ticket: ImageEditIntentTicket) {
      if (!pending || pending.ticket !== ticket) return;
      const held = pending; pending = null; epoch++; clearGuard(held); options.onChange({ phase: 'idle' });
    },
    retire() { const held = pending; pending = null; epoch++; if (held) clearGuard(held); options.onChange({ phase: 'idle' }); },
  };
}
