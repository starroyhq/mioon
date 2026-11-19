import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {createProjectStore} from '../packages/business/src/project-file/store.ts';
import {
  FORMAT5_LEGACY_WRITE_USES, assertFormat5LegacyWriteAllowed, assertLegacyCanvasWriteAllowed,
  format5LegacyWriteUse,
} from '../packages/business/src/sequence-edit.ts';
import {createChainWorld} from './helpers/sequence-edit-double.ts';

const EXPECTED: Readonly<Record<string, string>> = Object.freeze({
  'timeline.get': 'sequence.preview/commit',
  'timeline.track.add': 'sequence.preview/commit', 'timeline.track.update': 'sequence.preview/commit',
  'timeline.clip.add': 'sequence.preview/commit', 'timeline.clip.update': 'sequence.preview/commit',
  'timeline.clip.replaceSource': 'sequence.preview/commit', 'timeline.clip.remove': 'sequence.preview/commit',
  'timeline.clip.rippleRemove': 'sequence.preview/commit', 'timeline.clip.split': 'sequence.preview/commit',
  'timeline.clip.splitAtScenes': 'sequence.preview/commit', 'timeline.clip.crossfade': 'sequence.preview/commit',
  'timeline.clip.setGains': 'sequence.preview/commit', 'timeline.clip.setTransform': 'sequence.preview/commit',
  'timeline.clip.setTransition': 'sequence.preview/commit', 'timeline.loudness.apply': 'sequence.preview/commit',
  'timeline.subtitle.add': 'sequence.preview/commit', 'timeline.subtitle.update': 'sequence.preview/commit',
  'timeline.subtitle.remove': 'sequence.preview/commit', 'timeline.seed': 'sequence.preview/commit',
  'timeline.shots.append': 'sequence.preview/commit', 'timeline.clip.refreshSources': 'sequence.preview/commit',
  'timeline.format.set': 'sequence.preview/commit',
  'timeline.history.get': 'sequence.history.get', 'timeline.undo': 'sequence.undo', 'timeline.redo': 'sequence.redo',
  'canvas.apply': 'sequence.preview/commit',
  'canvas.history.get': 'sequence.history.get', 'canvas.history.undo': 'sequence.undo', 'canvas.history.redo': 'sequence.redo',
  'edge.create': 'sequence.preview/commit', 'edge.delete': 'sequence.preview/commit',
  'shot.reorder': 'sequence.preview/commit', 'version.select': 'sequence.preview/commit',
  'shot.create': 'sequence.preview/commit', 'shot.update': 'sequence.preview/commit',
  'node.create': 'sequence.preview/commit', 'node.update': 'sequence.preview/commit',
  'reference.attach': 'sequence.preview/commit', 'reference.detach': 'sequence.preview/commit',
  'previs.create': 'not_yet_available', 'previs.scene.set': 'not_yet_available', 'previs.thumbnail.set': 'not_yet_available',
  'subject.create': 'sequence.preview/commit', 'subject.version.add': 'sequence.preview/commit',
  'subject.binding.set': 'sequence.preview/commit',
});
const READ_ONLY = ['timeline.inspect', 'timeline.format.get', 'timeline.clip.loudness', 'timeline.loudness.prepare',
  'canvas.archive.preview', 'canvas.archive.list', 'canvas.copy.snapshot', 'subject.list', 'subject.binding.list',
  'previs.thumbnail.get', 'previs.inspect', 'shot.inspect', 'node.inspect', 'edge.inspect'];

test('every FR-0 legacy writer is gated once under format 5 and stays untouched on format 4', t => {
  const world = createChainWorld(t, {
    rootId: '10000000-0000-4000-8000-000000000001',
    shots: [], versions: [], clips: [], edges: [],
  });
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-fr0-gate-'));
  const format4 = createProjectStore({projectId: randomUUID(), projectFile: path.join(root, 'project.mioon'),
    locate: () => ({localDir: path.join(root, 'records'), cacheDir: path.join(root, 'cache'), tempDir: path.join(root, 'temp')})});
  try {
    assert.deepEqual(Object.keys(FORMAT5_LEGACY_WRITE_USES).sort(), Object.keys(EXPECTED).sort());
    for (const [operation, use] of Object.entries(EXPECTED)) {
      assert.equal(format5LegacyWriteUse(operation), use, operation);
      assert.throws(() => assertFormat5LegacyWriteAllowed(world.store, operation), (error: {code?: string; details?: {use?: string}}) =>
        error.code === 'UNSUPPORTED_OPERATION' && error.details?.use === use, operation);
      assert.doesNotThrow(() => assertFormat5LegacyWriteAllowed(format4, operation), `format 4 ${operation}`);
    }
    for (const operation of READ_ONLY) {
      assert.equal(format5LegacyWriteUse(operation), null, operation);
      assert.doesNotThrow(() => assertFormat5LegacyWriteAllowed(world.store, operation), operation);
    }
    // Unlisted legacy writers that are not edits (render is handled by FR-B) stay untouched.
    for (const operation of ['timeline.render', 'project.rename', 'project.version.save', 'export.create']) {
      assert.equal(format5LegacyWriteUse(operation), null, operation);
    }
    // Existing ambiguous-canvas gates now point at the future unified entry.
    assert.throws(() => assertLegacyCanvasWriteAllowed(world.store, 'edge'), (error: {details?: {use?: string}}) =>
      error.details?.use === 'sequence.preview/commit');
    assert.doesNotThrow(() => assertLegacyCanvasWriteAllowed(format4, 'edge'));
  } finally {
    format4.close();
    rmSync(root, {recursive: true, force: true});
  }
});

test('the format-5 gate is a no-op for reads and for format-3/4 project stores', () => {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-fr0-format4-'));
  const format4 = createProjectStore({projectId: randomUUID(), projectFile: path.join(root, 'project.mioon'),
    locate: () => ({localDir: path.join(root, 'records'), cacheDir: path.join(root, 'cache'), tempDir: path.join(root, 'temp')})});
  try {
    for (const operation of Object.keys(EXPECTED)) assert.doesNotThrow(() => assertFormat5LegacyWriteAllowed(format4, operation));
  } finally {format4.close(); rmSync(root, {recursive: true, force: true});}
});
