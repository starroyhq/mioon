import {authorizeHttpSnapshot} from './agent-authorizations.ts';
/** Timeline-only extension of the existing owned HTTP/SSE fixture. Sources are
 * deliberately metadata-only: these tests never import, render or call FFmpeg. */
import assert from 'node:assert/strict';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fixtureCli} from './agent-edit-wire-lifecycle.ts';
import {deriveAgentEndpoint, AGENT_TIMELINE_MOVE_CONTEXT} from '@mioon/contracts';
import {editWireFixture, database, chatRoute, REPO, EDIT_WIRE_TOKEN} from './agent-edit-wire-fixture.ts';

export const MOVE_FUNCTION = 'mioon_propose_timeline_clip_move';
export const MOVE_START = 120;
export const MOVE_MESSAGE = 'Move the selected saved clip to frame 120';
interface WireClip {readonly id: string; readonly trackId: string; readonly assetId: string; readonly startFrame: number; readonly [key: string]: unknown}
interface WireTimeline {readonly id: string; readonly revision: number; readonly projectId: string; readonly clips: WireClip[]; readonly tracks: {readonly id: string}[]}
interface WireSource {readonly id: string; readonly [key: string]: unknown}
export const timelineRows = (root: string): unknown[] => database(root, (db: import('node:sqlite').DatabaseSync) => db.prepare('SELECT * FROM timeline_requests ORDER BY rowid').all());
export const savedTimeline = (root: string, projectId: string): WireTimeline => database(root, (db: import('node:sqlite').DatabaseSync) => JSON.parse((db.prepare('SELECT data FROM timelines WHERE projectId=?').get(projectId) as {data: string}).data)) as WireTimeline;
export const clipBytesExceptStart = (clip: Record<string, unknown>): string => JSON.stringify(Object.fromEntries(Object.entries(clip).filter(([key]) => key !== 'startFrame')));
interface MoveSelection {readonly timeline?: WireTimeline; readonly clipId?: string; readonly clip?: WireClip; readonly [key: string]: unknown}

