import {flushSync} from 'react-dom';
import {createRoot} from 'react-dom/client';
import sampleTitle from './sample-title.json' with {type: 'json'};
import {TitlePop} from './title-pop.tsx';
import type {TitlePopParams} from './title-pop.tsx';

const query = new URLSearchParams(location.search);
const mode = query.get('mode');
if (mode !== 'preview' && mode !== 'export') throw new Error('Invalid motion prototype mode');

function positiveInteger(key: string, fallback: number, maximum: number): number {
  const value = Number(query.get(key) ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`Invalid motion prototype ${key}`);
  return value;
}

const width = positiveInteger('width', 1080, 8192);
const height = positiveInteger('height', 1920, 8192);
const fps = positiveInteger('fps', 30, 120);
const stage = document.getElementById('motion-stage')!;
const overlay = document.getElementById('motion-overlay')!;
const root = createRoot(overlay);
const titleParams: TitlePopParams = {...sampleTitle, fontSize: sampleTitle.fontSize * width / 1080};
const previewVideo = mode === 'preview' ? document.createElement('video') : undefined;
let overlayOnly = !previewVideo;
let videoCallback: number | undefined;
let lastMediaFrame = 0;

function render(frame: number): void {
  if (!Number.isSafeInteger(frame) || frame < 0) throw new Error('Invalid motion prototype frame');
  flushSync(() => root.render(<TitlePop frame={frame} fps={fps} width={width} height={height} params={titleParams} />));
  overlay.dataset.frame = String(frame);
}

function resizeStage(): void {
  const scale = overlayOnly ? 1 : Math.min(innerWidth / width, innerHeight / height);
  stage.style.width = `${width * scale}px`;
  stage.style.height = `${height * scale}px`;
  overlay.style.transform = scale === 1 ? '' : `scale(${scale})`;
}

function subscribeToVideo(video: HTMLVideoElement): void {
  videoCallback = video.requestVideoFrameCallback((_now, {mediaTime}) => {
    // The fixture is constant-rate. Round to recover its frame from the
    // media timestamp, which is quantized to microseconds by Chromium.
    lastMediaFrame = Math.round(mediaTime * fps);
    render(lastMediaFrame);
    overlay.dataset.mediaTime = String(mediaTime);
    subscribeToVideo(video);
  });
}

function setOverlayOnly(enabled: boolean): void {
  if (!previewVideo || enabled === overlayOnly) return;
  overlayOnly = enabled;
  document.body.classList.toggle('preview', !enabled);
  previewVideo.hidden = enabled;
  resizeStage();
  if (enabled) {
    previewVideo.pause();
    if (videoCallback !== undefined) previewVideo.cancelVideoFrameCallback(videoCallback);
    videoCallback = undefined;
    delete overlay.dataset.mediaTime;
  } else {
    render(lastMediaFrame);
    subscribeToVideo(previewVideo);
  }
}

const ready = (async () => {
  const faces = await document.fonts.load('400 32px "Mioon Motion Prototype"', titleParams.text);
  if (faces.length !== 1 || faces[0]?.status !== 'loaded') throw new Error('Pinned motion prototype font did not load');
  overlay.style.width = `${width}px`;
  overlay.style.height = `${height}px`;
  document.body.classList.toggle('preview', !overlayOnly);
  resizeStage();
  render(0);
  if (previewVideo) {
    previewVideo.controls = true;
    previewVideo.setAttribute('controlslist', 'nodownload nofullscreen noremoteplayback');
    previewVideo.disablePictureInPicture = true;
    previewVideo.disableRemotePlayback = true;
    previewVideo.playsInline = true;
    previewVideo.preload = 'auto';
    stage.prepend(previewVideo);
    previewVideo.src = 'video.mp4';
    subscribeToVideo(previewVideo);
    addEventListener('resize', resizeStage);
  }
})();

Object.assign(window, {motionPrototype: {ready, render, setOverlayOnly}});
