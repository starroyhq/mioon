// NoEmit consumer of the actual checked leaf. No ambient module or JavaScript
// barrel declaration stands in for the runtime implementation.
import {AGENT_TIMELINE_GAIN_CONTEXT, AGENT_TIMELINE_GAIN_TOOL, AGENT_TIMELINE_GAIN_DEFINITION_VERSION,
  createAgentTimelineGainContracts, isAgentTimelineGainArguments, isAgentTimelineGainReviewTarget} from '../../packages/contracts/src/agent-timeline-gain.ts';
import type {AgentTimelineGainArguments, AgentTimelineGainSource, AgentTimelineGainTarget, AgentTimelineGainPublicTarget,
  AgentTimelineGainReviewTarget, AgentTimelineGainModelContext, AgentTimelineGainProposal,
  AgentTimelineGainContracts, AgentTimelineGainCanonicalValidators} from '../../packages/contracts/src/agent-timeline-gain.ts';

type IsAny<T> = 0 extends (1 & T) ? true : false;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
  ? (<T>() => T extends B ? 1 : 2) extends (<T>() => T extends A ? 1 : 2) ? true : false : false;
type Expect<T extends true> = T;
type ContextIsExact = Expect<Equal<typeof AGENT_TIMELINE_GAIN_CONTEXT, 'selected_timeline_clip_gain'>>;
type ToolIsExact = Expect<Equal<typeof AGENT_TIMELINE_GAIN_TOOL, 'mioon_propose_timeline_clip_gain'>>;
type DefinitionVersionIsExact = Expect<Equal<typeof AGENT_TIMELINE_GAIN_DEFINITION_VERSION, 3>>;
type ArgumentsAreExact = Expect<Equal<AgentTimelineGainArguments, Readonly<{gain: number}>>>;
type ArgumentsInputIsUnknown = Expect<Equal<Parameters<typeof isAgentTimelineGainArguments>[0], unknown>>;
type TargetIsNotAny = Expect<Equal<IsAny<AgentTimelineGainTarget>, false>>;
type SourceIsNotAny = Expect<Equal<IsAny<AgentTimelineGainSource>, false>>;
type ClipIsNotAny = Expect<Equal<IsAny<AgentTimelineGainTarget['clip']>, false>>;
type ContractsAreCheckedFactory = Expect<Equal<AgentTimelineGainContracts, ReturnType<typeof createAgentTimelineGainContracts>>>;
type TargetKeysAreExact = Expect<Equal<keyof AgentTimelineGainTarget,
  'projectId' | 'timelineId' | 'expectedRevision' | 'fps' | 'width' | 'height' | 'durationFrames' | 'clip' | 'track' | 'source'>>;
type PublicKeysAreExact = Expect<Equal<keyof AgentTimelineGainPublicTarget,
  'projectId' | 'timelineId' | 'clipId' | 'trackId' | 'expectedRevision' | 'clipName' | 'trackName' | 'trackKind' | 'fps' | 'width' | 'height' | 'trackMuted' | 'hasAudio'>>;
type ReviewKeysAreExact = Expect<Equal<keyof AgentTimelineGainReviewTarget, keyof AgentTimelineGainPublicTarget | 'gain'>>;
type SourceKeysAreExact = Expect<Equal<keyof AgentTimelineGainSource, 'id' | 'sha256' | 'mimeType' | 'hasAudio'>>;
type ModelKeysAreExact = Expect<Equal<keyof AgentTimelineGainModelContext, 'clip' | 'track' | 'hasAudio' | 'minGain' | 'maxGain'>>;
type ModelClipKeysAreExact = Expect<Equal<keyof AgentTimelineGainModelContext['clip'], 'name' | 'gain'>>;
type ProposalStatesAreExact = Expect<Equal<AgentTimelineGainProposal['status'], 'pending' | 'rejected' | 'cancelled' | 'approved' | 'dispatching' | 'unknown' | 'applied' | 'failed'>>;
type AppliedNeedsCompletedRun = Expect<Equal<Extract<AgentTimelineGainProposal, {status: 'applied'}>['runStatus'], 'completed'>>;
type AppliedOutcomeIsExact = Expect<Equal<Extract<AgentTimelineGainProposal, {status: 'applied'}>['outcome']['status'], 'applied'>>;
type FailedOutcomeIsExact = Expect<Equal<Extract<AgentTimelineGainProposal, {status: 'failed'}>['outcome']['status'], 'not_applied'>>;
type FactoryResultIsNotAny = Expect<Equal<IsAny<ReturnType<typeof createAgentTimelineGainContracts>>, false>>;
type ProjectionIsNotAny = Expect<Equal<IsAny<ReturnType<AgentTimelineGainContracts['agentTimelineGainTargetFromTimeline']>>, false>>;
type CanonicalInputStaysUnknown = Expect<Equal<Parameters<AgentTimelineGainCanonicalValidators['isTimelineRecord']>[0], unknown>>;

