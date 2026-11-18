/** Synthetic editing scenes for the UI-E1 static fixture. No application host,
 * project store or RPC client participates; media files are repository examples
 * served by the fixture's own loopback server. */

export type FixtureScenario = 'main' | 'copy-move' | 'removed';

export const FIXTURE_PROJECT_ID = '11111111-1111-4111-8111-111111111111';
export const FIXTURE_TIMELINE_ID = '33333333-3333-4333-8333-333333333333';

const assetId = (n: number): string => `22222222-2222-4222-8222-${String(n).padStart(12, '0')}`;

export const ASSET_IDS = {
  sceneA: assetId(1), sceneB: assetId(2), sceneC: assetId(3), overlay: assetId(4), soundBed: assetId(5),
} as const;

export interface FixtureMediaFile {
  readonly path: string;
  readonly contentType: string;
}

/** Repository examples served for media URLs. The screenshot baseline uses image
 * clips instead so its pixels do not depend on a video decoder. */
export const FIXTURE_MEDIA: Readonly<Record<string, FixtureMediaFile>> = Object.freeze({
  [ASSET_IDS.sceneA]: {path: 'examples/timeline-synthetic/scene-a.mp4', contentType: 'video/mp4'},
  [ASSET_IDS.sceneB]: {path: 'examples/timeline-synthetic/scene-b.mp4', contentType: 'video/mp4'},
  [ASSET_IDS.sceneC]: {path: 'examples/timeline-synthetic/scene-a.mp4', contentType: 'video/mp4'},
  [ASSET_IDS.overlay]: {path: 'examples/timeline-synthetic/overlay-star.png', contentType: 'image/png'},
  [ASSET_IDS.soundBed]: {path: 'examples/timeline-synthetic/sound-bed.wav', contentType: 'audio/wav'},
});

export const FIXTURE_IMAGE_MEDIA: Readonly<Record<string, FixtureMediaFile>> = Object.freeze({
  [ASSET_IDS.sceneA]: {path: 'examples/timeline-synthetic/scene-a.png', contentType: 'image/png'},
  [ASSET_IDS.sceneB]: {path: 'examples/timeline-synthetic/scene-b.png', contentType: 'image/png'},
  [ASSET_IDS.sceneC]: {path: 'examples/timeline-synthetic/scene-b.png', contentType: 'image/png'},
  [ASSET_IDS.overlay]: {path: 'examples/timeline-synthetic/overlay-star.png', contentType: 'image/png'},
  [ASSET_IDS.soundBed]: {path: 'examples/timeline-synthetic/sound-bed.wav', contentType: 'audio/wav'},
});

export interface FixtureVersion {readonly id: string; readonly number: number}
export interface FixtureShotSource {
  readonly kind: 'shot';
  readonly nodeId: string;
  readonly segmentGroupId: string;
  readonly versionMode: 'follow' | 'locked';
  readonly boardVersion: FixtureVersion | null;
  readonly appliedVersion: FixtureVersion | null;
  readonly number: string;
  readonly name: string;
}
export interface FixtureMediaSource {
  readonly kind: 'media';
  readonly nodeId: string;
  readonly segmentGroupId: string;
}
export type FixtureSequenceSource = FixtureShotSource | FixtureMediaSource;

export interface FixtureClip {
  readonly id: string;
  readonly trackId: string;
  readonly assetId: string | null;
  readonly name: string;
  readonly startFrame: number;
  readonly durationFrames: number;
  readonly sourceInFrame: number;
  readonly gain: number;
  readonly sequenceSource?: FixtureSequenceSource;
  readonly sourceState?: 'ready' | 'placeholder';
  readonly anchor?: {readonly clipId: string; readonly offsetFrames: number} | null;
}
export interface FixtureCue {
  readonly id: string;
  readonly text: string;
  readonly startFrame: number;
  readonly durationFrames: number;
  readonly anchor?: {readonly clipId: string; readonly offsetFrames: number} | null;
}
export interface FixtureAsset {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly mimeType: string;
  readonly duration: number | null;
  readonly hasAudio?: boolean;
}
export interface FixtureTrack {
  readonly id: string;
  readonly kind: 'video' | 'audio';
  readonly name: string;
  readonly orderIndex: number;
  readonly hidden: boolean;
  readonly muted: boolean;
}
export interface FixtureTimeline {
  readonly id: string;
  readonly projectId: string;
  readonly revision: number;
  readonly fps: number;
  readonly width: number;
  readonly height: number;
  readonly durationFrames: number;
  readonly tracks: readonly FixtureTrack[];
  readonly clips: readonly FixtureClip[];
  readonly subtitles: {readonly profileId: string; readonly cues: readonly FixtureCue[]};
}

