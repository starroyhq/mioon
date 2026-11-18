/** Deterministic synthetic material set for the SP-E0 audio gate.
 *
 * Everything is generated from a seeded PRNG: no downloads, no committed media,
 * no external assets. Internally signal positions are 48 kHz sample frames;
 * project positions are 30 fps frames (`48000 / 30 = 1600` samples per frame). */
import {SAMPLE_RATE, SAMPLES_PER_FRAME} from './pcm.mjs';

export const MATERIAL_FPS = 30;
export const MATERIALS = Object.freeze([
  {name: 'speech-tail', projectFrames: 180, kind: 'speech', tailGate: true,
    description: 'word-like groups; the final word ends in an unvoiced fricative that stays loud until the last sample'},
  {name: 'transient', projectFrames: 240, kind: 'transient', tailGate: false,
    description: 'quiet floor with four sharp percussive transients at known source frames'},
  {name: 'drums', projectFrames: 240, kind: 'drums', tailGate: false,
    description: '120 bpm kick/snare/hi-hat loop with hits through the file end'},
  {name: 'sustain', projectFrames: 600, kind: 'sustain', tailGate: true,
    description: '20 s of continuously sounding harmonic tone (440/660/880 Hz) cut at the last sample'},
  {name: 'stereo-phase', projectFrames: 150, kind: 'phase', tailGate: true,
    description: '5 s 440 Hz tone with the right channel delayed by 24 samples (0.5 ms) to measure stereo timing'},
]);

const SAMPLES_PER_SECOND = SAMPLE_RATE;
const seconds = value => Math.round(value * SAMPLES_PER_SECOND);
const clamp = (value, lo, hi) => value < lo ? lo : value > hi ? hi : value;
const projectFrameToSample = frame => Math.round(frame * SAMPLES_PER_FRAME);

function mulberry32(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6D2B79F5) >>> 0;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class StereoBuffer {
  constructor(frames) { this.frames = frames; this.left = new Float32Array(frames); this.right = new Float32Array(frames); }
  add(frameIndex, left, right = left) {
    if (frameIndex < 0 || frameIndex >= this.frames || !Number.isFinite(left)) return;
    this.left[frameIndex] += left;
    this.right[frameIndex] += right;
  }
  interleaved() {
    const output = new Float32Array(this.frames * 2);
    for (let index = 0; index < this.frames; index++) { output[index * 2] = this.left[index]; output[index * 2 + 1] = this.right[index]; }
    return output;
  }
}

const FORMANTS = [[1, 1], [2, 0.55], [3, 0.32], [4, 0.18], [5, 0.1]];
function voicedSyllable(buffer, startSample, lengthSamples, pitchStart, pitchEnd, amplitude) {
  for (let offset = 0; offset < lengthSamples; offset++) {
    const progress = offset / Math.max(1, lengthSamples);
    const pitch = pitchStart + (pitchEnd - pitchStart) * progress;
    const time = offset / SAMPLES_PER_SECOND;
    const vibrato = 1 + 0.008 * Math.sin(2 * Math.PI * 5.5 * time);
    let value = 0;
    for (const [harmonic, weight] of FORMANTS) value += weight * Math.sin(2 * Math.PI * pitch * harmonic * time * vibrato + harmonic * 0.37);
    const attack = clamp(offset / seconds(0.012), 0, 1);
    const release = clamp((lengthSamples - offset) / seconds(0.03), 0, 1);
    const sample = amplitude * value * attack * Math.min(1, release) / FORMANTS.reduce((sum, [, weight]) => sum + weight, 0);
    buffer.add(startSample + offset, sample, sample);
  }
}
function unvoicedBurst(buffer, startSample, lengthSamples, amplitude) {
  const random = mulberry32(Math.round(startSample / 37) + lengthSamples);
  let previous = 0;
  for (let offset = 0; offset < lengthSamples; offset++) {
    const noise = random() * 2 - 1;
    const filtered = noise - previous * 0.92;
    previous = noise;
    const envelope = Math.min(1, offset / seconds(0.004)) * Math.min(1, (lengthSamples - offset) / seconds(0.006));
    const sample = amplitude * filtered * envelope;
    buffer.add(startSample + offset, sample, sample * 0.98);
  }
}
function click(buffer, startSample, decaySeconds, amplitude) {
  const decaySamples = seconds(decaySeconds);
  for (let offset = 0; offset < decaySamples; offset++) {
    const gain = amplitude * Math.exp(-offset / (decaySamples / 4));
    buffer.add(startSample + offset, gain, gain * 0.96);
  }
}

function speechTail(descriptor) {
  const buffer = new StereoBuffer(projectFrameToSample(descriptor.projectFrames));
  const words = [
    {start: 0.15, syllables: [[0.16, 128, 112], [0.14, 118, 104], [0.22, 110, 96]]},
    {start: 1.05, syllables: [[0.12, 140, 120], [0.10, 132, 118]]},
    {start: 1.62, syllables: [[0.14, 122, 108], [0.18, 116, 98]]},
    {start: 2.45, syllables: [[0.10, 150, 132], [0.16, 138, 118], [0.12, 126, 110]]},
  ];
  for (const word of words) {
    let cursor = seconds(word.start);
    for (const [length, pitchStart, pitchEnd] of word.syllables) {
      const lengthSamples = seconds(length);
      voicedSyllable(buffer, cursor, lengthSamples, pitchStart, pitchEnd, 0.22);
      cursor += lengthSamples + 2;
    }
    unvoicedBurst(buffer, cursor, seconds(0.05), 0.06);
  }
  const fricativeSamples = seconds(0.12);
  voicedSyllable(buffer, buffer.frames - fricativeSamples - seconds(0.28), seconds(0.28), 124, 104, 0.24);
  unvoicedBurst(buffer, buffer.frames - fricativeSamples, fricativeSamples, 0.22);
  // The file ends on the fricative exactly, so a tail loss cannot hide behind
  // a trailing vowel or silence.
  return {samples: buffer.interleaved(), metadata: {tailStartSample: buffer.frames - fricativeSamples}};
}

