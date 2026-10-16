import {
  OPACITY_ENVELOPE_PROFILE, OPACITY_ENVELOPE_LIMITS, validateOpacityEnvelope, createOpacityEnvelopeEvaluator,
  type OpacityEnvelope, type OpacityEnvelopeEvaluator,
} from '../../packages/contracts/src/timeline-opacity-envelope.ts';
import {createTimelineOpacityCandidateContracts, type OpacityCandidateContext} from '../../packages/contracts/src/timeline-opacity-candidate.ts';
import {captureWorkspaceOpacityCandidateProfile, type WorkspaceOpacityCandidateProfile} from '../../packages/contracts/src/workspace-opacity-candidate.ts';
import {clipDraftOpacityCandidateDiskV3Schema} from '../../packages/contracts/src/local-drafts-opacity-candidate.ts';

type IsAny<T> = 0 extends (1 & T) ? true : false;
const exactProfile: 'mioon-clip-linear-opacity-v1' = OPACITY_ENVELOPE_PROFILE;
const exactLimit: 7 = OPACITY_ENVELOPE_LIMITS.points;
const nonAny: false = false as IsAny<ReturnType<typeof validateOpacityEnvelope>>;
const curve: OpacityEnvelope = {profileId: exactProfile, points: [{frame: 0, opacity: 1}]};
const evaluator: OpacityEnvelopeEvaluator = createOpacityEnvelopeEvaluator({durationFrames: 20, opacityEnvelope: curve});
const value: number = evaluator.atFrame(10);
// @ts-expect-error readonly point list is not a mutable editor buffer
curve.points.push({frame: 1, opacity: 0});
// @ts-expect-error readonly point values cannot be changed by a consumer
curve.points[0]!.opacity = 0;
// @ts-expect-error evaluator operations are immutable
evaluator.atFrame = () => 0;
// @ts-expect-error unsupported curve versions do not widen the current profile
const wrong: OpacityEnvelope = {profileId: 'mioon-clip-linear-opacity-v2', points: []};
const context: OpacityCandidateContext = {trackKind: 'video', durationFrames: 20};
const candidate = createTimelineOpacityCandidateContracts({isTimelineRecord: () => true, validateClipIntent: () => true});
// @ts-expect-error no new history or execution operation family is admitted
candidate.captureIntent('timeline.undo', {}, context);
// @ts-expect-error explicit visual/audio track kind is required
candidate.captureIntent('timeline.clip.update', {}, {});
const workspace: WorkspaceOpacityCandidateProfile = captureWorkspaceOpacityCandidateProfile({schemaVersion: 42, profile: 'ordinary'});
// @ts-expect-error descriptor is immutable and cannot grant a newer runtime role
workspace.schemaVersion = 44;
// @ts-expect-error historical source40 is not an opacity restored43 source
const oldPair: WorkspaceOpacityCandidateProfile = {schemaVersion: 43, sourceSchema: 40, profile: 'restored-local-v10'};
const diskVersion: 3 = clipDraftOpacityCandidateDiskV3Schema.parse({}).version;
void [exactLimit, nonAny, value, wrong, oldPair, diskVersion];
