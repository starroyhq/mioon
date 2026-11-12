import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import type {OpenProjectConnectionOptions} from '../../packages/business/src/project-file/connection.ts';
import {openProjectStore} from '../../packages/business/src/project-file/store.ts';
import {releaseProjectPaths} from '../helpers/format4-release-fixture.ts';

const [root, stopAt, marker] = process.argv.slice(2);
assert.ok(root && marker && (stopAt === 'before-version-write' || stopAt === 'before-commit' || stopAt === 'after-commit'));
const {projectFile, location} = releaseProjectPaths(root);
const options: OpenProjectConnectionOptions = {projectFile, locate: () => location, format4: {
  approveUpgrade: () => true,
  onUpgradeBoundary(phase, observed) {
    if (phase !== stopAt) return;
    writeFileSync(marker, JSON.stringify({phase, observed}), {flag: 'wx'});
    process.kill(process.pid, 'SIGKILL');
  },
}};
const store = openProjectStore(options);
store.close();
assert.fail('The requested format upgrade boundary was not reached');
