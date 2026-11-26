import type {Format5Clip, Format5Timeline} from '../../contracts/src/project-format5.ts';
import {clipLayoutBasis, projectClipLayout} from '../../contracts/src/timeline-clip-layout.ts';
import {clipTransitionSides, isClipTransition, type ClipTransitionKind} from '../../contracts/src/timeline-clip-transition.ts';
import type {TimelineTrackRecord} from '../../contracts/src/timeline-replacement.ts';
import {createVolumeEnvelopeEvaluator, VOLUME_ENVELOPE_LIMITS} from '../../contracts/src/timeline-volume-envelope.ts';
import {volumeEnvelopeField} from '../../contracts/src/timeline-volume-envelope-processing.ts';
import type {FcpXmlAsset} from './fcp-xml.ts';

export const PREMIERE_XMEML_VERSION = '5';

type MediaType = 'video' | 'audio';
interface SourceFile {
  id: string;
  asset: FcpXmlAsset;
  duration: number;
  written: boolean;
}
interface Cut {
  kind: ClipTransitionKind;
  before: number;
  after: number;
}
interface TrackClip {
  clip: Format5Clip;
  file: SourceFile;
  attachedSound: boolean;
}

function tag(name: string, content = '', id?: string): string {
  const attribute = id ? ` id="${xmlText(id).replaceAll('"', '&quot;')}"` : '';
  return content ? `<${name}${attribute}>${content}</${name}>` : `<${name}${attribute}/>`;
}

function xmlText(value: string): string {
  return value.replace(/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, '\uFFFD')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('\r', '&#13;');
}

function field(name: string, value: string | number | boolean): string {
  return tag(name, typeof value === 'boolean' ? (value ? 'TRUE' : 'FALSE') : xmlText(String(value)));
}

const fps = 30;
const rate = tag('rate', field('timebase', fps) + field('ntsc', false));
const samples = (content: string): string => tag('samplecharacteristics', content);
const videoSamples = (width: number, height: number): string => samples(rate + field('width', width) + field('height', height) +
  field('anamorphic', false) + field('pixelaspectratio', 'square') + field('fielddominance', 'none'));
const audioSamples = (sampleRate: number): string => samples(field('depth', 16) + field('samplerate', sampleRate));
const endFrame = (clip: Format5Clip): number => clip.startFrame + clip.durationFrames;
const decimal = (value: number): number => Number(value.toFixed(8));
const timecode = tag('timecode', rate + field('frame', 0) + field('displayformat', 'NDF'));

function fileXml(file: SourceFile, timeline: Format5Timeline): string {
  if (file.written) return tag('file', '', file.id);
  file.written = true;
  const {asset} = file;
  const video = asset.hasVideo ? tag('video', videoSamples(asset.width ?? timeline.width, asset.height ?? timeline.height)) : '';
  const channels = asset.audioChannels ?? 2;
  const layout = channels === 1 ? field('layout', 'mono') : channels === 2 ? field('layout', 'stereo') : '';
  const audio = asset.hasAudio ? tag('audio', audioSamples(asset.audioRate ?? 48000) + field('channelcount', channels) + layout) : '';
  return tag('file', field('name', asset.name) + field('pathurl', asset.fileUrl) + rate + field('duration', file.duration) +
    timecode + tag('media', video + audio), file.id);
}

interface Effect {
  name: string;
  effectId: string;
  category: string;
  type: 'filter' | 'motion' | 'transition';
  media: MediaType;
}
function effectXml(effect: Effect, parameters: string): string {
  return tag('effect', field('name', effect.name) + field('effectid', effect.effectId) + field('effectcategory', effect.category) +
    field('effecttype', effect.type) + field('mediatype', effect.media) + parameters);
}

function parameter(id: string, name: string, value: string, keys: readonly {when: number; value: string}[] = []): string {
  const values = keys.length > 1 ? keys.map(key => tag('keyframe', field('when', key.when) + key.value)).join('') : value;
  return tag('parameter', field('parameterid', id) + field('name', name) + values);
}
const numberValue = (value: number): string => field('value', decimal(value));
const filter = (effect: Effect, parameters: string): string => tag('filter', effectXml(effect, parameters));
const motion = {name: 'Basic Motion', effectId: 'basic', category: 'motion', type: 'motion', media: 'video'} as const;
const cropEffect = {name: 'Crop', effectId: 'crop', category: 'motion', type: 'motion', media: 'video'} as const;
const levels = {name: 'Audio Levels', effectId: 'audiolevels', category: 'audiolevels', type: 'filter', media: 'audio'} as const;

