import {execFileSync} from 'node:child_process';
import {app} from 'electron';

export function measureResources(): {observeChild(pid: number): void; finish(): object} {
  let childPid: number | undefined;
  let samples = 0;
  let cpu = 0;
  let peakRssKiB = 0;
  let ffmpegSamples = 0;
  let ffmpegCpu = 0;
  let ffmpegPeakRssKiB = 0;
  const sample = () => {
    const metrics = app.getAppMetrics();
    cpu += metrics.reduce((sum, metric) => sum + metric.cpu.percentCPUUsage, 0);
    const rss = metrics.reduce((sum, metric) => sum + metric.memory.workingSetSize, 0);
    peakRssKiB = Math.max(peakRssKiB, rss);
    samples++;
    if (childPid === undefined) return;
    const child = execFileSyncForMetrics(childPid);
    if (child === undefined) return;
    ffmpegSamples++;
    ffmpegCpu += child.cpu;
    ffmpegPeakRssKiB = Math.max(ffmpegPeakRssKiB, child.rssKiB);
  };
  app.getAppMetrics(); // Prime Electron's interval CPU counters before the first sample.
  const timer = setInterval(sample, 500);
  return {
    observeChild(pid) { childPid = pid; },
    finish() {
      clearInterval(timer);
      return {intervalMs: 500, electron: {samples, meanCpuPercent: samples ? cpu / samples : null, peakRssKiB},
        ffmpeg: {samples: ffmpegSamples, meanCpuPercent: ffmpegSamples ? ffmpegCpu / ffmpegSamples : null, peakRssKiB: ffmpegPeakRssKiB}};
    },
  };
}

function execFileSyncForMetrics(pid: number): {cpu: number; rssKiB: number} | undefined {
  try {
    const [cpu, rssKiB] = execFileSync('ps', ['-p', String(pid), '-o', '%cpu=,rss='], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 500,
    }).trim().split(/\s+/).map(Number);
    if (Number.isFinite(cpu) && Number.isFinite(rssKiB)) return {cpu, rssKiB};
  } catch {
    // FFmpeg may have exited between samples.
  }
  return undefined;
}

export function measurePixelDifferences(
  reference: Buffer, actual: Buffer, channels: number[], pixels: number[],
): void {
  for (let i = 0; i < reference.length; i += 4) {
    let max = 0;
    for (let channel = i; channel < i + 4; channel++) {
      const delta = Math.abs(reference[channel] - actual[channel]);
      channels[delta]++;
      max = Math.max(max, delta);
    }
    pixels[max]++;
  }
}

export function sparseDistribution(counts: number[]): Record<number, number> {
  return Object.fromEntries(counts.map((count, delta) => [delta, count]).filter(([, count]) => count));
}