export function consume(contracts: AgentTimelineGainContracts, candidate: unknown, source: AgentTimelineGainSource,
  target: AgentTimelineGainTarget, proposal: AgentTimelineGainProposal): void {
  if (isAgentTimelineGainArguments(candidate)) {
    const gain: number = candidate.gain;
    // @ts-expect-error Model arguments cannot acquire an identifier.
    candidate.clipId;
    // @ts-expect-error The exact reviewed argument is readonly.
    candidate.gain = gain;
  }
  if (isAgentTimelineGainReviewTarget(candidate)) {
    const gain: number = candidate.gain;
    const audio: true = candidate.hasAudio;
    void [gain, audio];
    // @ts-expect-error Consent never exposes a source fingerprint.
    candidate.sha256;
  }
  if (contracts.isAgentTimelineGainProposal(candidate)) {
    const known: AgentTimelineGainProposal = candidate;
    void known;
  }
  const selected: AgentTimelineGainTarget | null = contracts.agentTimelineGainTargetFromTimeline(candidate, 'clip', source);
  const model: AgentTimelineGainModelContext | null = contracts.agentTimelineGainModelContext(target);
  void [selected, model];
  // @ts-expect-error Private saved source identity is immutable.
  target.source.sha256 = 'changed';
  // @ts-expect-error Complete clip preservation includes readonly fade fields.
  target.clip.fadeInFrames = 0;
  // @ts-expect-error There is no move range in this target.
  target.occupiedIntervals;
  // @ts-expect-error A gain source must contain confirmed audio.
  const silentSource: AgentTimelineGainSource = {...source, hasAudio: false};
  // @ts-expect-error Images cannot become gain targets.
  const imageSource: AgentTimelineGainSource = {...source, mimeType: 'image/png'};
  // @ts-expect-error The model schema has only gain.
  const moveArguments: AgentTimelineGainArguments = {gain: 1, startFrame: 30};
  // @ts-expect-error A gain proposal must retain distinct tool provenance.
  const moveTool: AgentTimelineGainProposal['provenance']['toolName'] = 'mioon_propose_timeline_clip_move';
  void [silentSource, imageSource, moveArguments, moveTool];
  switch (proposal.status) {
    case 'pending': case 'rejected': case 'cancelled': {
      const absent: undefined = proposal.approval;
      // @ts-expect-error No unapproved proposal can carry an applied outcome.
      const applied: {status: 'applied'} = proposal.outcome;
      void [absent, applied]; break;
    }
    case 'approved': case 'dispatching': case 'unknown': {
      const completed: 'completed' = proposal.runStatus;
      const requestId: string = proposal.approval.requestId;
      void [completed, requestId]; break;
    }
    case 'applied': {
      const revision: number = proposal.outcome.revision;
      const completed: 'completed' = proposal.runStatus;
      // @ts-expect-error Applied outcomes cannot masquerade as failed rollback codes.
      proposal.outcome.code;
      void [revision, completed]; break;
    }
    case 'failed': {
      const code: string = proposal.outcome.code;
      // @ts-expect-error Failed outcomes do not claim a committed result revision.
      proposal.outcome.revision;
      void code; break;
    }
    default: { const exhaustive: never = proposal; void exhaustive; }
  }
}