const VERSION_1 = {id: '44444444-4444-4444-8444-000000000001', number: 1} as const;
const VERSION_2 = {id: '44444444-4444-4444-8444-000000000002', number: 2} as const;

const shotSource = (number: number, name: string, versionMode: 'follow' | 'locked',
  boardVersion: FixtureVersion | null, appliedVersion: FixtureVersion | null): FixtureShotSource => ({
  kind: 'shot', nodeId: `55555555-5555-4555-8555-00000000000${number}`,
  segmentGroupId: `66666666-6666-4666-8666-00000000000${number}`,
  versionMode, boardVersion, appliedVersion, number: `0${number}`, name,
});

const SHOT_1 = shotSource(1, '城市夜景 · 推镜', 'follow', VERSION_1, VERSION_1);
const SHOT_2 = shotSource(2, '窗口剪影', 'follow', VERSION_2, VERSION_1);
const SHOT_3 = shotSource(3, '霓虹街头', 'locked', null, VERSION_1);
const SHOT_4 = shotSource(4, '海岸航拍', 'follow', null, null);

const MAIN_CLIP_1: FixtureClip = {id: 'clip-01', trackId: 'track-main', assetId: ASSET_IDS.sceneA, name: '01 城市夜景 · 推镜',
  startFrame: 0, durationFrames: 180, sourceInFrame: 0, gain: 1, sourceState: 'ready',
  sequenceSource: {kind: 'media', nodeId: '77777777-7777-4777-8777-000000000001', segmentGroupId: '88888888-8888-4888-8888-000000000001'}};
const MAIN_CLIP_2: FixtureClip = {id: 'clip-02', trackId: 'track-main', assetId: ASSET_IDS.sceneB, name: '02 窗口剪影',
  startFrame: 180, durationFrames: 210, sourceInFrame: 42, gain: 1, sourceState: 'ready', sequenceSource: SHOT_2};
const MAIN_CLIP_3: FixtureClip = {id: 'clip-03', trackId: 'track-main', assetId: ASSET_IDS.sceneC, name: '03 霓虹街头',
  startFrame: 390, durationFrames: 210, sourceInFrame: 0, gain: 1, sourceState: 'ready', sequenceSource: SHOT_3};
const MAIN_CLIP_4: FixtureClip = {id: 'clip-04', trackId: 'track-main', assetId: null, name: '04 海岸航拍',
  startFrame: 600, durationFrames: 120, sourceInFrame: 0, gain: 1, sourceState: 'placeholder', sequenceSource: SHOT_4};
const OVERLAY_CLIP: FixtureClip = {id: 'clip-overlay', trackId: 'track-overlay', assetId: ASSET_IDS.overlay,
  name: 'overlay-star.png', startFrame: 510, durationFrames: 120, sourceInFrame: 0, gain: 1, sourceState: 'ready',
  anchor: {clipId: 'clip-03', offsetFrames: 120}};
const AUDIO_CLIP: FixtureClip = {id: 'clip-audio', trackId: 'track-audio', assetId: ASSET_IDS.soundBed,
  name: 'sound-bed.wav', startFrame: 0, durationFrames: 720, sourceInFrame: 0, gain: 1, sourceState: 'ready'};

const TRACKS: readonly FixtureTrack[] = [
  {id: 'track-main', kind: 'video', name: 'Video 1', orderIndex: 0, hidden: false, muted: false},
  {id: 'track-overlay', kind: 'video', name: 'Video 2', orderIndex: 1, hidden: false, muted: false},
  {id: 'track-audio', kind: 'audio', name: 'Audio 1', orderIndex: 0, hidden: false, muted: false},
];

const CUE_1: FixtureCue = {id: 'cue-1', text: '雨后的城市街道', startFrame: 30, durationFrames: 150,
  anchor: {clipId: 'clip-01', offsetFrames: 30}};
const CUE_2_ATTACHED: FixtureCue = {id: 'cue-2', text: '镜头缓慢推进', startFrame: 300, durationFrames: 150,
  anchor: {clipId: 'clip-02', offsetFrames: 120}};
const CUE_2_DETACHED: FixtureCue = {id: 'cue-2', text: '镜头缓慢推进', startFrame: 300, durationFrames: 150, anchor: null};

function timeline(clips: readonly FixtureClip[], cues: readonly FixtureCue[], durationFrames: number): FixtureTimeline {
  return {id: FIXTURE_TIMELINE_ID, projectId: FIXTURE_PROJECT_ID, revision: 7, fps: 30, width: 1080, height: 1920,
    durationFrames, tracks: TRACKS, clips, subtitles: {profileId: 'bottom_cjk_v1', cues}};
}