function transients(descriptor) {
  const buffer = new StereoBuffer(projectFrameToSample(descriptor.projectFrames));
  const random = mulberry32(7);
  for (let index = 0; index < buffer.frames; index++) buffer.add(index, (random() - 0.5) * 0.002);
  const markerSamples = [1, 2.5, 4, 6.5].map(time => seconds(time));
  for (const sample of markerSamples) click(buffer, sample, 0.05, 0.7);
  return {samples: buffer.interleaved(), metadata: {transientSamples: markerSamples}};
}

function drums(descriptor) {
  const buffer = new StereoBuffer(projectFrameToSample(descriptor.projectFrames));
  const random = mulberry32(11);
  const beatSamples = seconds(0.5);
  for (let start = 0; start < buffer.frames; start += beatSamples) {
    const beatIndex = Math.round(start / beatSamples);
    if (beatIndex % 4 === 0 || beatIndex % 4 === 2) {
      for (let offset = 0; offset < seconds(0.18); offset++) {
        const frequency = 120 - 70 * (offset / seconds(0.18));
        buffer.add(start + offset, 0.55 * Math.exp(-offset / (seconds(0.18) / 5)) * Math.sin(2 * Math.PI * frequency * offset / SAMPLES_PER_SECOND));
      }
    } else {
      for (let offset = 0; offset < seconds(0.12); offset++) {
        const gain = 0.35 * Math.exp(-offset / (seconds(0.12) / 4));
        buffer.add(start + offset, gain * (random() * 2 - 1), gain * (random() * 2 - 1));
      }
    }
    for (const half of [0, Math.floor(beatSamples / 2)]) {
      for (let offset = 0; offset < seconds(0.04); offset++) {
        const gain = 0.08 * Math.exp(-offset / (seconds(0.04) / 3));
        const noise = random() * 2 - 1;
        buffer.add(start + half + offset, gain * noise, gain * noise);
      }
    }
  }
  click(buffer, buffer.frames - seconds(0.05), 0.07, 0.4);
  return {samples: buffer.interleaved(), metadata: {}};
}

function sustain(descriptor) {
  const buffer = new StereoBuffer(projectFrameToSample(descriptor.projectFrames));
  for (let index = 0; index < buffer.frames; index++) {
    const time = index / SAMPLES_PER_SECOND;
    const vibrato = 1 + 0.003 * Math.sin(2 * Math.PI * 0.5 * time);
    const tremolo = 0.85 + 0.1 * Math.sin(2 * Math.PI * 0.25 * time);
    const value = tremolo * (0.18 * Math.sin(2 * Math.PI * 440 * time * vibrato)
      + 0.11 * Math.sin(2 * Math.PI * 660 * time + 0.7) + 0.05 * Math.sin(2 * Math.PI * 880 * time + 1.3));
    buffer.add(index, value, value);
  }
  return {samples: buffer.interleaved(), metadata: {}};
}

function stereoPhase(descriptor) {
  const buffer = new StereoBuffer(projectFrameToSample(descriptor.projectFrames));
  const delaySamples = 24;
  for (let index = 0; index < buffer.frames; index++) {
    const time = index / SAMPLES_PER_SECOND;
    buffer.add(index, 0.25 * Math.sin(2 * Math.PI * 440 * time) + 0.05 * Math.sin(2 * Math.PI * 1320 * time), 0);
  }
  for (let index = delaySamples; index < buffer.frames; index++) {
    const time = (index - delaySamples) / SAMPLES_PER_SECOND;
    buffer.right[index] = 0.25 * Math.sin(2 * Math.PI * 440 * time) + 0.05 * Math.sin(2 * Math.PI * 1320 * time);
  }
  return {samples: buffer.interleaved(), metadata: {phaseDelaySamples: delaySamples, phaseToneHz: 440}};
}

const BUILDERS = new Map([['speech-tail', speechTail], ['transient', transients], ['drums', drums], ['sustain', sustain], ['stereo-phase', stereoPhase]]);

/** Builds all materials (or the requested names) into memory. */
export function buildMaterials(names = MATERIALS.map(material => material.name)) {
  const result = [];
  for (const name of names) {
    const descriptor = MATERIALS.find(material => material.name === name);
    if (!descriptor) throw new Error(`unknown material ${name}`);
    const built = BUILDERS.get(name)(descriptor);
    result.push({...descriptor, sampleRate: SAMPLE_RATE, audioFrames: built.samples.length / 2,
      projectFrames: descriptor.projectFrames, samples: built.samples, metadata: built.metadata});
  }
  return result;
}

export function materialByName(materials, name) {
  const material = materials.find(item => item.name === name);
  if (!material) throw new Error(`material ${name} not built`);
  return material;
}

export function frameToSample(frame) { return Math.round(frame * SAMPLES_PER_FRAME); }
export function sampleToFrame(sample) { return sample / SAMPLES_PER_FRAME; }
