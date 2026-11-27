import {clipLayoutBasis, projectClipLayout} from '../../contracts/src/timeline-clip-layout.ts';
import {clipTransitionSides, isClipTransition, type ClipTransition, type ClipTransitionKind} from '../../contracts/src/timeline-clip-transition.ts';
import {volumeEnvelopeField} from '../../contracts/src/timeline-volume-envelope-processing.ts';
import type {Format5Anchor, Format5Clip, Format5Timeline} from '../../contracts/src/project-format5.ts';
import type {TimelineTrackRecord} from '../../contracts/src/timeline-replacement.ts';
import {hasEditorExportSpeed, type EditorExportSpeed} from './editor-export-speed.ts';

export interface FcpXmlAsset {
  readonly id: string;
  readonly name: string;
  readonly fileUrl: string;
  readonly hasVideo: boolean;
  readonly hasAudio: boolean;
  readonly durationFrames: number;
  readonly width?: number;
  readonly height?: number;
  readonly audioChannels?: number;
  readonly audioRate?: number;
  readonly isStill?: boolean;
  readonly sourceFps?: number;
  readonly sourceFpsDenominator?: number;
}

type Attribute = string | number | undefined;
type Attributes = Readonly<Record<string, Attribute>>;
const fps = 30;
const rec709 = '1-1-1 (Rec. 709)';
const fullFrame = {frame: 0, x: 0, y: 0, scale: 1};

function xmlText(value: string): string {
  return value.replace(/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, '\uFFFD')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function element(name: string, attributes: Attributes = {}, body = ''): string {
  let head = '<' + name;
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined) continue;
    const escaped = xmlText(String(value)).replaceAll('"', '&quot;')
      .replaceAll('\t', '&#9;').replaceAll('\n', '&#10;').replaceAll('\r', '&#13;');
    head += ' ' + key + '="' + escaped + '"';
  }
  return head + (body ? '>' + body + '</' + name + '>' : '/>');
}

function frameTime(frames: number): string {
  return frames % fps === 0 ? `${frames / fps}s` : `${frames}/${fps}s`;
}

const retimeSampling = {off: 'floor', blend: 'frame-blending', optical: 'optical-flow'} as const;

function timeMapXml(speed: EditorExportSpeed): string {
  const unitsPerFrame = 1_000_000;
  const points = speed.points.map(({outputFrame, sourceFrame}) => element('timept', {
    time: frameTime(outputFrame),
    value: Number.isInteger(sourceFrame) ? frameTime(sourceFrame) :
      `${Math.round(sourceFrame * unitsPerFrame)}/${fps * unitsPerFrame}s`,
    interp: 'linear',
  })).join('');
  return element('timeMap', {frameSampling: retimeSampling[speed.interpolation], preservesPitch: speed.pitchShift ? 0 : 1}, points);
}

const decimal = (value: number): string => String(Number(value.toFixed(6)));
const pair = (x: number, y: number): string => `${decimal(x)} ${decimal(y)}`;
const endFrame = (clip: Format5Clip): number => clip.startFrame + clip.durationFrames;
const compareTime = (a: {startFrame: number}, b: {startFrame: number}): number => a.startFrame - b.startFrame;

interface AssetResource {
  id: string;
  format: string;
  asset: FcpXmlAsset;
  usedFrames: number;
}

interface Effect {
  name: string;
  uid: string;
}

const dissolve = {name: 'Cross Dissolve', uid: 'FxPlug:4731E73A-8DAC-4113-9A30-AE85B1761265'};
const dip = {name: 'Dip to Color', uid: 'FxPlug:F779C565-486D-4633-8035-0374B4DB8F5C'};
const wipe = {name: 'Edge Wipe', uid: 'FxPlug:857E2FBA-98DB-411B-A88C-CE6ABC1F65D8'};
const push = {name: 'Push', uid: '.../Transitions.localized/Movements.localized/Push.localized/Push.motr'};
const transitions: Record<ClipTransitionKind, {effect: Effect; parameters?: readonly Attributes[]}> = {
  dissolve: {effect: dissolve},
  dipToBlack: {effect: dip, parameters: [{name: 'Color', value: '0 0 0 1'}]},
  wipeLeft: {effect: wipe, parameters: [{name: 'Angle', value: '180'}]},
  wipeRight: {effect: wipe, parameters: [{name: 'Angle', value: '0'}]},
  // Values come from the named direction entries of the built-in Motion template.
  pushLeft: {effect: push, parameters: [{name: 'Direction', value: '3'}]},
  pushRight: {effect: push, parameters: [{name: 'Direction', value: '0'}]},
};

