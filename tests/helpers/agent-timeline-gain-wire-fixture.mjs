import {authorizeHttpSnapshot} from './agent-authorizations.mjs';
/** Gain-only extension of the owned timeline HTTP/SSE fixture. Reuses its
 * continuous UTF-8 process collectors and metadata-only managed media graph. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {deriveAgentEndpoint, AGENT_TIMELINE_GAIN_CONTEXT, agentTimelineGainTargetFromTimeline, agentTimelineGainReviewTarget} from '@mioon/contracts';
import {chatRoute} from './agent-edit-wire-fixture.mjs';
import {timelineWireFixture} from './agent-timeline-wire-fixture.mjs';

export const GAIN_FUNCTION = 'mioon_propose_timeline_clip_gain';
export const GAIN_VALUE = 0.4;
export const GAIN_MESSAGE = 'Set the selected saved clip volume to 40% 🎚️ 片段';
export const clipBytesExceptGain = clip => JSON.stringify(Object.fromEntries(Object.entries(clip).filter(([key]) => key !== 'gain')));

export async function gainWireFixture(t, protocol) {
  const f = await timelineWireFixture(t, protocol);
  f.input = async (projectId, selection, {message = GAIN_MESSAGE, consent: overrides, ...changes} = {}) => {
    const snapshot = await f.data(chatRoute(projectId)), configuration = snapshot.settings.configuration;
    await authorizeHttpSnapshot((...args)=>f.request(...args),snapshot,AGENT_TIMELINE_GAIN_CONTEXT);
    assert.equal(snapshot.timelineGainEdit?.available, true, JSON.stringify(snapshot.timelineGainEdit));
    const {available, ...capability} = snapshot.timelineGainEdit;
    const timeline = selection.timeline ?? selection;
    const clipId = selection.clipId ?? selection.clip?.id ?? timeline.clips[0].id;
    const clip = timeline.clips.find(item => item.id === clipId), asset = selection.sources.find(item => item.id === clip.assetId);
    const source = {id: asset.id, sha256: asset.sha256, mimeType: asset.mimeType, hasAudio: asset.hasAudio};
    const target = agentTimelineGainTargetFromTimeline(timeline, clipId, source);
    assert.ok(target, 'fixture requires a supported saved audio target');
    return {requestId: randomUUID(), instanceId: snapshot.instanceId, expectedSettingsRevision: snapshot.settings.revision,
      expectedConversationRevision: snapshot.revision, message,
      consent: {destination: deriveAgentEndpoint(configuration), protocol: configuration.protocol, model: configuration.model,
        context: AGENT_TIMELINE_GAIN_CONTEXT, projectId, ...capability, timelineId: timeline.id,
        clipId, expectedRevision: timeline.revision, reviewTarget: agentTimelineGainReviewTarget(target), ...overrides}, ...changes};
  };
  f.propose = async (projectId, selection, plan = {}) => {
    f.model.plan({name: GAIN_FUNCTION, arguments: {gain: GAIN_VALUE}, ...plan});
    const input = await f.input(projectId, selection), sent = await f.send(projectId, input), done = await f.terminal(projectId, input.requestId);
    const proposal = (await f.proposals(projectId, '?view=all')).proposals.find(item => item.runId === sent.run.id);
    return {input, sent, done, proposal};
  };
  return f;
}
