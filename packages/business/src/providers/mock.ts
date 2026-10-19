import { createHash, randomUUID } from 'node:crypto';
import {throwIfMediaAborted} from '../media-processes.ts';
import {run} from '../media-runtime.ts';
import {createMockRendererCapability, DRAWTEXT_MESSAGE} from './mock-renderer-capability.ts';
import { mkdir, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type {DatabaseSync, SQLInputValue} from 'node:sqlite';
import { SUBJECT_REFERENCE_PROFILE_VERSION, getSubjectGenerationSnapshotIssue } from '@mioon/contracts';
import { providerError } from './live-common.ts';
import type { ProviderContext, ProviderSnapshotView, ProviderReferenceAsset } from './live-common.ts';

const ALIASES: Readonly<Record<string, string>> = { rejected_before_accept: 'reject', terminal_failure: 'failure', poll_timeout_then_recover: 'timeout' };
const SCENARIOS = new Set(['success', 'failure', 'delay', 'timeout', 'unknown', 'reject', 'download_fail_once', 'accepted_then_response_lost', ...Object.keys(ALIASES)]);
const error = providerError;
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' ? value as Record<string, unknown> : null;
const stable = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

export interface MockProviderFactoryOptions {db: DatabaseSync; root: string; now?: () => number}
type MockTaskRow = Record<string, unknown> & {provider_job_id: string; request_id: string; snapshot_json: string; snapshot_hash: string; scenario: string; created_at_ms: number; ready_at_ms: number; poll_count: number; download_attempts: number; cancelled: number};

async function managedDestination(root: string, destination: string, signal?: AbortSignal): Promise<string> {
  throwIfMediaAborted(signal);
  const base = await realpath(root);
  throwIfMediaAborted(signal);
  const absolute = path.resolve(destination);
  const relative = path.relative(base, absolute);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw error('UNSAFE_PATH', 'Output must be inside the managed data directory.');
  await mkdir(path.dirname(absolute), { recursive: true });
  throwIfMediaAborted(signal);
  const parent = await realpath(path.dirname(absolute));
  throwIfMediaAborted(signal);
  if (parent !== base && !parent.startsWith(`${base}${path.sep}`)) throw error('UNSAFE_PATH', 'Output directory is outside managed storage.');
  return absolute;
}

// Unknown capability preserves the existing retryable render path.
const lacksDrawtext = createMockRendererCapability({run, throwIfMediaAborted});

async function runFfmpeg(args: string[], signal?: AbortSignal): Promise<void> {
  try { await run('ffmpeg', args, { timeout: 60_000, signal }); }
  catch (cause) {
    const failure = object(cause), code = failure?.code;
    if (code === 'MEDIA_CANCELLED' || failure?.terminationUnconfirmed) throw cause;
    if (code !== 'MEDIA_INVALID_CONFIGURATION' && code !== 'MEDIA_SPAWN_FAILED' && await lacksDrawtext(signal)) throw error('MOCK_RENDERER_UNSUPPORTED', DRAWTEXT_MESSAGE, { retryable: false });
    const message = code === 'MEDIA_INVALID_CONFIGURATION' ? 'Configured renderer must be an absolute executable path.'
      : code === 'MEDIA_SPAWN_FAILED' ? 'Could not start the simulated video renderer.' : 'Simulated video rendering failed.';
    throw error('MOCK_RENDER_FAILED', message, { retryable: true, ...(failure?.terminationUnconfirmed ? { terminationUnconfirmed: true } : {}) });
  }
}

/** A durable simulated provider ledger, intentionally independent of application jobs. */
export function createMockProvider({ db, root, now = Date.now }: MockProviderFactoryOptions) {
  if (!db?.prepare || !root) throw new TypeError('Mock provider requires a SQLite database and managed root.');
  db.exec(`
    CREATE TABLE IF NOT EXISTS mock_provider_tasks (
      provider_job_id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE,
      snapshot_json TEXT NOT NULL, snapshot_hash TEXT NOT NULL, scenario TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL, ready_at_ms INTEGER NOT NULL,
      poll_count INTEGER NOT NULL DEFAULT 0, download_attempts INTEGER NOT NULL DEFAULT 0,
      cancelled INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS mock_provider_submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL,
      job_id TEXT, provider_job_id TEXT, created_at_ms INTEGER NOT NULL, outcome TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS mock_provider_submissions_request ON mock_provider_submissions(request_id);
  `);
  const get = (id: unknown): MockTaskRow => {
    const row = db.prepare('SELECT * FROM mock_provider_tasks WHERE provider_job_id = ?').get(id as SQLInputValue) as MockTaskRow | undefined;
    if (!row) throw error('PROVIDER_TASK_NOT_FOUND', 'Simulated provider task was not found.');
    return row;
  };
  const statusOf = (row: MockTaskRow) => {
    if (row.cancelled) return { status: 'failed' as const, progress: 0, error: { code: 'PROVIDER_CANCELLED', message: 'Simulated provider task was cancelled.' } };
    if (row.scenario === 'timeout' && row.poll_count <= 2) throw error('PROVIDER_POLL_TIMEOUT', 'Simulated provider status request timed out; the task may still be running.', { retryable: true });
    if (now() < row.ready_at_ms) return { status: 'running' as const, progress: Math.max(0, Math.min(0.95, (now() - row.created_at_ms) / Math.max(1, row.ready_at_ms - row.created_at_ms))) };
    if (row.scenario === 'failure') return { status: 'failed' as const, progress: 1, error: { code: 'MOCK_GENERATION_FAILED', message: 'Simulated generation failure. You can retry this failed job.' } };
    return { status: 'succeeded' as const, progress: 1 };
  };
  function validate(snapshot: unknown): true {
    const value = object(snapshot) as ProviderSnapshotView | null;
    if (!value) throw error('INVALID_SNAPSHOT', 'A generation snapshot is required.');
    if ((value.model ?? 'mock-motion-v1') !== 'mock-motion-v1') throw error('UNSUPPORTED_MODEL', 'Only the simulated motion model is implemented.');
    const subjectIssue = getSubjectGenerationSnapshotIssue(snapshot, {requireProfilePin: true});
    if(subjectIssue)throw error(subjectIssue.code, subjectIssue.message);
    const subject = Object.hasOwn(value, 'subjectReference');
    const references: ProviderReferenceAsset[] = (value.referenceAssets ?? []) as ProviderReferenceAsset[];
    if(!Array.isArray(references)||references.length>2)throw error('INVALID_REFERENCE_COUNT','Mock supports text, one first frame, or an explicit frame pair.');
    if(value.inputProfileVersion === SUBJECT_REFERENCE_PROFILE_VERSION)for(const asset of references){
      if(!asset || !['first_frame', 'last_frame', 'subject_reference'].includes(asset.role as string))throw error('INVALID_REFERENCE_MANIFEST','Version 3 references require explicit supported roles.');
    }
    if(value.lastFrameAssetId != null && references.length !== 2)throw error('INVALID_REFERENCE_MANIFEST','A declared last frame requires a complete explicit frame pair.');
    if(value.referenceAssetIds !== undefined){
      const ids = value.referenceAssetIds;
      if(!Array.isArray(ids) || ids.length !== references.length || ids.some((id, index) => id !== references[index]?.id))throw error('INVALID_REFERENCE_MANIFEST','Reference identities differ from the explicit frame manifest.');
    }
    if(references.length === 2 && (references[0]?.role !== 'first_frame' || references[1]?.role !== 'last_frame' || !references[0].id || !references[1].id || references[0].id === references[1].id))throw error('INVALID_REFERENCE_MANIFEST','Mock frame pairs require distinct assets and explicit first_frame/last_frame roles.');
    if(references.length === 2 && Object.hasOwn(value, 'lastFrameAssetId') && value.lastFrameAssetId !== references[1].id)throw error('INVALID_REFERENCE_MANIFEST','Last-frame selection differs from the explicit frame manifest.');
    if(value.referenceBindings !== undefined){
      const bindings = value.referenceBindings;
      if(!Array.isArray(bindings) || bindings.length !== references.length || Object.keys(bindings).length !== bindings.length || bindings.some((rawBinding, index) => {
        const binding = object(rawBinding);
        return !binding || Object.keys(binding).some(key => !['role', 'assetId', 'sha256'].includes(key)) || binding.assetId !== references[index].id || binding.sha256 !== references[index].sha256 || binding.role !== (references[index].role ?? 'first_frame');
      }))throw error('INVALID_REFERENCE_MANIFEST','Explicit frame bindings differ from the frozen image manifest.');
    }
    if(!subject && references.length === 1 && references[0]?.role !== undefined && references[0].role !== 'first_frame')throw error(['first_frame','last_frame','reference_image','subject_reference','style_reference'].includes(references[0].role as string) ? 'UNSUPPORTED_INPUT_ROLE' : 'UNKNOWN_INPUT_ROLE','A last frame requires a first frame; other reference roles are unsupported.');
    const parameters = object(value.parameters ?? {}) ?? {};
    const requestedScenario = parameters.scenario ?? 'success';
    if (typeof requestedScenario !== 'string' || !SCENARIOS.has(requestedScenario)) throw error('INVALID_SCENARIO', 'Unknown mock scenario.');
    if (value.aspectRatio !== '9:16' || typeof value.duration !== 'number' || ![2, 4, 8].includes(value.duration)) throw error('UNSUPPORTED_CAPABILITY', 'Mock supports portrait 9:16 and 2, 4, or 8 seconds.');
    const scenario = ALIASES[requestedScenario] ?? requestedScenario;
    const delayMs = parameters.delayMs ?? (scenario === 'delay' ? 2000 : 250);
    if (typeof delayMs !== 'number' || !Number.isFinite(delayMs) || delayMs < 0 || delayMs > 120_000) throw error('INVALID_DELAY', 'Mock delay must be between 0 and 120000 milliseconds.');
    return true;
  }
  return {
    id: 'mock', validate,
    capabilities: {
      id: 'mock', name: 'Mock · simulated motion', models: ['mock-motion-v1'], inputModes: ['image', 'text'],
      aspectRatios: ['9:16'], durations: [2, 4, 8], maxReferenceImages: 2, referenceSimulation: 'metadata-only', depictsPromptOrReferences: false, mock: true, configured: true, enabled: true,
      scenarios: [...SCENARIOS], supportsRemoteCancel: true, reconciliation: 'request-id',
    },
    async submit(snapshot: unknown, context: ProviderContext = {}): Promise<{providerJobId: string}> {
      throwIfMediaAborted(context.signal);
      validate(snapshot);
      const requestId = context.requestId;
      if (typeof requestId !== 'string' || !requestId || requestId.length > 256) throw error('INVALID_REQUEST_ID', 'A bounded request ID is required.');
      const value = snapshot as ProviderSnapshotView, parameters = object(value.parameters ?? {}) ?? {};
      const requestedScenario = parameters.scenario ?? 'success';
      const scenario = typeof requestedScenario === 'string' ? (ALIASES[requestedScenario] ?? requestedScenario) : 'success';
      const delayMs = typeof parameters.delayMs === 'number' ? parameters.delayMs : (scenario === 'delay' ? 2000 : 250);
      const json = stable(snapshot), hash = createHash('sha256').update(json).digest('hex');
      const timestamp = now();
      context.beforeSubmit?.();throwIfMediaAborted(context.signal);
      db.exec('SAVEPOINT mock_submission');
      let taskId: string | undefined, failure: Error | undefined;
      try {
        // Counts invocations, not accepted tasks: a hidden duplicate POST is observable.
        const record = db.prepare('INSERT INTO mock_provider_submissions(request_id,job_id,created_at_ms,outcome) VALUES(?,?,?,?)').run(requestId, context.jobId ?? null, timestamp, 'attempted');
        const existing = db.prepare('SELECT * FROM mock_provider_tasks WHERE request_id = ?').get(requestId) as MockTaskRow | undefined;
        let outcome: string;
        if (existing) {
          if (existing.snapshot_hash !== hash) {
            failure = error('IDEMPOTENCY_CONFLICT', 'Request ID was already used for a different snapshot.');
            outcome = 'conflict';
          } else { taskId = existing.provider_job_id; outcome = 'duplicate'; }
        } else if (scenario === 'reject') {
          failure = error('MOCK_SUBMISSION_REJECTED', 'Simulated provider definitively rejected the submission.');
          outcome = 'rejected';
        } else if (scenario === 'unknown') {
          failure = error('SUBMISSION_UNKNOWN', 'Simulated submission outcome is unknown; do not resubmit.', { uncertain: true });
          outcome = 'unknown';
        } else {
          taskId = `mock-${createHash('sha256').update(requestId).digest('hex').slice(0, 32)}`;
          db.prepare('INSERT INTO mock_provider_tasks(provider_job_id,request_id,snapshot_json,snapshot_hash,scenario,created_at_ms,ready_at_ms) VALUES(?,?,?,?,?,?,?)').run(taskId, requestId, json, hash, scenario, timestamp, timestamp + delayMs);
          outcome = scenario === 'accepted_then_response_lost' ? 'accepted_response_lost' : 'accepted';
          if (scenario === 'accepted_then_response_lost') failure = error('SUBMISSION_UNKNOWN', 'The simulated provider accepted the task, but its response was lost. Reconcile without resubmitting.', { uncertain: true });
        }
        db.prepare('UPDATE mock_provider_submissions SET provider_job_id = ?, outcome = ? WHERE id = ?').run(taskId ?? null, outcome, record.lastInsertRowid);
        db.exec('RELEASE SAVEPOINT mock_submission');
      } catch (cause) {
        db.exec('ROLLBACK TO SAVEPOINT mock_submission; RELEASE SAVEPOINT mock_submission');
        throw cause;
      }
      if (failure) throw failure;
      return { providerJobId: taskId as string };
    },
    async poll(providerJobId: string, context: ProviderContext = {}) {
      throwIfMediaAborted(context.signal);
      get(providerJobId);
      db.prepare('UPDATE mock_provider_tasks SET poll_count = poll_count + 1 WHERE provider_job_id = ?').run(providerJobId);
      const status = statusOf(get(providerJobId));
      // A render that cannot succeed on this FFmpeg ends the job now instead of retrying the download for ever.
      if (status.status === 'succeeded' && await lacksDrawtext(context.signal)) return { status: 'failed' as const, progress: 1, error: { code: 'MOCK_RENDERER_UNSUPPORTED', message: DRAWTEXT_MESSAGE, retryable: false } };
      return status;
    },
    async reconcile(requestId: string, context: ProviderContext = {}) {
      throwIfMediaAborted(context.signal);
      const row = db.prepare('SELECT provider_job_id FROM mock_provider_tasks WHERE request_id = ?').get(requestId) as {provider_job_id: string} | undefined;
      return row ? { providerJobId: row.provider_job_id } : null;
    },
    async download(providerJobId: string, destination: string, context: ProviderContext = {}) {
      const { signal } = context;
      throwIfMediaAborted(signal);
      const row = get(providerJobId);
      if (statusOf(row).status !== 'succeeded') throw error('PROVIDER_NOT_READY', 'Simulated output is not available yet.', { retryable: true });
      db.prepare('UPDATE mock_provider_tasks SET download_attempts = download_attempts + 1 WHERE provider_job_id = ?').run(providerJobId);
      if (row.scenario === 'download_fail_once' && row.download_attempts === 0) throw error('DOWNLOAD_FAILED', 'Simulated first download failed. Retry download of the same provider task.', { retryable: true });
      const output = await managedDestination(root, destination, signal);
      throwIfMediaAborted(signal);
      const temporary = `${output}.${randomUUID()}.partial.mp4`;
      const snapshot = JSON.parse(row.snapshot_json) as {duration: number};
      const hue = parseInt(row.snapshot_hash.slice(0, 4), 16) % 360;
      try {
        await runFfmpeg([
          '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=360x640:rate=24',
          '-t', String(snapshot.duration), '-vf', `hue=h=${hue},drawbox=x=0:y=0:w=iw:h=74:color=black@0.85:t=fill,drawtext=text='SIMULATED MOCK':fontcolor=white:fontsize=26:x=(w-tw)/2:y=20`,
          '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '24', '-pix_fmt', 'yuv420p', '-threads', '1',
          '-metadata', 'comment=SIMULATED MOCK VIDEO - NOT AI GENERATED', '-movflags', '+faststart', temporary,
        ], signal);
        throwIfMediaAborted(signal);
        await rename(temporary, output);
        throwIfMediaAborted(signal);
      } finally { await rm(temporary, { force: true }); }
      return { mimeType: 'video/mp4', width: 360, height: 640, duration: snapshot.duration, isMock: true };
    },
    async cancel(providerJobId: string, context: ProviderContext = {}) {
      throwIfMediaAborted(context.signal);
      const row = get(providerJobId);
      if (row.cancelled) return { cancelled: true, remoteCancelled: true, scope: 'remote' };
      // A completed provider output is kept; cancellation never deletes it.
      if ((row.scenario !== 'timeout' || row.poll_count > 2) && now() >= row.ready_at_ms) return { cancelled: false, remoteCancelled: false, scope: 'local', reason: 'Task is already terminal.' };
      db.prepare('UPDATE mock_provider_tasks SET cancelled = 1 WHERE provider_job_id = ?').run(providerJobId);
      return { cancelled: true, remoteCancelled: true, scope: 'remote' };
    },
    stats(requestId?: unknown) {
      const filter = requestId === undefined ? '' : ' WHERE request_id = ?';
      const args: SQLInputValue[] = requestId === undefined ? [] : [requestId as SQLInputValue];
      const submitted = db.prepare(`SELECT COUNT(*) AS n FROM mock_provider_submissions${filter}`).get(...args) as {n: number};
      const tasks = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(download_attempts),0) AS downloads, COALESCE(SUM(poll_count),0) AS polls FROM mock_provider_tasks${filter}`).get(...args) as {n: number; downloads: number; polls: number};
      return { submissionCount: submitted.n, taskCount: tasks.n, downloadAttempts: tasks.downloads, pollCount: tasks.polls };
    },
  };
}
