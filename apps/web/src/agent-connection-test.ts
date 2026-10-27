import { agentTaskConnectionTestResponseSchema } from '../../../packages/contracts/src/agent-tasks-v2.ts';
import type { AgentTaskConnectionTest, AgentTaskLocale, AgentTaskSnapshot } from '../../../packages/contracts/src/agent-tasks-v2.ts';
import { createAgentTaskClient, agentTaskDefinitiveFailure } from './agent-tasks-v2.ts';
import type { AgentTaskClient, AgentTaskProjectSnapshot } from './agent-tasks-v2.ts';
import { deriveAgentEndpoint } from './agent-settings.ts';
import type { AgentConfiguration } from './agent-settings.ts';
import { parseLauncherProjects } from './launcher-state.ts';

/** Sent to the model as a text diagnostic: no tools, no project context, excluded from conversations. */
export const AGENT_CONNECTION_TEST_TEXT = 'Mioon connection test. Reply with the single word OK.';
const POLL_INTERVAL_MS = 1000, POLL_LIMIT_MS = 150_000;
const terminal = new Set(['completed', 'failed', 'stopped', 'reverted']);

export type AgentConnectionTestPhase = 'loading' | 'idle' | 'starting' | 'review' | 'authorizing' | 'testing';
export interface AgentConnectionTestReview { projectId: string; destination: string; model: string }
export interface AgentConnectionTestState {
  phase: AgentConnectionTestPhase;
  /** Newest text diagnostic in the workspace, for any connection. */
  latest: AgentTaskConnectionTest | null;
  review: AgentConnectionTestReview | null;
  /** Why the last start did not produce a test run; null when it did or none was attempted. */
  error: string | null;
}
export interface AgentConnectionTestProject { id: string; updatedAt: string }
export interface AgentConnectionTestDependencies {
  client?: Pick<AgentTaskClient, 'list' | 'send' | 'read' | 'lookup' | 'authorize'>;
  latest?: () => Promise<AgentTaskConnectionTest | null>;
  projects?: () => Promise<readonly AgentConnectionTestProject[]>;
  recentOpened?: () => Promise<Readonly<Record<string, string>>>;
  onChange?: (state: AgentConnectionTestState) => void;
  requestId?: () => string;
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
}

const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const failureCode = (error: unknown): string => record(error) && typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{1,90}$/u.test(error.code) ? error.code : 'NETWORK';
async function envelope(response: Response): Promise<unknown> {
  const body: unknown = await response.json();
  if (!response.ok || !record(body) || body.ok !== true) throw Object.assign(new Error('Connection test request failed'), { code: record(body) && record(body.error) ? failureCode(body.error) : 'NETWORK' });
  return body.data;
}
const defaults = {
  latest: async (): Promise<AgentTaskConnectionTest | null> => agentTaskConnectionTestResponseSchema.parse(await envelope(await fetch('/api/agent/tasks/v2/diagnostics/latest', { credentials: 'same-origin', cache: 'no-store' }))).test,
  projects: async (): Promise<readonly AgentConnectionTestProject[]> => parseLauncherProjects(await envelope(await fetch('/api/rpc', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operation: 'project.list', input: {} }) }))),
  recentOpened: async (): Promise<Readonly<Record<string, string>>> => {
    const value = await envelope(await fetch('/api/ui-preferences', { credentials: 'same-origin', cache: 'no-store' }));
    return record(value) && record(value.recentOpened) ? Object.fromEntries(Object.entries(value.recentOpened).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {};
  },
};

/** The project a test run belongs to: the one the settings were opened from, else the most recently opened,
 * else the most recently updated. Diagnostic runs are hidden from that project's conversations and context. */
export function chooseAgentConnectionTestProject({ currentProjectId, recentOpened, projects }: { currentProjectId?: string | null; recentOpened: Readonly<Record<string, string>>; projects: readonly AgentConnectionTestProject[] }): string | null {
  const known = new Set(projects.map(project => project.id));
  if (currentProjectId && known.has(currentProjectId)) return currentProjectId;
  const opened = Object.entries(recentOpened).filter(([id, at]) => known.has(id) && Number.isFinite(Date.parse(at))).sort((a, b) => Date.parse(b[1]) - Date.parse(a[1]) || (a[0] < b[0] ? -1 : 1));
  if (opened.length) return opened[0]![0];
  const updated = [...projects].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || (a.id < b.id ? -1 : 1));
  return updated[0]?.id ?? null;
}

/** A stored result describes the saved connection only when it tested the same protocol, address and model. */
export const agentConnectionTestMatches = (test: AgentTaskConnectionTest | null, configuration: AgentConfiguration | null | undefined): boolean =>
  Boolean(test && configuration && test.protocol === configuration.protocol && test.baseUrl === configuration.baseUrl && test.model === configuration.model);

/** One settings page's connection test. It sends at most one diagnostic per start, never resends after an
 * unconfirmed send, and only reads its run until the run ends. */
