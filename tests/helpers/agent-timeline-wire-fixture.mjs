import {authorizeHttpSnapshot} from './agent-authorizations.mjs';
/** Timeline-only extension of the existing owned HTTP/SSE fixture. Sources are
 * deliberately metadata-only: these tests never import, render or call FFmpeg. */
import assert from 'node:assert/strict';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fixtureCli} from './agent-edit-wire-lifecycle.ts';
import {deriveAgentEndpoint, AGENT_TIMELINE_MOVE_CONTEXT} from '@mioon/contracts';
import {editWireFixture, database, chatRoute, REPO, EDIT_WIRE_TOKEN} from './agent-edit-wire-fixture.mjs';

export const MOVE_FUNCTION = 'mioon_propose_timeline_clip_move';
export const MOVE_START = 120;
export const MOVE_MESSAGE = 'Move the selected saved clip to frame 120';
export const timelineRows = root => database(root, db => db.prepare('SELECT * FROM timeline_requests ORDER BY rowid').all());
export const savedTimeline = (root, projectId) => database(root, db => JSON.parse(db.prepare('SELECT data FROM timelines WHERE projectId=?').get(projectId).data));
export const clipBytesExceptStart = clip => JSON.stringify(Object.fromEntries(Object.entries(clip).filter(([key]) => key !== 'startFrame')));

export async function timelineWireFixture(t, protocol) {
  const f = await editWireFixture(t, protocol);
  f.setup = async () => {
    const project = await f.rpc('project.create', {name: 'PRIVATE_PROJECT_NAME_MUST_NOT_REACH_MODEL'});
    const sources = [
      {id: randomUUID(), projectId: project.id, name: 'PRIVATE_VIDEO_SOURCE.mp4', mimeType: 'video/mp4', duration: 10,
        width: 720, height: 1280, hasAudio: true, hasVideo: true, provenance: 'user-import', sha256: 'a'.repeat(64), relativePath: 'media/PRIVATE_VIDEO_SOURCE.mp4'},
      {id: randomUUID(), projectId: project.id, name: 'PRIVATE_AUDIO_SOURCE.wav', mimeType: 'audio/wav', duration: 10,
        hasAudio: true, hasVideo: false, provenance: 'user-import', sha256: 'b'.repeat(64), relativePath: 'media/PRIVATE_AUDIO_SOURCE.wav'},
    ].map(source => ({...source, createdAt: '2026-10-10T00:00:00.000Z'}));
    database(f.root, db => {
      for (const source of sources) db.prepare('INSERT INTO assets(id,projectId,data) VALUES(?,?,?)').run(source.id, project.id, JSON.stringify(source));
    }, {writable: true});
    let timeline = await f.rpc('timeline.get', {projectId: project.id});
    const add = async fields => {
      timeline = await f.rpc('timeline.clip.add', {projectId: project.id, expectedRevision: timeline.revision, requestId: randomUUID(), ...fields});
      return timeline.clips.at(-1).id;
    };
    const clipId = await add({trackId: timeline.tracks[0].id, assetId: sources[0].id, name: 'Selected saved clip 🎬 片段',
      startFrame: 30, durationFrames: 60, sourceInFrame: 15, rect: {x: 20, y: 40, width: 400, height: 600}, gain: 0.375, fadeInFrames: 6, fadeOutFrames: 9});
    await add({trackId: timeline.tracks[0].id, assetId: sources[0].id, name: 'PRIVATE_SAME_TRACK_CLIP', startFrame: 300, durationFrames: 30});
    await add({trackId: timeline.tracks[1].id, assetId: sources[0].id, name: 'PRIVATE_OTHER_TRACK_CLIP', startFrame: 600, durationFrames: 30});
    await add({trackId: timeline.tracks[2].id, assetId: sources[1].id, name: 'PRIVATE_AUDIO_CLIP', startFrame: 20, durationFrames: 100,
      sourceInFrame: 3, gain: 0.625, fadeInFrames: 10, fadeOutFrames: 12});
    return {project, timeline, clip: timeline.clips.find(item => item.id === clipId), clipId, sources};
  };
  f.input = async (projectId, selection, {message = MOVE_MESSAGE, consent: overrides, ...changes} = {}) => {
    const snapshot = await f.data(chatRoute(projectId)), configuration = snapshot.settings.configuration;
    await authorizeHttpSnapshot((...args)=>f.request(...args),snapshot,AGENT_TIMELINE_MOVE_CONTEXT);
    assert.equal(snapshot.timelineEdit?.available, true, JSON.stringify(snapshot.timelineEdit));
    const {available, ...capability} = snapshot.timelineEdit;
    const timeline = selection.timeline ?? selection;
    return {requestId: randomUUID(), instanceId: snapshot.instanceId, expectedSettingsRevision: snapshot.settings.revision,
      expectedConversationRevision: snapshot.revision, message,
      consent: {destination: deriveAgentEndpoint(configuration), protocol: configuration.protocol, model: configuration.model,
        context: AGENT_TIMELINE_MOVE_CONTEXT, projectId, ...capability, timelineId: timeline.id,
        clipId: selection.clipId ?? selection.clip?.id ?? timeline.clips[0].id, expectedRevision: timeline.revision, ...overrides}, ...changes};
  };
  f.propose = async (projectId, selection, plan = {}) => {
    f.model.plan({name: MOVE_FUNCTION, arguments: {startFrame: MOVE_START}, ...plan});
    const input = await f.input(projectId, selection), sent = await f.send(projectId, input), done = await f.terminal(projectId, input.requestId);
    const proposal = (await f.proposals(projectId, '?view=all')).proposals.find(item => item.runId === sent.run.id);
    return {input, sent, done, proposal};
  };
  f.cli = (operation, input = {}) => fixtureCli(f.lifetime, process.execPath, [path.join(REPO, 'apps/cli/src/index.ts'), ...operation.split('.'), '--input', JSON.stringify(input)],
    {cwd: REPO, env: {PATH: process.env.PATH || '', HOME: f.root, MIOON_BASE_URL: f.process.url, MIOON_TOKEN: EDIT_WIRE_TOKEN, MIOON_ENABLE_LIVE_PROVIDER: '0'}}, operation, EDIT_WIRE_TOKEN);

  return f;
}
