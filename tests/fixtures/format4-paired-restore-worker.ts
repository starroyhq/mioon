import assert from 'node:assert/strict';
import {restoreFormat4Backup} from '../../packages/business/src/project-file/format4-restore.ts';

const [input, phase] = process.argv.slice(2);
assert.ok(input && phase);
restoreFormat4Backup({
  ...JSON.parse(input),
  onBoundary(boundary) {
    if (boundary === phase) process.kill(process.pid, 'SIGKILL');
  },
});
assert.fail('The requested restore boundary was not reached');
