import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {openProjectStore} from '../../packages/business/src/project-file/store.ts';
import {inspectProjectFormatReadOnly, recoverProjectFile} from '../../packages/business/src/project-file/connection.ts';
import {prepareFormat5Conversion, applyFormat5ConversionInside} from '../../packages/business/src/project-file/format5-conversion-store.ts';
import {FORMAT5_PROJECT_SCHEMA_VERSION} from '../../packages/business/src/project-file/schema/databases.ts';
import {format5ConversionAllocation, format5KernelSnapshot} from '../helpers/format5-release-fixture.ts';
import {releaseProjectPaths} from '../helpers/format4-release-fixture.ts';

const [mode, root, sourceFormat, stopAt, marker] = process.argv.slice(2);
assert.ok(root && marker && (sourceFormat === '3' || sourceFormat === '4'));
const {projectFile, location} = releaseProjectPaths(root);
if (mode === 'observe') {
  const recovered = recoverProjectFile(projectFile, {format5: true});
  assert.ok(recovered.state === 'clean' || recovered.state === 'recovered');
  const observed = inspectProjectFormatReadOnly(projectFile, {format5: true});
  const store = openProjectStore({projectFile, locate: () => location,
    ...(observed.formatVersion === FORMAT5_PROJECT_SCHEMA_VERSION ? {format5: true} : observed.formatVersion === 4 ? {format4: {}} : {})});
  try {writeFileSync(marker, JSON.stringify({recovered: recovered.state, snapshot: format5KernelSnapshot(store)}), {flag: 'wx'});}
  finally {store.close();}
} else {
  assert.equal(mode, 'convert');
  assert.ok(['after-content', 'after-structure', 'before-version-write', 'after-version-write', 'after-commit'].includes(stopAt!));
  const store = openProjectStore({projectFile, locate: () => location, ...(sourceFormat === '4' ? {format4: {}} : {})});
  const prepared = prepareFormat5Conversion(store, format5ConversionAllocation());
  const stop = (phase: string) => {
    if (phase !== stopAt) return;
    writeFileSync(marker, JSON.stringify({phase, projectId: store.projectId,
      observed: {project: store.db.prepare('PRAGMA project.user_version').get()!.user_version,
        history: store.db.prepare('SELECT version FROM main.schema_version').get()!.version}, plan: prepared.plan}), {flag: 'wx'});
    process.kill(process.pid, 'SIGKILL');
  };
  store.tx(() => applyFormat5ConversionInside(store, prepared, {onBoundary: stop}));
  stop('after-commit');
  store.close();
  assert.fail('The requested conversion boundary was not observed');
}
