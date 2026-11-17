import {app} from 'electron';
import type {MotionFfmpegMeasurement, MotionFfmpegStage} from './export.ts';

export function measureResources() {
  let samples = 0;
  let cpu = 0;
  let peakRssKiB = 0;
  const stages: Partial<Record<MotionFfmpegStage, MotionFfmpegMeasurement>> = {};
  const sample = () => {
    const metrics = app.getAppMetrics();
    cpu += metrics.reduce((sum, metric) => sum + metric.cpu.percentCPUUsage, 0);
    const rss = metrics.reduce((sum, metric) => sum + metric.memory.workingSetSize, 0);
    peakRssKiB = Math.max(peakRssKiB, rss);
    samples++;
  };
  app.getAppMetrics(); // Prime Electron's interval CPU counters before the first sample.
  const timer = setInterval(sample, 500);
  return {
    recordFfmpegStage(stage: MotionFfmpegStage, result: MotionFfmpegMeasurement) { stages[stage] = result; },
    finish() {
      clearInterval(timer);
      const ffmpeg = Object.values(stages);
      const elapsed = ffmpeg.reduce((sum, stage) => sum + stage.elapsedSeconds, 0);
      const cpuSeconds = ffmpeg.reduce((sum, stage) => sum + stage.userSeconds + stage.systemSeconds, 0);
      return {intervalMs: 500, electron: {samples, meanCpuPercent: samples ? cpu / samples : null, peakRssKiB},
        ffmpeg: {stages, meanCpuPercent: elapsed > 0 ? 100 * cpuSeconds / elapsed : null,
          peakRssKiB: Math.max(0, ...ffmpeg.map(stage => stage.peakRssKiB))}};
    },
  };
}

export function measurePixelDifferences(
  reference: Buffer, actual: Buffer, channels: number[], pixels: number[], visiblePixels: number[],
): void {
  for (let i = 0; i < reference.length; i += 4) {
    let max = 0;
    const alpha = reference[i + 3];
    const actualAlpha = actual[i + 3];
    for (let channel = i; channel < i + 4; channel++) {
      const delta = Math.abs(reference[channel] - actual[channel]);
      channels[delta]++;
      max = Math.max(max, delta);
    }
    pixels[max]++;
    if (alpha === 0 && actualAlpha === 0) continue;
    // Compare displayed color contributions across the union of pixels covered by the title.
    let visibleDelta = Math.abs(alpha - actualAlpha);
    for (let channel = i; channel < i + 3; channel++) {
      const referenceColor = Math.round(reference[channel] * alpha / 255);
      const actualColor = Math.round(actual[channel] * actualAlpha / 255);
      visibleDelta = Math.max(visibleDelta, Math.abs(referenceColor - actualColor));
    }
    visiblePixels[visibleDelta]++;
  }
}

export function sparseDistribution(counts: number[]): Record<number, number> {
  return Object.fromEntries(counts.map((count, delta) => [delta, count]).filter(([, count]) => count));
}