interface TimelineFixture {
  root: string; lifetime: unknown; process: {url: string}; model: {plan(value: Record<string, unknown>): void};
  rpc(operation: string, input: Record<string, unknown>): Promise<unknown>;
  data(path: string): Promise<Record<string, unknown>>;
  request(route: string, options: {method: string; input: unknown}): Promise<{status: number; body?: unknown}>;
  send(projectId: string, input: Record<string, unknown>): Promise<{run: {id: string}}>;
  terminal(projectId: string, requestId: string): Promise<unknown>;
  proposals(projectId: string, query: string): Promise<{proposals: {runId: string}[]}>;
  setup?: () => Promise<unknown>;
  input?: (projectId: string, selection: MoveSelection, overrides?: {message?: string; consent?: Record<string, unknown>; [key: string]: unknown}) => Promise<Record<string, unknown>>;
  propose?: (projectId: string, selection: MoveSelection, plan?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  cli?: (operation: string, input?: Record<string, unknown>) => Promise<unknown>;
}
export async function timelineWireFixture(t: unknown, protocol: unknown): Promise<Record<string, unknown>> {
  const f = await editWireFixture(t, protocol) as unknown as TimelineFixture;
  f.setup = async (): Promise<unknown> => {
    const project = await f.rpc('project.create', {name: 'PRIVATE_PROJECT_NAME_MUST_NOT_REACH_MODEL'}) as {id: string};
    const sources = ([
      {id: randomUUID(), projectId: project.id, name: 'PRIVATE_VIDEO_SOURCE.mp4', mimeType: 'video/mp4', duration: 10,
        width: 720, height: 1280, hasAudio: true, hasVideo: true, provenance: 'user-import', sha256: 'a'.repeat(64), relativePath: 'media/PRIVATE_VIDEO_SOURCE.mp4'},
      {id: randomUUID(), projectId: project.id, name: 'PRIVATE_AUDIO_SOURCE.wav', mimeType: 'audio/wav', duration: 10,
        hasAudio: true, hasVideo: false, provenance: 'user-import', sha256: 'b'.repeat(64), relativePath: 'media/PRIVATE_AUDIO_SOURCE.wav'},
    ] as Record<string, unknown>[]).map((source: Record<string, unknown>) => ({...source, createdAt: '2026-10-10T00:00:00.000Z'})) as unknown as {id: string; projectId: string; [key: string]: unknown}[];
    database(f.root, (db: import('node:sqlite').DatabaseSync) => {
      for (const source of sources) db.prepare('INSERT INTO assets(id,projectId,data) VALUES(?,?,?)').run(String(source.id), project.id, JSON.stringify(source));
    }, {writable: true});
    let timeline = await f.rpc('timeline.get', {projectId: project.id}) as WireTimeline;
    const add = async (fields: Record<string, unknown>): Promise<string> => {
      timeline = await f.rpc('timeline.clip.add', {projectId: project.id, expectedRevision: timeline.revision, requestId: randomUUID(), ...fields}) as WireTimeline;
      return timeline.clips.at(-1)!.id;
    };
    const clipId: string = await add({trackId: timeline.tracks[0].id, assetId: sources[0].id, name: 'Selected saved clip 🎬 片段',
      startFrame: 30, durationFrames: 60, sourceInFrame: 15, rect: {x: 20, y: 40, width: 400, height: 600}, gain: 0.375, fadeInFrames: 6, fadeOutFrames: 9});
    await add({trackId: timeline.tracks[0].id, assetId: sources[0].id, name: 'PRIVATE_SAME_TRACK_CLIP', startFrame: 300, durationFrames: 30});
    await add({trackId: timeline.tracks[1].id, assetId: sources[0].id, name: 'PRIVATE_OTHER_TRACK_CLIP', startFrame: 600, durationFrames: 30});
    await add({trackId: timeline.tracks[2].id, assetId: sources[1].id, name: 'PRIVATE_AUDIO_CLIP', startFrame: 20, durationFrames: 100,
      sourceInFrame: 3, gain: 0.625, fadeInFrames: 10, fadeOutFrames: 12});
    return {project, timeline, clip: timeline.clips.find((item: WireClip) => item.id === clipId) as WireClip|undefined, clipId, sources};
  };
  interface MoveSnapshot {settings: {configuration: Record<string, unknown>; revision: number}; instanceId: string; revision: number; timelineEdit?: {available?: boolean; [key: string]: unknown}; [key: string]: unknown}
  f.input = async (projectId: string, selection: MoveSelection, {message = MOVE_MESSAGE, consent: overrides, ...changes}: {message?: string; consent?: Record<string, unknown>; [key: string]: unknown} = {}): Promise<Record<string, unknown>> => {
    const snapshot = await f.data(chatRoute(projectId) as never) as MoveSnapshot, configuration = snapshot.settings.configuration;
    await authorizeHttpSnapshot(((route: string, options: {method: string; input: unknown}) => f.request(route, options)) as never, snapshot as never, AGENT_TIMELINE_MOVE_CONTEXT);
    assert.equal(snapshot.timelineEdit?.available, true, JSON.stringify(snapshot.timelineEdit));
    const {available, ...capability} = snapshot.timelineEdit ?? {};
    const timeline = (selection.timeline ?? selection) as WireTimeline;
    return {requestId: randomUUID(), instanceId: snapshot.instanceId, expectedSettingsRevision: snapshot.settings.revision,
      expectedConversationRevision: snapshot.revision, message,
      consent: {destination: deriveAgentEndpoint(configuration as never), protocol: configuration.protocol, model: configuration.model,
        context: AGENT_TIMELINE_MOVE_CONTEXT, projectId, ...capability, timelineId: timeline.id,
        clipId: selection.clipId ?? selection.clip?.id ?? timeline.clips[0].id, expectedRevision: timeline.revision, ...overrides}, ...changes};
  };
  f.propose = async (projectId: string, selection: MoveSelection, plan: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    f.model.plan({name: MOVE_FUNCTION, arguments: {startFrame: MOVE_START}, ...plan});
    const input = await f.input!(projectId, selection), sent = await f.send(projectId, input) as {run: {id: string}}, done = await f.terminal(projectId, String(input.requestId));
    const proposal = (await f.proposals(projectId, '?view=all') as {proposals: {runId: string}[]}).proposals.find(item => item.runId === sent.run.id);
    return {input, sent, done, proposal};
  };
  f.cli = (operation: string, input: Record<string, unknown> = {}): Promise<unknown> => fixtureCli(f.lifetime as never, process.execPath, [path.join(REPO, 'apps/cli/src/index.ts'), ...operation.split('.'), '--input', JSON.stringify(input)],
    {cwd: REPO, env: {PATH: process.env.PATH || '', HOME: String(f.root), MIOON_BASE_URL: String(f.process.url), MIOON_TOKEN: EDIT_WIRE_TOKEN, MIOON_ENABLE_LIVE_PROVIDER: '0'}}, operation, EDIT_WIRE_TOKEN);

  return f as unknown as Record<string, unknown>;
}
