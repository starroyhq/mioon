/** Records peak V8 heap/old-space values of a build child so BUILD_TIMING can
 * report the margin against the configured `--max-old-space-size` limit. The
 * probe rewrites a small JSON file as the peak grows: an OOM abort does not run
 * Node exit handlers, so the last rewrite still carries the near-peak value. */
import {writeFileSync} from 'node:fs';
import v8 from 'node:v8';

const evidence = process.env.MIOON_BUILD_HEAP_EVIDENCE;
const heapLimitBytes = v8.getHeapStatistics().heap_size_limit;
const flag = process.execArgv.find(arg => arg.startsWith('--max-old-space-size='));
const maxOldSpaceBytes = flag ? Number(flag.slice('--max-old-space-size='.length)) * 1024 * 1024 : heapLimitBytes;
let peakOldSpaceBytes = 0, peakHeapUsedBytes = 0, peakRssBytes = 0;

function oldSpaceUsedBytes(): number {
  const space = v8.getHeapSpaceStatistics().find(item => item.space_name === 'old_space');
  return space ? space.space_used_size : 0;
}

function write(): void {
  if (!evidence) return;
  try {
    writeFileSync(evidence, JSON.stringify({peakOldSpaceBytes, peakHeapUsedBytes, peakRssBytes, heapLimitBytes, maxOldSpaceBytes}));
  } catch { /* measurement must not fail the build */ }
}

function sample(): void {
  const usage = process.memoryUsage(), oldSpace = oldSpaceUsedBytes();
  let changed = false;
  if (oldSpace > peakOldSpaceBytes) {peakOldSpaceBytes = oldSpace; changed = true;}
  if (usage.heapUsed > peakHeapUsedBytes) {peakHeapUsedBytes = usage.heapUsed; changed = true;}
  if (usage.rss > peakRssBytes) {peakRssBytes = usage.rss; changed = true;}
  if (changed) write();
}

const timer = setInterval(sample, 200);
timer.unref();
process.on('exit', () => {sample(); write();});
sample();