export function fcpxmlTransitions(timeline: Format5Timeline, assets: ReadonlyMap<string, unknown>) {
  const cuts = new Map<string, ClipTransition>();
  const previousByTrack = new Map<string, Format5Clip>();
  const hasResource = (clip: Format5Clip) => clip.sourceState === 'ready' && clip.assetId && assets.has(clip.assetId);
  for (const clip of [...timeline.clips].sort(compareTime)) {
    const previous = previousByTrack.get(clip.trackId);
    previousByTrack.set(clip.trackId, clip);
    const transition = clip.transitionIn;
    // Retime maps currently cover the visible output only. FCP transitions
    // can ask for material outside that range, including across a hold.
    if (previous && endFrame(previous) === clip.startFrame && hasResource(previous) && hasResource(clip) &&
        transition && isClipTransition(transition) &&
        !hasEditorExportSpeed(previous, timeline.fps) && !hasEditorExportSpeed(clip, timeline.fps)) cuts.set(clip.id, transition);
  }
  return cuts;
}

interface ConnectedItem {startFrame: number; lane: number; xml: string}
interface PrimaryItem {
  startFrame: number;
  durationFrames: number;
  sourceInFrame: number;
  clip?: Format5Clip;
  connected: ConnectedItem[];
}

function animatedParameter(name: string, start: number, points: readonly {frame: number; value: string}[]): string {
  return element('param', {name}, element('keyframeAnimation', {}, points.map(point => element('keyframe', {
    time: frameTime(start + point.frame), value: point.value, interp: 'linear', curve: 'linear',
  })).join('')));
}

function pictureAdjustments(clip: Format5Clip, asset: FcpXmlAsset, track: TimelineTrackRecord, timeline: Format5Timeline): string {
  const basis = clipLayoutBasis(clip.layout === undefined ? {} : {layout: clip.layout}, timeline);
  if (!basis) throw new RangeError('Invalid FCPXML clip layout basis');
  const xRatio = timeline.width / basis.width, yRatio = timeline.height / basis.height;
  const {x, y, width, height} = clip.rect;
  // Long Format 5 clips can exceed the optional transform feature's frame limit.
  const {rect, transform} = clip.transform === undefined
    ? {rect: {x: x * xRatio, y: y * yRatio, width: width * xRatio, height: height * yRatio}, transform: null}
    : projectClipLayout(clip, timeline);
  const sourceWidth = asset.width ?? timeline.width, sourceHeight = asset.height ?? timeline.height;
  const crop = transform?.crop;
  const visibleWidth = sourceWidth * (1 - (crop?.left ?? 0) - (crop?.right ?? 0));
  const visibleHeight = sourceHeight * (1 - (crop?.top ?? 0) - (crop?.bottom ?? 0));
  const sequenceFit = Math.min(timeline.width / visibleWidth, timeline.height / visibleHeight);
  const rectFit = Math.min(rect.width / visibleWidth, rect.height / visibleHeight);
  const baseScale = rectFit / sequenceFit;
  const centerX = rect.x + (rect.width - timeline.width) / 2;
  const centerY = rect.y + (rect.height - timeline.height) / 2;
  const position = (point: {x: number; y: number}): string =>
    pair((centerX + point.x) * 100 / timeline.height, -(centerY + point.y) * 100 / timeline.height);
  const scale = (point: {scale: number}): string => pair(point.scale * baseScale, point.scale * baseScale);

  let xml = '';
  if (crop && Object.values(crop).some(edge => edge > 0)) {
    xml += element('adjust-crop', {mode: 'crop'}, element('crop-rect', {
      left: decimal(crop.left * 100 * sourceWidth / sourceHeight), top: decimal(crop.top * 100),
      right: decimal(crop.right * 100 * sourceWidth / sourceHeight), bottom: decimal(crop.bottom * 100),
    }));
  }

  const points = transform?.keyframes ?? [fullFrame];
  const first = points[0]!;
  const rotation = -(transform?.rotation ?? 0);
  let parameters = '';
  if (points.length > 1) {
    // FCP keyframes use the clip's source time. Mioon stores clip-relative
    // frames and holds the nearest keyframe on either side of the animation.
    const held = first.frame === 0 ? points : [{...first, frame: 0}, ...points];
    parameters += animatedParameter('position', clip.sourceInFrame, held.map(point => ({frame: point.frame, value: position(point)})));
    parameters += animatedParameter('scale', clip.sourceInFrame, held.map(point => ({frame: point.frame, value: scale(point)})));
  }
  if (parameters || position(first) !== '0 0' || scale(first) !== '1 1' || rotation !== 0) {
    xml += element('adjust-transform', {position: position(first), scale: scale(first), rotation: decimal(rotation)}, parameters);
  }
  // Turning off the whole A/V clip would silence its audio as well.
  if (track.hidden) xml += element('adjust-blend', {amount: 0});
  return xml;
}

