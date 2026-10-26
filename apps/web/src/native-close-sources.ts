/** Local close admission sees metadata only. These adapters never save, retry,
 * cancel or discard work, and never expose input values to the registry. */
export interface NativeCloseSourceState {
  readonly dirty: boolean;
  readonly busy: boolean;
  readonly blocked: boolean;
  readonly version: number;
}
export interface NativeCloseSourceRegistry {
  register(slot: string): {
    update(state: NativeCloseSourceState): void;
    release(): void;
  };
}
type Flags = Omit<NativeCloseSourceState, 'version'>;
type Identity = readonly (string | number | boolean | null | undefined)[];
interface Projection extends Flags { readonly identity: Identity }

/** The comparison stays local. Only booleans and a monotonic version leave it.
 * An unchanged accepted stream/progress read is not a new close decision. */
function createReporter<T>(registry: NativeCloseSourceRegistry | undefined, slot: string, project: (state: T) => Projection) {
  const registration = registry?.register(slot);
  let released = false, version = 0, previous: Projection | null = null;
  let current: NativeCloseSourceState = Object.freeze({ dirty: false, busy: true, blocked: true, version });
  return {
    publish(state: T) {
      if (released) return current;
      const next = project(state);
      if (!previous || next.dirty !== previous.dirty || next.busy !== previous.busy || next.blocked !== previous.blocked ||
          next.identity.length !== previous.identity.length || next.identity.some((value, index) => value !== previous?.identity[index])) {
        previous = next;
        current = Object.freeze({ dirty: next.dirty, busy: next.busy, blocked: next.blocked, version: ++version });
        registration?.update(current);
      }
      return current;
    },
    getState: () => current,
    release() { if (released) return; released = true; previous = null; registration?.release(); },
  };
}

interface AgentTarget { readonly id?: string; readonly shotId?: string; readonly clipId?: string; readonly revision?: number; readonly expectedRevision?: number }
interface AgentChatCloseInput {
  readonly draft: string;
  readonly phase: string;
  readonly pending: { readonly requestId: string } | null;
  readonly contextMode?: string;
  readonly consent?: string | null;
  readonly editTarget?: AgentTarget | null;
  readonly timelineTarget?: AgentTarget | null;
  readonly timelineGainTarget?: AgentTarget | null;
}
const chatPhases = new Set(['loading', 'ready', 'submitting', 'streaming', 'stopping', 'detached', 'unknown', 'load_error']);
const targetIdentity = (target: AgentTarget | null | undefined): Identity => [target?.id, target?.shotId, target?.clipId, target?.revision, target?.expectedRevision];
export function agentChatCloseState(state: AgentChatCloseInput): Projection {
  return {
    dirty: Boolean(state.draft.trim()) && !state.pending,
    busy: ['loading', 'submitting', 'stopping'].includes(state.phase),
    // The first failed read can precede recovery of a retained request receipt.
    blocked: Boolean(state.pending) || ['unknown', 'load_error'].includes(state.phase) || !chatPhases.has(state.phase),
    identity: [state.draft, state.contextMode, state.pending?.requestId, ...targetIdentity(state.editTarget), ...targetIdentity(state.timelineTarget), ...targetIdentity(state.timelineGainTarget)],
  };
}
export const createAgentChatCloseReporter = (registry?: NativeCloseSourceRegistry) => createReporter(registry, 'agent-chat', agentChatCloseState);

interface AgentTaskCloseInput {
  readonly draft: string;
  readonly draftDirty?:boolean;
  readonly draftVersion?:number;
  readonly unknownOutcome?:boolean;
  readonly uploads?:readonly {readonly id:string}[];
  readonly phase: string;
  readonly pending: { readonly requestId: string; readonly runId: string | null; readonly action: string } | null;
  readonly snapshot: { readonly run: { readonly id: string; readonly status: string }; readonly steps: readonly { readonly id: string; readonly status: string }[] } | null;
}
export function agentTaskCloseState(state: AgentTaskCloseInput): Projection {
  const unknown = state.snapshot?.steps.filter(step => step.status === 'unknown').map(step => step.id).sort() ?? [];
  // Read-only failures retain drafts and durable evidence. Initial/retry reads
  // stay busy until their owner settles; receipt failures remain hard errors.
  // A confirmed terminal conversation's refreshing phase is only a GET. Its
  // draft, pending receipt and unknown-result fences still apply below.
  return { dirty: Boolean(state.draftDirty || state.draft.trim() || state.uploads?.length) && !state.pending, busy: state.phase === 'loading' || state.phase === 'submitting', blocked: Boolean(state.pending || unknown.length || state.unknownOutcome) || ['unknown', 'error'].includes(state.phase),
    identity: [state.draft, state.draftVersion, ...(state.uploads?.map(upload=>upload.id)??[]), state.pending?.requestId, state.pending?.runId, state.pending?.action, state.snapshot?.run.id, ...unknown] };
}
export const createAgentTaskCloseReporter = (registry?: NativeCloseSourceRegistry) => createReporter(registry, 'agent-task-v2', agentTaskCloseState);