export function createAgentConnectionTestSession({ client = createAgentTaskClient(), latest = defaults.latest, projects = defaults.projects, recentOpened = defaults.recentOpened,
  onChange = () => {}, requestId = () => globalThis.crypto.randomUUID(), wait = ms => new Promise(resolve => setTimeout(resolve, ms)), now = () => Date.now() }: AgentConnectionTestDependencies = {}) {
  let state: AgentConnectionTestState = { phase: 'loading', latest: null, review: null, error: null }, active = true, epoch = 0, pending: AgentTaskProjectSnapshot | null = null, locale: AgentTaskLocale | undefined;
  const publish = (patch: Partial<AgentConnectionTestState>): void => { if (!active) return; state = { ...state, ...patch }; onChange(state); };
  const current = (token: number): boolean => active && token === epoch;
  async function refresh(token: number): Promise<void> {
    try { const value = await latest(); if (current(token)) publish({ latest: value }); } catch { /* The last known result stays shown. */ }
  }
  async function follow(token: number, projectId: string, snapshot: AgentTaskSnapshot): Promise<void> {
    publish({ phase: 'testing', review: null, error: null });
    const started = now();
    let run = snapshot;
    while (current(token) && !terminal.has(run.run.status) && now() - started < POLL_LIMIT_MS) {
      await wait(POLL_INTERVAL_MS);
      if (!current(token)) return;
      try { run = await client.read(projectId, run.run.id); } catch { /* Keep polling; the stored result is reread at the end. */ }
    }
    if (!current(token)) return;
    await refresh(token);
    if (current(token)) publish({ phase: 'idle' });
  }
  async function send(token: number, snapshot: AgentTaskProjectSnapshot): Promise<void> {
    const projectId = snapshot.projectId, id = requestId();
    publish({ phase: 'testing', review: null, error: null });
    let sent: AgentTaskSnapshot;
    try {
      sent = await client.send(projectId, { requestId: id, text: AGENT_CONNECTION_TEST_TEXT, expectedSettingsRevision: snapshot.settings.revision, ...(locale ? { locale } : {}), diagnostic: { profile: 'text' } });
    } catch (error) {
      if (!current(token)) return;
      if (agentTaskDefinitiveFailure(error)) { publish({ phase: 'idle', error: failureCode(error) }); return; }
      // The send may have been accepted. Read its receipt once; never send it again.
      try {
        const found = await client.lookup(projectId, { requestId: id, runId: null, action: 'send' });
        if (!current(token)) return;
        if (!found.found || !found.snapshot) { publish({ phase: 'idle', error: failureCode(error) }); return; }
        sent = found.snapshot;
      } catch (lookupError) { if (current(token)) publish({ phase: 'idle', error: failureCode(lookupError) }); return; }
    }
    if (current(token)) await follow(token, projectId, sent);
  }
  return {
    getState: (): AgentConnectionTestState => state,
    async load(): Promise<void> {
      const token = ++epoch;
      await refresh(token);
      if (!current(token)) return;
      const value = state.latest;
      if (value && !terminal.has(value.status)) { try { await follow(token, value.projectId, await client.read(value.projectId, value.runId)); } catch { if (current(token)) publish({ phase: 'idle' }); } }
      else publish({ phase: 'idle' });
    },
    /** Tests the saved connection at `settingsRevision`; unsaved drafts are never tested. */
    async start({ settingsRevision, currentProjectId = null, locale: requested }: { settingsRevision: number; currentProjectId?: string | null; locale?: AgentTaskLocale }): Promise<boolean> {
      if (!active || state.phase !== 'idle') return false;
      const token = ++epoch; locale = requested; pending = null;
      publish({ phase: 'starting', error: null, review: null });
      try {
        const [opened, available] = await Promise.all([recentOpened().catch(() => ({})), projects()]);
        if (!current(token)) return false;
        const projectId = chooseAgentConnectionTestProject({ currentProjectId, recentOpened: opened, projects: available });
        if (!projectId) { publish({ phase: 'idle', error: 'AGENT_CONNECTION_TEST_NO_PROJECT' }); return false; }
        const snapshot = await client.list(projectId);
        if (!current(token)) return false;
        if (snapshot.readOnly) { publish({ phase: 'idle', error: 'AGENT_TASK_READ_ONLY' }); return false; }
        if (snapshot.settings.revision !== settingsRevision) { publish({ phase: 'idle', error: 'AGENT_TASK_SETTINGS_CHANGED' }); return false; }
        if (!snapshot.authorization.scopes.includes('project_agent')) {
          pending = snapshot;
          publish({ phase: 'review', review: { projectId, destination: deriveAgentEndpoint(snapshot.settings.configuration), model: snapshot.settings.configuration.model } });
          return true;
        }
        await send(token, snapshot);
        return true;
      } catch (error) { if (current(token)) publish({ phase: 'idle', error: failureCode(error) }); return false; }
    },
    /** Grants exactly the reviewed connection, then sends the test. */
    async confirm(): Promise<boolean> {
      const reviewed = pending, review = state.review;
      if (!active || state.phase !== 'review' || !reviewed || !review) return false;
      const token = ++epoch;
      publish({ phase: 'authorizing' });
      try {
        await client.authorize(reviewed, requestId());
        const snapshot = await client.list(reviewed.projectId);
        if (!current(token)) return false;
        pending = null;
        if (snapshot.settings.revision !== reviewed.settings.revision || deriveAgentEndpoint(snapshot.settings.configuration) !== review.destination || snapshot.settings.configuration.model !== review.model) {
          publish({ phase: 'idle', review: null, error: 'AGENT_TASK_SETTINGS_CHANGED' }); return false;
        }
        if (!snapshot.authorization.scopes.includes('project_agent')) { publish({ phase: 'idle', review: null, error: 'AGENT_AUTHORIZATION_REQUIRED' }); return false; }
        await send(token, snapshot);
        return true;
      } catch (error) { if (current(token)) publish({ phase: 'idle', review: null, error: failureCode(error) }); return false; }
    },
    cancel(): boolean {
      if (!active || state.phase !== 'review') return false;
      ++epoch; pending = null; publish({ phase: 'idle', review: null, error: null }); return true;
    },
    dispose(): void { active = false; epoch++; pending = null; },
  };
}