export function fixtureTimeline(scenario: FixtureScenario): FixtureTimeline {
  if (scenario === 'removed') {
    const shifted3: FixtureClip = {...MAIN_CLIP_3, startFrame: 180};
    const shifted4: FixtureClip = {...MAIN_CLIP_4, startFrame: 390};
    const shiftedOverlay: FixtureClip = {...OVERLAY_CLIP, startFrame: 300};
    return timeline([MAIN_CLIP_1, shifted3, shifted4, shiftedOverlay, AUDIO_CLIP], [CUE_1, CUE_2_DETACHED], 600);
  }
  return timeline([MAIN_CLIP_1, MAIN_CLIP_2, MAIN_CLIP_3, MAIN_CLIP_4, OVERLAY_CLIP, AUDIO_CLIP], [CUE_1, CUE_2_ATTACHED], 720);
}

export function fixtureAssets(imageOnly: boolean): readonly FixtureAsset[] {
  if (imageOnly) {
    return [
      {id: ASSET_IDS.sceneA, projectId: FIXTURE_PROJECT_ID, name: 'scene-a.png', mimeType: 'image/png', duration: null},
      {id: ASSET_IDS.sceneB, projectId: FIXTURE_PROJECT_ID, name: 'scene-b.png', mimeType: 'image/png', duration: null},
      {id: ASSET_IDS.sceneC, projectId: FIXTURE_PROJECT_ID, name: 'scene-b.png', mimeType: 'image/png', duration: null},
      {id: ASSET_IDS.overlay, projectId: FIXTURE_PROJECT_ID, name: 'overlay-star.png', mimeType: 'image/png', duration: null},
      {id: ASSET_IDS.soundBed, projectId: FIXTURE_PROJECT_ID, name: 'sound-bed.wav', mimeType: 'audio/wav', duration: 24, hasAudio: true},
    ];
  }
  return [
    {id: ASSET_IDS.sceneA, projectId: FIXTURE_PROJECT_ID, name: 'scene-a.mp4', mimeType: 'video/mp4', duration: 10, hasAudio: true},
    {id: ASSET_IDS.sceneB, projectId: FIXTURE_PROJECT_ID, name: 'scene-b.mp4', mimeType: 'video/mp4', duration: 10, hasAudio: true},
    {id: ASSET_IDS.sceneC, projectId: FIXTURE_PROJECT_ID, name: 'scene-c.mp4', mimeType: 'video/mp4', duration: 10, hasAudio: true},
    {id: ASSET_IDS.overlay, projectId: FIXTURE_PROJECT_ID, name: 'overlay-star.png', mimeType: 'image/png', duration: null},
    {id: ASSET_IDS.soundBed, projectId: FIXTURE_PROJECT_ID, name: 'sound-bed.wav', mimeType: 'audio/wav', duration: 24, hasAudio: true},
  ] as readonly FixtureAsset[];
}

/** Copy-and-move request bound when the synthetic dialog is shown. */
export const COPY_MOVE_REQUEST = {
  clipId: 'clip-02', nodeId: SHOT_2.nodeId, segmentGroupId: SHOT_2.segmentGroupId,
  targetTrackId: 'track-overlay', targetStartFrame: 630, timelineRevision: 7,
} as const;

/** The undo notice used after the removed scenario. */
export const REMOVED_SHOT_NAME = '02 窗口剪影';

export const FIXTURE_PLAYHEAD = 252;
export const FIXTURE_SELECTED_CLIP_ID = 'clip-02';

const svgData = (width: number, height: number, body: string): string =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`)}`;

/** Synthetic artwork so screenshots never depend on decoded video frames. */
export function fixtureThumbnails(): readonly string[] {
  const palettes = [['#1E3A5F', '#5B9BE6'], ['#1F4A45', '#4FC1B0'], ['#33295C', '#9C8CFF'], ['#2a2d33', '#F2A93B']] as const;
  return Array.from({length: 8}, (_, index) => {
    const [background, accent] = palettes[index % palettes.length]!;
    const cx = 40 + (index % 3) * 34, cy = 30 + (index % 2) * 26;
    return svgData(160, 90, `<rect width="160" height="90" fill="${background}"/><circle cx="${cx}" cy="${cy}" r="14" fill="${accent}" opacity="0.85"/><path d="M0 78 L60 52 L104 66 L160 40 V90 H0 Z" fill="${accent}" opacity="0.28"/>`);
  });
}

/** Portrait monitor content for the synthetic preview shell. */
export function fixturePreview(): string {
  return svgData(360, 640, `<rect width="360" height="640" fill="#0B0C0E"/><rect width="360" height="210" fill="#0F1013"/><rect y="430" width="360" height="210" fill="#0F1013"/><circle cx="180" cy="320" r="118" fill="none" stroke="#7D828C" opacity="0.45"/><circle cx="180" cy="320" r="62" fill="#F2B27B" opacity="0.9"/><circle cx="180" cy="320" r="62" fill="none" stroke="#F2B27B" opacity="0.35" stroke-width="18"/>`);
}