function decibels(multiplier: number): string {
  return `${decimal(multiplier > 0 ? Math.max(-96, 20 * Math.log10(multiplier)) : -96)}dB`;
}

function audioAdjustments(clip: Format5Clip, track: TimelineTrackRecord): string {
  if (clip.muted || track.muted || clip.gain === 0) return element('adjust-volume', {amount: '-96dB'});
  const volumeEnvelope = clip.volumeEnvelope === undefined ? undefined : volumeEnvelopeField(clip).volumeEnvelope;
  const first = volumeEnvelope?.points[0]?.multiplier ?? 1;
  const fadeIn = Number(clip.fadeInFrames ?? 0), fadeOut = Number(clip.fadeOutFrames ?? 0);
  let parameter = '';
  if (fadeIn > 0) parameter += element('fadeIn', {type: 'linear', duration: frameTime(fadeIn)});
  if (fadeOut > 0) parameter += element('fadeOut', {type: 'linear', duration: frameTime(fadeOut)});
  if (volumeEnvelope) parameter += element('keyframeAnimation', {}, volumeEnvelope.points.map(point => element('keyframe', {
    time: frameTime(clip.sourceInFrame + point.frame), value: decibels(clip.gain * point.multiplier), interp: 'linear', curve: 'linear',
  })).join(''));
  if (!parameter && clip.gain === 1) return '';
  return element('adjust-volume', {amount: decibels(clip.gain * first)}, parameter && element('param', {name: 'amount'}, parameter));
}

function audioRole(value: unknown): string | undefined {
  if (value === 'human') return 'dialogue';
  if (value === 'sfx') return 'effects';
  return value === 'music' ? 'music' : undefined;
}

function gapXml(start: number, duration: number, children: string, clip?: Format5Clip): string {
  const marker = clip ? element('marker', {start: '0s', duration: frameTime(1),
    value: (clip.sourceState === 'placeholder' ? '未生成镜头：' : '无法使用素材：') + clip.name}) : '';
  return element('gap', {name: clip?.name ?? 'Gap', start: '0s', offset: frameTime(start), duration: frameTime(duration)}, children + marker);
}

function buildPrimary(clips: readonly Format5Clip[], timeline: Format5Timeline,
  clipOrigin: (clip: Format5Clip) => number): PrimaryItem[] {
  let offset = 0;
  const primary: PrimaryItem[] = [];
  for (const clip of clips) {
    if (offset < clip.startFrame) primary.push({startFrame: offset, durationFrames: clip.startFrame - offset, sourceInFrame: 0, connected: []});
    primary.push({clip, startFrame: clip.startFrame, durationFrames: clip.durationFrames,
      sourceInFrame: clipOrigin(clip), connected: []});
    offset = endFrame(clip);
  }
  if (offset < timeline.durationFrames) primary.push({startFrame: offset, durationFrames: timeline.durationFrames - offset, sourceInFrame: 0, connected: []});
  return primary;
}

function renderAsset(resource: AssetResource): string {
  const {asset} = resource;
  return element('asset', {
    id: resource.id, name: asset.name, start: '0s', duration: frameTime(Math.max(asset.durationFrames, resource.usedFrames)),
    hasVideo: asset.hasVideo ? 1 : 0, hasAudio: asset.hasAudio ? 1 : 0, format: resource.format,
    audioSources: asset.hasAudio ? 1 : undefined,
    audioChannels: asset.hasAudio ? asset.audioChannels : undefined,
    audioRate: asset.hasAudio ? asset.audioRate : undefined,
  }, element('media-rep', {kind: 'original-media', src: asset.fileUrl}));
}

