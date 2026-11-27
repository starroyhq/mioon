import assert from 'node:assert/strict';
import {openProjectStore} from '../../packages/business/src/project-file/store.ts';
import {registerProjectMediaStore} from '../../packages/business/src/project-media-storage.ts';
import {createProcessingCache} from '../../packages/business/src/timeline-processing/cache.ts';
import {createProcessingScheduler} from '../../packages/business/src/timeline-processing/scheduler.ts';
import {createTimelineProcessingService} from '../../packages/business/src/timeline-processing/service.ts';

const {projectFile, locations, cacheRoot} = JSON.parse(process.argv[2]!) as {
  projectFile: string; locations: {localDir: string; cacheDir: string; tempDir: string}; cacheRoot: string;
};
const store = openProjectStore({projectFile, locate: () => locations, allowFormat6: true});
const unregister = registerProjectMediaStore(store);
const cache = createProcessingCache(cacheRoot);
const controller = new AbortController();
process.once('SIGTERM', () => controller.abort());
const processing = createTimelineProcessingService(store, {
  cache: {...cache, stage(...args) {
    const stage = cache.stage(...args);
    const writer = stage.writer;
    assert.ok(writer);
    let completed = 0;
    return {...stage, writer: {begin() {
      const ticket = writer.begin();
      return {...ticket, exited() {
        ticket.exited();
        // Each of the first fifteen direct-to-file encoders writes a block.
        // Cut the host after FFmpeg closes and its writer ticket is cleared.
        // This bypasses finally/discard with no FFmpeg child left running.
        if (++completed === 15) process.kill(process.pid, 'SIGKILL');
      }};
    }}};
  }},
  scheduler: createProcessingScheduler(), enabled: true, ownerSignal: controller.signal, beforeEffect() {},
});
try {
  processing.activate();
  await Promise.resolve();
  const task = processing.list({projectId: store.projectId}).items.find(item => item.kind === 'optical');
  assert.ok(task);
  const result = await processing.wait({projectId: store.projectId, taskId: task.taskId, timeoutMs: 75_000}, controller.signal);
  throw new Error('Expected SIGKILL after optical block 15: ' + JSON.stringify(result));
} finally {
  await processing.close(); unregister(); store.close();
}