function pictureFilters(clip: Format5Clip, asset: FcpXmlAsset, timeline: Format5Timeline, sourceStart: number): string {
  const basis = clipLayoutBasis(clip.layout === undefined ? {} : {layout: clip.layout}, timeline);
  if (!basis) throw new RangeError('Invalid Premiere clip layout basis');
  const horizontal = timeline.width / basis.width, vertical = timeline.height / basis.height;
  const {x, y, width, height} = clip.rect;
  // Untransformed clips can exceed the optional transform profile's frame cap.
  const {rect, transform} = clip.transform === undefined
    ? {rect: {x: x * horizontal, y: y * vertical, width: width * horizontal, height: height * vertical}, transform: null}
    : projectClipLayout(clip, timeline);
  const crop = transform?.crop;
  const visibleWidth = (asset.width ?? timeline.width) * (1 - (crop?.left ?? 0) - (crop?.right ?? 0));
  const visibleHeight = (asset.height ?? timeline.height) * (1 - (crop?.top ?? 0) - (crop?.bottom ?? 0));
  const fit = 100 * Math.min(rect.width / visibleWidth, rect.height / visibleHeight);
  const xOffset = rect.x + (rect.width - timeline.width) / 2;
  const yOffset = rect.y + (rect.height - timeline.height) / 2;
  const points = transform?.keyframes ?? [{frame: 0, x: 0, y: 0, scale: 1}];
  const first = points[0]!;
  const position = (point: {x: number; y: number}): string => tag('value',
    field('horiz', decimal((xOffset + point.x) / timeline.width)) + field('vert', decimal((yOffset + point.y) / timeline.height)));
  const scale = (point: {scale: number}): string => numberValue(point.scale * fit);
  const rotation = transform?.rotation ?? 0;
  const held = first.frame > 0 && points.length > 1 ? [{...first, frame: 0}, ...points] : points;
  const keys = (project: (point: typeof first) => string) => held.map(point => ({when: sourceStart + point.frame, value: project(point)}));
  const adjustments = held.length > 1 || first.x + xOffset !== 0 || first.y + yOffset !== 0 || first.scale * fit !== 100 || rotation !== 0
    ? filter(motion, parameter('center', 'Center', position(first), keys(position)) + parameter('scale', 'Scale', scale(first), keys(scale)) +
      parameter('rotation', 'Rotation', numberValue(rotation))) : '';
  const cropParameters = crop && Object.entries(crop).filter(([, value]) => value > 0)
    .map(([edge, value]) => parameter(edge, edge[0]!.toUpperCase() + edge.slice(1), numberValue(value * 100))).join('');
  return adjustments + (cropParameters ? filter(cropEffect, cropParameters) : '');
}

function audioFilters(clip: Format5Clip, track: TimelineTrackRecord): string {
  const level = (value: number, keys?: readonly {when: number; value: string}[]) =>
    filter(levels, parameter('level', 'Level', numberValue(value), keys));
  // XMEML Audio Levels stores linear gain. This is the equivalent of −96 dB.
  if (clip.muted || track.muted || clip.gain === 0) return level(10 ** (-96 / 20));
  const envelope = clip.volumeEnvelope === undefined ? undefined : volumeEnvelopeField(clip).volumeEnvelope;
  const fadeIn = Number(clip.fadeInFrames ?? 0), fadeOut = Number(clip.fadeOutFrames ?? 0);
  if (!envelope && !fadeIn && !fadeOut) return clip.gain === 1 ? '' : level(clip.gain);
  const evaluator = envelope && createVolumeEnvelopeEvaluator({durationFrames: clip.durationFrames, volumeEnvelope: envelope});
  const fadeOutStart = clip.durationFrames - fadeOut;
  // Mioon's overlapping crossfades are persisted as these same envelopes on
  // two tracks. Combining fades here preserves their independent endpoints.
  const frames = [...new Set([0, fadeIn, fadeOutStart, clip.durationFrames, ...(envelope?.points.map(point => point.frame) ?? [])])]
    .sort((left, right) => left - right);
  const keys = frames.map(frame => {
    const fade = frame < fadeIn ? frame / fadeIn : frame > fadeOutStart ? (clip.durationFrames - frame) / fadeOut : 1;
    const multiplier = evaluator?.limitAtSample(frame * VOLUME_ENVELOPE_LIMITS.samplesPerFrame) ?? 1;
    return {when: clip.sourceInFrame + frame, value: numberValue(clip.gain * multiplier * fade)};
  });
  return level(clip.gain, keys);
}

