import {workspaceSettingsSchema} from '../../../packages/contracts/src/workspace-configuration.ts';
import type {WorkspaceSettings, WorkspaceSettingsUpdate} from '../../../packages/contracts/src/workspace-configuration.ts';
import {readWorkspaceSettings, saveWorkspaceSettings} from './workspace-settings-client.ts';
import type {GenerationSaveTicket} from './generation-services-settings.ts';

export interface GenerationLiveSettingsClient {
  read(signal?: AbortSignal): Promise<WorkspaceSettings>;
  write(input: WorkspaceSettingsUpdate): Promise<WorkspaceSettings>;
}
export interface GenerationLiveSettingsState {
  phase: 'loading' | 'ready' | 'saving' | 'saved' | 'error' | 'load_error' | 'reconciling' | 'review' | 'blocked';
  snapshot: WorkspaceSettings | null;
  draft: boolean | null;
  recovery: 'unknown' | 'conflict' | null;
  version: number;
}
export const initialGenerationLiveSettings = (): GenerationLiveSettingsState => ({phase: 'loading', snapshot: null, draft: null, recovery: null, version: 0});
export const generationLiveSettingsDirty = (state: GenerationLiveSettingsState): boolean => Boolean(state.snapshot && state.draft !== state.snapshot.liveGeneration);
const busy = (state: GenerationLiveSettingsState) => ['loading', 'saving', 'reconciling'].includes(state.phase);

/** The global dispatch gate participates in the page save. Closing runs first;
 * opening runs only after every service file was confirmed. */
export function createGenerationLiveSettings({
  client = {read: readWorkspaceSettings, write: saveWorkspaceSettings}, onChange = () => {}, onConfirmed = () => {},
}: {client?: GenerationLiveSettingsClient; onChange?: (state: GenerationLiveSettingsState) => void; onConfirmed?: () => void} = {}) {
  let state = initialGenerationLiveSettings(), live = true, visible = false, epoch = 0, visibilityEpoch = 0;
  let pending: AbortController | null = null;
  const publish = (patch: Partial<GenerationLiveSettingsState>) => {
    if (!live) return;
    state = {...state, ...patch, version: state.version + 1};
    onChange(structuredClone(state));
  };
  const owned = (token: number) => live && token === epoch;
  async function load(recover = false): Promise<boolean> {
    if (!live || !visible || busy(state) && state.phase !== 'loading') return false;
    pending?.abort(); pending = new AbortController(); const token = ++epoch;
    publish({phase: recover ? 'reconciling' : 'loading'});
    try {
      const snapshot = workspaceSettingsSchema.parse(await client.read(pending.signal));
      if (!owned(token)) return false;
      publish({snapshot, draft: recover ? state.draft : snapshot.liveGeneration, phase: recover ? 'review' : 'ready', recovery: recover ? state.recovery ?? 'unknown' : null});
      return true;
    } catch {
      if (owned(token)) publish({phase: recover ? 'blocked' : 'load_error'});
      return false;
    }
  }
  function prepareSave(): GenerationSaveTicket | null {
    if (!live || !visible || busy(state) || state.recovery || !state.snapshot || state.draft === null) throw new Error('GENERATION_SETTINGS_NOT_READY');
    if (!generationLiveSettingsDirty(state)) return null;
    const expectedRevision = state.snapshot.revision, enabled = state.draft, version = state.version, visibility = visibilityEpoch;
    let consumed = false;
    return {
      dispose() {consumed = true;},
      async run() {
        if (consumed || !live || !visible || visibility !== visibilityEpoch || state.version !== version) return 'blocked';
        consumed = true;
        const token = ++epoch;
        publish({phase: 'saving'});
        try {
          const snapshot = workspaceSettingsSchema.parse(await client.write({expectedRevision, liveGeneration: enabled}));
          if (!owned(token)) return 'blocked';
          if (snapshot.revision !== expectedRevision + 1 || snapshot.liveGeneration !== enabled) throw new Error('INVALID_RESPONSE');
          publish({snapshot, draft: snapshot.liveGeneration, phase: 'saved', recovery: null});
          onConfirmed();
          return 'saved';
        } catch (error) {
          if (!owned(token)) return 'blocked';
          const code = error && typeof error === 'object' && 'code' in error ? error.code : '';
          if (code === 'UNAUTHORIZED' || code === 'WORKSPACE_SETTINGS_VALIDATION') {publish({phase: 'error'}); return 'error';}
          publish({phase: 'reconciling', recovery: code === 'WORKSPACE_SETTINGS_CONFLICT' ? 'conflict' : 'unknown'});
          pending?.abort(); pending = new AbortController();
          try {
            const snapshot = workspaceSettingsSchema.parse(await client.read(pending.signal));
            if (!owned(token)) return 'blocked';
            // A matching value does not prove that this request committed.
            publish({snapshot, phase: 'review'});
          } catch {if (owned(token)) publish({phase: 'blocked'});}
          return 'unknown';
        }
      },
    };
  }
  return {
    getState: () => structuredClone(state), load: () => load(), reload: () => load(true), prepareSave,
    setVisible(value: boolean) {
      if (visible === value) return;
      visibilityEpoch++; visible = value;
      if (!value && busy(state)) {
        // The accepted write may still commit. Retire only its UI admission;
        // reopening must reconcile instead of adopting that old page's ACK.
        epoch++; pending?.abort();
        if (state.phase !== 'loading') publish({phase: 'blocked', recovery: 'unknown'});
      }
    },
    setEnabled(value: boolean) {if (!live || !visible || busy(state) || state.recovery || !state.snapshot) return false; publish({draft: value, phase: 'ready'}); return true;},
    discard() {if (!live || busy(state) || state.recovery || !state.snapshot) return false; publish({draft: state.snapshot.liveGeneration, phase: 'ready'}); return true;},
    useLatest() {if (!live || !visible || busy(state) || state.phase === 'blocked' || !state.snapshot) return false; publish({draft: state.snapshot.liveGeneration, phase: 'ready', recovery: null}); return true;},
    acknowledge() {if (!live || !visible || state.phase !== 'review') return false; publish({phase: 'ready', recovery: null}); return true;},
    dispose() {live = false; epoch++; visibilityEpoch++; pending?.abort(); state = initialGenerationLiveSettings();},
  };
}
