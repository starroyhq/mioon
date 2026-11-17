import {useLayoutEffect, useRef} from 'react';
import {flushSync} from 'react-dom';
import {createRoot} from 'react-dom/client';
import sampleTitle from './sample-title.json' with {type: 'json'};
import {TitlePop} from './title-pop.tsx';
import type {TitlePopParams} from './title-pop.tsx';
import {paintTitlePop} from './title-pop-canvas.ts';
import {motionCaptureMarkerBits, motionCaptureMarkerCell, motionCaptureMarkerCellSize,
  motionCaptureMarkerHeight, motionCaptureMarkerWidth} from './capture-marker.ts';

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
const marker = query.get('marker') === '1';
const legacy = query.get('renderer') === 'legacy';
const captureWidth = marker ? Math.max(width, motionCaptureMarkerWidth) : width;
const captureHeight = marker ? height + motionCaptureMarkerHeight : height;
const stage = document.getElementById('motion-stage')!;
const overlay = document.getElementById('motion-overlay')!;
const root = createRoot(overlay);
const titleParams: TitlePopParams = {...sampleTitle, fontSize: sampleTitle.fontSize * width / 1080};
const previewVideo = mode === 'preview' ? document.createElement('video') : undefined;
let overlayOnly = !previewVideo;
let videoCallback: number | undefined;
let lastMediaFrame = 0;

function TitleCanvas({frame, request}: {frame: number; request?: number}) {
  const output = useRef<HTMLCanvasElement>(null);
  const staging = useRef<OffscreenCanvas>(null);
  const surfaceWidth = overlayOnly ? captureWidth : width;
  const surfaceHeight = overlayOnly ? captureHeight : height;
  const scale = devicePixelRatio;
  const rasterWidth = Math.round(surfaceWidth * scale);
  const rasterHeight = Math.round(surfaceHeight * scale);
  useLayoutEffect(() => {
    if (!staging.current || staging.current.width !== rasterWidth || staging.current.height !== rasterHeight) {
      staging.current = new OffscreenCanvas(rasterWidth, rasterHeight);
    }
    const canvas = staging.current;
    const context = canvas.getContext('2d');
    const presenter = output.current?.getContext('bitmaprenderer');
    if (!context || !presenter) throw new Error('Motion prototype canvas context unavailable');

    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.clearRect(0, 0, surfaceWidth, surfaceHeight);
    paintTitlePop(context, {frame, fps, width, height, params: titleParams});
    if (request !== undefined) {
      context.fillStyle = 'black';
      context.fillRect(0, height, motionCaptureMarkerWidth, motionCaptureMarkerHeight);
      context.fillStyle = 'white';
      const bits = motionCaptureMarkerBits(frame, request);
      for (let index = 0; index < bits.length; index++) {
        if (bits[index] === '1') {
          const {x, y} = motionCaptureMarkerCell(index);
          context.fillRect(x, height + y, motionCaptureMarkerCellSize, motionCaptureMarkerCellSize);
        }
      }
    }
    // Publish the title and marker as one bitmap. The compositor never receives them as independent layers.
    const bitmap = canvas.transferToImageBitmap();
    try {
      presenter.transferFromImageBitmap(bitmap);
    } catch (error) {
      bitmap.close();
      throw error;
    }
  }, [frame, request, scale, rasterWidth, rasterHeight, surfaceWidth, surfaceHeight]);
  return <canvas ref={output} width={rasterWidth} height={rasterHeight}
    style={{display: 'block', width: surfaceWidth, height: surfaceHeight}} />;
}

function render(frame: number, request?: number): void {
  if (!Number.isSafeInteger(frame) || frame < 0) throw new Error('Invalid motion prototype frame');
  if (request !== undefined && (!marker || !overlayOnly || legacy || !Number.isSafeInteger(request) || request < 1)) {
    throw new Error('Invalid motion prototype capture request');
  }
  flushSync(() => root.render(legacy
    ? <TitlePop frame={frame} fps={fps} width={width} height={height} params={titleParams} />
    : <TitleCanvas frame={frame} request={request} />));
  overlay.dataset.frame = String(frame);
}

function resizeStage(): void {
  const scale = overlayOnly ? 1 : Math.min(innerWidth / width, innerHeight / height);
  const viewportWidth = overlayOnly ? captureWidth : width;
  const viewportHeight = overlayOnly ? captureHeight : height;
  stage.style.width = `${viewportWidth * scale}px`;
  stage.style.height = `${viewportHeight * scale}px`;
  overlay.style.width = `${viewportWidth}px`;
  overlay.style.height = `${viewportHeight}px`;
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