const transitionEffects = {
  dissolve: {name: 'Cross Dissolve', effectId: 'Cross Dissolve', category: 'Dissolve', parameters: ''},
  dipToBlack: {name: 'Dip to Black', effectId: 'Dip to Color Dissolve', category: 'Dissolve',
    parameters: parameter('color', 'Color', tag('value', field('red', 0) + field('green', 0) + field('blue', 0)))},
  wipeLeft: {name: 'Wipe', effectId: 'Edge Wipe', category: 'Wipe', parameters: field('wipecode', 1) + field('reverse', true)},
  wipeRight: {name: 'Wipe', effectId: 'Edge Wipe', category: 'Wipe', parameters: field('wipecode', 1) + field('reverse', false)},
  pushLeft: {name: 'Push', effectId: 'Push', category: 'Slide', parameters: field('reverse', true)},
  pushRight: {name: 'Push', effectId: 'Push', category: 'Slide', parameters: field('reverse', false)},
} as const;

function transitionXml(cut: Cut, at: number): string {
  const {parameters, ...effect} = transitionEffects[cut.kind];
  return tag('transitionitem', rate + field('start', at - cut.before) + field('end', at + cut.after) + field('alignment', 'center') +
    effectXml({...effect, type: 'transition', media: 'video'}, field('startratio', 0) + field('endratio', 1) + parameters));
}

const clipId = (clip: Format5Clip, kind: MediaType): string => `${kind}-${clip.id}`;
function links(clip: Format5Clip): string {
  return tag('link', field('linkclipref', clipId(clip, 'video'))) + tag('link', field('linkclipref', clipId(clip, 'audio')));
}