interface ImageCloseInput {
  readonly draft: { readonly name: string; readonly prompt: string };
  readonly phase: string;
  readonly providerId: string;
  readonly mode: string;
  readonly inputImage: { readonly assetId: string; readonly sha256: string } | null;
  readonly target: { readonly groupId: string; readonly expectedRevision: number } | null;
  readonly pending: { readonly operation: string; readonly input: { readonly requestId: string } } | null;
  readonly remotePending: { readonly input: { readonly requestId: string } } | null;
  readonly actionTaskId: string | null;
  readonly reviewActionId: string | null;
  readonly remoteActionTaskId: string | null;
  readonly storageBlocked: boolean;
  readonly remoteStorageBlocked: boolean;
}
interface ImageCloseReport { readonly state: ImageCloseInput; readonly dirty: boolean; readonly rejectionBlocked: boolean }
const imagePhases = new Set(['idle', 'loading', 'ready', 'submitting', 'unknown', 'targeting', 'read_error']);
export function imageGenerationCloseState({ state, dirty, rejectionBlocked }: ImageCloseReport): Projection {
  return {
    dirty: dirty && !state.pending,
    busy: ['submitting', 'targeting'].includes(state.phase) || Boolean(state.actionTaskId || state.reviewActionId || state.remoteActionTaskId),
    blocked: Boolean(state.pending || state.remotePending || state.storageBlocked || state.remoteStorageBlocked || rejectionBlocked) || state.phase === 'unknown' || !imagePhases.has(state.phase),
    identity: [state.draft.name, state.draft.prompt, state.providerId, state.mode, state.inputImage?.assetId, state.inputImage?.sha256,
      state.target?.groupId, state.target?.expectedRevision, state.pending?.operation, state.pending?.input.requestId,
      state.remotePending?.input.requestId, state.actionTaskId, state.reviewActionId, state.remoteActionTaskId],
  };
}
export const createImageGenerationCloseReporter = (registry?: NativeCloseSourceRegistry) => createReporter(registry, 'image-generation', imageGenerationCloseState);

interface AgentEditsCloseInput {
  readonly phase: string;
  readonly busy: string | null;
  readonly uncertainIds: readonly string[];
  readonly proposals: readonly { readonly id: string; readonly status: string }[];
}
const editPhases = new Set(['loading', 'ready', 'error']);
export function agentEditsCloseState(state: AgentEditsCloseInput): Projection {
  const unresolved = state.proposals.filter(proposal => ['approved', 'dispatching', 'unknown'].includes(proposal.status)).map(proposal => proposal.id).sort();
  return {
    dirty: false,
    // Hidden initial reads can remain 'loading'; only mutations own busy.
    busy: Boolean(state.busy),
    blocked: Boolean(state.uncertainIds.length || unresolved.length) || !editPhases.has(state.phase),
    identity: [state.busy, ...[...state.uncertainIds].sort(), '|saved-unresolved|', ...unresolved],
  };
}
export const createAgentEditsCloseReporter = (registry?: NativeCloseSourceRegistry) => createReporter(registry, 'agent-edits', agentEditsCloseState);

interface RejectionIdentity { readonly revision: number; readonly digest: Promise<string> }
async function identityDigest(identity: string): Promise<string> {
  const bytes = new TextEncoder().encode(identity);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
/** Close-only evidence. Validated review DTOs are supplied by the existing
 * session; hashing never delays or changes a request. The map holds no input,
 * destination, configuration or credential, only review IDs/revisions/digests.
 * Its limit is the existing per-project review capacity. Impossible overflow or
 * contradictory identity is corruption, never permission to evict an intent. */
export function createImageRejectionCloseLatch({ limit, identityBytes }: { readonly limit: number; readonly identityBytes: number }, onChange: () => void = () => {}, digest: (identity: string) => Promise<string> = identityDigest) {
  const pending = new Map<string, RejectionIdentity>();
  const hash = (identity: string) => Promise.resolve().then(() => {
    if (!Number.isSafeInteger(identityBytes) || identityBytes < 1 || new TextEncoder().encode(identity).byteLength > identityBytes) throw new Error('Close identity exceeds the existing review bound');
    return digest(identity);
  });
  let active = true, corrupt = false;
  const changed = () => { if (active) onChange(); };
  const fail = () => { if (active) { corrupt = true; changed(); } };
  const failCurrent = (id: string, expected: RejectionIdentity) => { if (active && pending.get(id) === expected) fail(); };
  return {
    begin(id: string, revision: number, identity: string) {
      if (!active) return;
      if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(revision) || revision < 1) { fail(); return; }
      const previous = pending.get(id);
      if (!previous && pending.size >= limit) { fail(); return; }
      const next = hash(identity);
      if (previous) {
        void Promise.all([previous.digest, next]).then(([before, after]) => { if (before !== after || previous.revision !== revision) failCurrent(id, previous); }, () => failCurrent(id, previous));
      } else {
        const entry = { revision, digest: next }; pending.set(id, entry);
        void next.catch(() => failCurrent(id, entry));
      }
      changed();
    },
    reconcile(id: string, revision: number, state: string, identity: string) {
      const expected = pending.get(id);
      if (!active || !expected) return;
      void Promise.all([expected.digest, hash(identity)]).then(([before, after]) => {
        if (!active || pending.get(id) !== expected) return;
        if (before !== after) { failCurrent(id, expected); return; }
        // A pending reread proves neither rejection nor nonacceptance. A
        // concurrent accepted approval also makes the old rejection impossible;
        // the accepted task keeps its own durable lifetime and is not cancelled.
        const terminalRevision = state === 'rejected' || state === 'approved' ? expected.revision + 1 : state === 'dispatched' ? expected.revision + 2 : null;
        if (terminalRevision === null || revision !== terminalRevision) return;
        pending.delete(id); changed();
      }, () => failCurrent(id, expected));
    },
    getState: () => Object.freeze({ rejectionBlocked: corrupt || pending.size > 0 }),
    dispose() { active = false; pending.clear(); },
  };
}