export function serializeFcpXml({timeline, projectName, assets, speed}: {
  readonly timeline: Format5Timeline;
  readonly projectName: string;
  readonly assets: ReadonlyMap<string, FcpXmlAsset>;
  readonly speed?: ReadonlyMap<string, EditorExportSpeed>;
}): string {
  if (timeline.fps !== fps) throw new RangeError('FCPXML export requires the Format 5 30 fps timebase');
  const tracks = [...timeline.tracks].sort((a, b) => a.orderIndex - b.orderIndex);
  const clips = [...timeline.clips].sort(compareTime);
  const mainId = timeline.mainTrack.trackId;
  const mainTrack = tracks.find(track => track.id === mainId);
  if (!mainTrack) throw new RangeError('FCPXML export requires a primary video track');

  const formats = new Map<string, string>();
  const resourceXml: string[] = [];
  let nextId = 1;
  const formatId = (width: number, height: number, noRate = false, frameDuration = frameTime(1)): string => {
    const key = [width, height, noRate, frameDuration].join(':');
    const existing = formats.get(key);
    if (existing) return existing;
    const id = `r${nextId++}`;
    formats.set(key, id);
    resourceXml.push(element('format', {
      id, name: noRate ? 'FFVideoFormatRateUndefined' : undefined, width: width || undefined, height: height || undefined,
      frameDuration: noRate ? undefined : frameDuration, colorSpace: noRate ? undefined : rec709,
    }));
    return id;
  };
  const sequenceFormat = formatId(timeline.width, timeline.height);
  const byFile = new Map<string, AssetResource>(), resources = new Map<string, AssetResource>();
  const retimed = new Set(clips.filter(clip => hasEditorExportSpeed(clip, timeline.fps)).map(clip => clip.id));
  const speedFor = (clip: Format5Clip) => retimed.has(clip.id) ? speed?.get(clip.id) : undefined;
  const sourceFrameDurationByFile = new Map<string, string>();
  for (const clip of clips) {
    const asset = retimed.has(clip.id) && clip.assetId ? assets.get(clip.assetId) : undefined;
    if (asset?.sourceFps !== undefined) {
      sourceFrameDurationByFile.set(asset.fileUrl, `${asset.sourceFpsDenominator ?? 1}/${asset.sourceFps}s`);
    }
  }
  const present = (clip: Format5Clip, asset: FcpXmlAsset) => !retimed.has(clip.id) || speedFor(clip) ||
    asset.isStill || clip.sourceInFrame + clip.durationFrames <= asset.durationFrames;
  for (const clip of clips) {
    if (clip.sourceState === 'placeholder' || !clip.assetId) continue;
    const asset = assets.get(clip.assetId);
    if (!asset || !present(clip, asset)) continue;
    let resource = byFile.get(asset.fileUrl);
    if (!resource) {
      const format = asset.hasVideo
        ? formatId(asset.width ?? timeline.width, asset.height ?? timeline.height, asset.isStill, sourceFrameDurationByFile.get(asset.fileUrl))
        : formatId(0, 0, true);
      resource = {id: `r${nextId++}`, format, asset, usedFrames: 0};
      byFile.set(asset.fileUrl, resource);
    }
    resource.usedFrames = Math.max(resource.usedFrames, speedFor(clip)?.sourceEndFrame ?? clip.sourceInFrame + clip.durationFrames);
    resources.set(clip.assetId, resource);
  }
  for (const resource of byFile.values()) resourceXml.push(renderAsset(resource));
  const getResource = (clip: Format5Clip): AssetResource | undefined => {
    const resource = clip.assetId && clip.sourceState === 'ready' ? resources.get(clip.assetId) : undefined;
    return resource && present(clip, resource.asset) ? resource : undefined;
  };

  function clipXml(clip: Format5Clip, track: TimelineTrackRecord, offset: number, lane?: number, children = ''): string {
    const resource = getResource(clip);
    if (!resource) return gapXml(offset, clip.durationFrames, children, clip);
    const {asset} = resource;
    const audioOnly = clip.soundOnly || track.kind === 'audio';
    const retiming = speedFor(clip);
    const freeze = clip.timing?.profile === 'timeline-freeze-v1';
    const local = retiming ? {...clip, sourceInFrame: 0} : clip;
    const picture = !audioOnly && asset.hasVideo ? pictureAdjustments(local, asset, track, timeline) : '';
    const audio = !freeze && asset.hasAudio ? audioAdjustments(local, track) : '';
    const attributes = {
      ref: resource.id, name: clip.name, lane, offset: frameTime(offset),
      start: frameTime(local.sourceInFrame), duration: frameTime(clip.durationFrames),
      srcEnable: freeze ? 'video' : audioOnly ? 'audio' : undefined,
      audioRole: !freeze && asset.hasAudio ? audioRole(clip.audioRole) : undefined,
    };
    if (!retiming) return element('asset-clip', attributes, picture + audio + children);
    const timeMap = timeMapXml(retiming);
    if (!children && !picture && !audio) return element('asset-clip', attributes, timeMap);
    // A timeMap also retimes its own connected offsets. Keep connections
    // and clip-relative effects on a parent with the unchanged output clock.
    return element('clip', {name: clip.name, lane, offset: attributes.offset, start: '0s', duration: attributes.duration},
      picture + audio + element('asset-clip', {...attributes, lane: undefined, offset: '0s'}, timeMap) + children);
  }

  const effectIds = new Map<Effect, string>();
  const cuts = fcpxmlTransitions(timeline, resources);
  function transitionXml(incoming: Format5Clip, base: number): string {
    const transition = cuts.get(incoming.id);
    if (!transition) return '';
    const {effect, parameters} = transitions[transition.kind];
    let ref = effectIds.get(effect);
    if (!ref) {
      ref = `r${nextId++}`;
      effectIds.set(effect, ref);
      resourceXml.push(element('effect', {id: ref, name: effect.name, uid: effect.uid}));
    }
    const {before} = clipTransitionSides(transition.durationFrames);
    return element('transition', {name: effect.name, offset: frameTime(incoming.startFrame - base - before),
      duration: frameTime(transition.durationFrames)}, element('filter-video', {ref, name: effect.name},
      parameters?.map(attributes => element('param', attributes)).join('')));
  }

  const primary = buildPrimary(clips.filter(clip => clip.trackId === mainId), timeline,
    clip => speedFor(clip) || !getResource(clip) ? 0 : clip.sourceInFrame);
  const primaryById = new Map(primary.flatMap(item => item.clip ? [[item.clip.id, item] as const] : []));
  function attach(item: {startFrame: number; anchor?: Format5Anchor}, lane: number, makeXml: (offset: number) => string): void {
    const owner = (item.anchor ? primaryById.get(item.anchor.clipId) : undefined)
      ?? primary.find(base => base.startFrame <= item.startFrame && item.startFrame < base.startFrame + base.durationFrames);
    if (!owner) throw new RangeError('FCPXML connected item starts outside the sequence');
    // The connected item's absolute time is recovered as parent offset +
    // child offset - parent start, including trimmed primary sources.
    const offset = owner.sourceInFrame + item.startFrame - owner.startFrame;
    owner.connected.push({startFrame: item.startFrame, lane, xml: makeXml(offset)});
  }

  let videoLane = 0, audioLane = 0;
  for (const track of tracks) {
    if (track.id === mainId) continue;
    const lane = track.kind === 'video' ? ++videoLane : --audioLane;
    const items = clips.filter(clip => clip.trackId === track.id);
    for (let start = 0; start < items.length;) {
      const first = items[start]!;
      let end = start + 1, storyline = clipXml(first, track, 0);
      // A transition can only live in a spine. Group only the contiguous
      // secondary clips linked by actual transitions, under one connection.
      for (; end < items.length; end++) {
        const next = items[end]!;
        const transition = transitionXml(next, first.startFrame);
        if (!transition) break;
        storyline += transition + clipXml(next, track, next.startFrame - first.startFrame);
      }
      if (end > start + 1 || !getResource(first)) {
        attach(first, lane, offset => element('spine', {lane, offset: frameTime(offset)}, storyline));
      } else attach(first, lane, offset => clipXml(first, track, offset, lane));
      start = end;
    }
  }

  const captionLane = videoLane + 1;
  for (const cue of timeline.subtitles?.cues ?? []) {
    attach(cue, captionLane, offset => element('caption', {
      lane: captionLane, offset: frameTime(offset), duration: frameTime(cue.durationFrames),
      role: 'Mioon Subtitles?captionFormat=ITT.zh-Hans',
    }, element('text', {}, xmlText(cue.text))));
  }

  const spine = primary.map(item => {
    const children = item.connected.sort((a, b) => compareTime(a, b) || a.lane - b.lane).map(value => value.xml).join('');
    if (!item.clip) return gapXml(item.startFrame, item.durationFrames, children);
    return transitionXml(item.clip, 0) + clipXml(item.clip, mainTrack, item.startFrame, undefined, children);
  }).join('');
  const sequence = element('sequence', {
    format: sequenceFormat, duration: frameTime(timeline.durationFrames), tcStart: '0s',
    tcFormat: 'NDF', audioLayout: 'stereo', audioRate: '48k',
  }, element('spine', {}, spine));
  return '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n' + element('fcpxml', {version: '1.13'},
    element('resources', {}, resourceXml.join('\n')) +
    element('event', {name: 'Mioon'}, element('project', {name: projectName}, sequence))) + '\n';
}