export function serializePremiereXml({timeline, projectName, assets}: {
  readonly timeline: Format5Timeline;
  readonly projectName: string;
  readonly assets: ReadonlyMap<string, FcpXmlAsset>;
}): string {
  if (timeline.fps !== fps) throw new RangeError('Premiere export requires the Format 5 30 fps timebase');
  const tracks = [...timeline.tracks].sort((left, right) => left.orderIndex - right.orderIndex);
  if (!tracks.some(track => track.id === timeline.mainTrack.trackId && track.kind === 'video')) {
    throw new RangeError('Premiere export requires a primary video track');
  }
  const clips = new Map<string, Format5Clip[]>(tracks.map(track => [track.id, []]));
  for (const clip of [...timeline.clips].sort((left, right) => left.startFrame - right.startFrame)) {
    clips.get(clip.trackId)?.push(clip);
  }
  const files = new Map<string, SourceFile>();
  const trackClips = tracks.map(track => {
    const items: TrackClip[] = [];
    for (const clip of clips.get(track.id)!) {
      const asset = clip.sourceState === 'ready' && clip.assetId ? assets.get(clip.assetId) : undefined;
      if (!asset || (track.kind === 'video' ? !asset.hasVideo : !asset.hasAudio)) continue;
      // Files copied by hash share a path. Keep separate definitions if asset
      // rows disagree about whether those bytes are still, video or audio.
      const kind = asset.isStill ? 'still' : asset.hasVideo ? 'video' : 'audio';
      const fileKey = JSON.stringify([asset.fileUrl, kind]);
      let file = files.get(fileKey);
      if (!file) {
        file = {id: `file-${files.size + 1}`, asset, duration: asset.durationFrames, written: false};
        files.set(fileKey, file);
      } else {
        // Duplicate asset rows can contribute different source metadata to the
        // same copied media. Keep the media components needed by all uses.
        file.asset = {...file.asset, hasVideo: file.asset.hasVideo || asset.hasVideo, hasAudio: file.asset.hasAudio || asset.hasAudio,
          width: file.asset.width ?? asset.width, height: file.asset.height ?? asset.height,
          audioChannels: file.asset.audioChannels ?? asset.audioChannels, audioRate: file.asset.audioRate ?? asset.audioRate};
        file.duration = Math.max(file.duration, asset.durationFrames);
      }
      const attachedSound = track.kind === 'video' && asset.hasAudio;
      items.push({clip, file, attachedSound});
    }
    return {track, items};
  });
  const cuts = new Map<string, Cut>();
  const exits = new Map<string, Cut>();
  for (const {track, items} of trackClips) {
    if (track.kind !== 'video') continue;
    for (const [index, item] of items.entries()) {
      const previous = items[index - 1];
      const transition = item.clip.transitionIn;
      if (!previous || endFrame(previous.clip) !== item.clip.startFrame || !transition || !isClipTransition(transition)) continue;
      const cut = {kind: transition.kind, ...clipTransitionSides(transition.durationFrames)};
      const previousIntro = cuts.get(previous.clip.id)?.after ?? 0;
      const outgoingSourceEnd = previous.clip.sourceInFrame + previous.clip.durationFrames + cut.after;
      if (previousIntro + cut.before > previous.clip.durationFrames || cut.after > item.clip.durationFrames ||
          (!item.file.asset.isStill && cut.before > item.clip.sourceInFrame) ||
          (!previous.file.asset.isStill && outgoingSourceEnd > previous.file.duration)) continue;
      cuts.set(item.clip.id, cut);
      exits.set(previous.clip.id, cut);
    }
  }
  function sourceStart(item: TrackClip): number {
    const before = cuts.get(item.clip.id)?.before ?? 0;
    return item.file.asset.isStill ? Math.max(before, item.clip.sourceInFrame) : item.clip.sourceInFrame;
  }
  for (const {items} of trackClips) {
    for (const item of items) {
      const out = sourceStart(item) + item.clip.durationFrames + (exits.get(item.clip.id)?.after ?? 0);
      item.file.duration = Math.max(item.file.duration, out);
    }
  }
  function renderClip(item: TrackClip, track: TimelineTrackRecord, media: MediaType): string {
    const {clip, file} = item;
    const cut = media === 'video' ? cuts.get(clip.id) : undefined;
    const exit = media === 'video' ? exits.get(clip.id) : undefined;
    const source = media === 'video' ? sourceStart(item) : clip.sourceInFrame;
    // XMEML uses -1 beside a transition. Include the source handles so the
    // importer can infer its boundary without moving the underlying edit.
    const start = cut ? -1 : clip.startFrame;
    const end = exit ? -1 : endFrame(clip);
    const inFrame = source - (cut?.before ?? 0);
    const outFrame = source + clip.durationFrames + (exit?.after ?? 0);
    const filters = media === 'video' ? pictureFilters(clip, file.asset, timeline, source) : audioFilters(clip, track);
    const rendered = tag('clipitem', field('name', clip.name) + field('enabled', true) + field('duration', file.duration) + rate +
      field('start', start) + field('end', end) + field('in', inFrame) + field('out', outFrame) +
      (file.asset.isStill ? field('stillframe', true) : '') + fileXml(file, timeline) +
      tag('sourcetrack', field('mediatype', media) + (media === 'audio' ? field('trackindex', 1) : '')) +
      (item.attachedSound ? links(clip) : '') + filters, clipId(clip, media));
    return (cut ? transitionXml(cut, clip.startFrame) : '') + rendered;
  }

  const video = trackClips.filter(({track}) => track.kind === 'video').map(({track, items}) =>
    tag('track', items.map(item => renderClip(item, track, 'video')).join('') + field('enabled', !track.hidden) + field('locked', false))).join('');
  const audio = trackClips.map(({track, items}) => {
    const sounding = track.kind === 'video' ? items.filter(item => item.attachedSound) : items;
    if (track.kind === 'video' && !sounding.length) return '';
    return tag('track', sounding.map(item => renderClip(item, track, 'audio')).join('') + field('enabled', true) + field('locked', false));
  }).join('');
  const mix = tag('outputs', tag('group', field('index', 1) + field('numchannels', 2) + field('downmix', 0) +
    tag('channel', field('index', 1)) + tag('channel', field('index', 2))));
  const sequence = tag('sequence', field('name', projectName) + field('duration', timeline.durationFrames) + rate + timecode +
    tag('media', tag('video', tag('format', videoSamples(timeline.width, timeline.height)) + video) +
      tag('audio', tag('format', audioSamples(48000)) + field('channelcount', 2) + mix + audio)), 'sequence-1');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n<xmeml version="${PREMIERE_XMEML_VERSION}">${sequence}</xmeml>\n`;
}
