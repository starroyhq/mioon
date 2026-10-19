import {authorizeHttpSnapshot} from './agent-authorizations.ts';
/** Gain-only extension of the owned timeline HTTP/SSE fixture. Reuses its
 * continuous UTF-8 process collectors and metadata-only managed media graph. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {deriveAgentEndpoint, AGENT_TIMELINE_GAIN_CONTEXT, agentTimelineGainTargetFromTimeline, agentTimelineGainReviewTarget} from '@mioon/contracts';
import {chatRoute} from './agent-edit-wire-fixture.ts';
import {timelineWireFixture} from './agent-timeline-wire-fixture.ts';

export const GAIN_FUNCTION = 'mioon_propose_timeline_clip_gain';
export const GAIN_VALUE = 0.4;
export const GAIN_MESSAGE = 'Set the selected saved clip volume to 40% 🎚️ 片段';
interface WireClip {readonly id: string; readonly assetId: string; readonly [key: string]: unknown}
interface WireTimeline {readonly id: string; readonly revision: number; readonly clips: WireClip[]}
interface WireAsset {readonly id: string; readonly sha256: string; readonly mimeType: string; readonly hasAudio: boolean}
interface GainSelection {readonly timeline?: WireTimeline; readonly clipId?: string; readonly clip?: WireClip; readonly sources: WireAsset[]; readonly [key: string]: unknown}
interface GainInputOverrides {readonly message?: string; readonly consent?: Record<string, unknown>; readonly [key: string]: unknown}
export const clipBytesExceptGain = (clip: Record<string, unknown>): string => JSON.stringify(Object.fromEntries(Object.entries(clip).filter(([key]) => key !== 'gain')));

export async function gainWireFixture(t: unknown, protocol: unknown) {
  interface GainFixture {data(path: string): Promise<Record<string, unknown>>; request(...args: unknown[]): Promise<unknown>; model: {plan(value: Record<string, unknown>): void}; send(projectId: string, input: Record<string, unknown>): Promise<{run: {id: string}}>; terminal(projectId: string, requestId: string): Promise<unknown>; proposals(projectId: string, query: string): Promise<{proposals: {runId: string}[]}>; input?: (projectId: string, selection: GainSelection, overrides?: GainInputOverrides) => Promise<Record<string, unknown>>; propose?: (projectId: string, selection: GainSelection, plan?: Record<string, unknown>) => Promise<Record<string, unknown>>}
  const f = await timelineWireFixture(t, protocol) as unknown as GainFixture;
  f.input = async (projectId: string, selection: GainSelection, {message = GAIN_MESSAGE, consent: overrides, ...changes}: GainInputOverrides = {}) => {
    interface GainSnapshot {settings: {configuration: Record<string, unknown>; revision: number}; instanceId: string; revision: number; timelineGainEdit?: {available?: boolean; [key: string]: unknown}; [key: string]: unknown}
    const snapshot = await f.data(chatRoute(projectId) as never) as GainSnapshot, configuration = snapshot.settings.configuration;
    await authorizeHttpSnapshot(((route: string, options: {method: string; input: unknown}) => f.request(route, options)) as never, snapshot as never, AGENT_TIMELINE_GAIN_CONTEXT);
    assert.equal(snapshot.timelineGainEdit?.available, true, JSON.stringify(snapshot.timelineGainEdit));
    const {available, ...capability} = snapshot.timelineGainEdit ?? {};
    const timeline = (selection.timeline ?? selection) as WireTimeline;
    const clipId = selection.clipId ?? selection.clip?.id ?? timeline.clips[0].id;
    const clip = timeline.clips.find(item => item.id === clipId);
    assert.ok(clip, 'fixture requires a saved clip');
    const asset = selection.sources.find(item => item.id === clip.assetId) as WireAsset|undefined;
    assert.ok(asset, 'fixture requires the saved clip source asset');
    const source = {id: asset.id, sha256: asset.sha256, mimeType: asset.mimeType, hasAudio: asset.hasAudio};
    const target = agentTimelineGainTargetFromTimeline(timeline, clipId, source);
    assert.ok(target, 'fixture requires a supported saved audio target');
    return {requestId: randomUUID(), instanceId: snapshot.instanceId, expectedSettingsRevision: snapshot.settings.revision,
      expectedConversationRevision: snapshot.revision, message,
      consent: {destination: deriveAgentEndpoint(configuration as never), protocol: configuration.protocol, model: configuration.model,
        context: AGENT_TIMELINE_GAIN_CONTEXT, projectId, ...capability, timelineId: timeline.id,
        clipId, expectedRevision: timeline.revision, reviewTarget: agentTimelineGainReviewTarget(target), ...overrides}, ...changes};
  };
  f.propose = async (projectId: string, selection: GainSelection, plan: Record<string, unknown> = {}) => {
    f.model.plan({name: GAIN_FUNCTION, arguments: {gain: GAIN_VALUE}, ...plan});
    const input = await f.input!(projectId, selection), sent = await f.send(projectId, input), done = await f.terminal(projectId, String(input.requestId));
    const proposal = (await f.proposals(projectId, '?view=all')).proposals.find(item => item.runId === sent.run.id);
    return {input, sent, done, proposal};
  };
  return f;
}
