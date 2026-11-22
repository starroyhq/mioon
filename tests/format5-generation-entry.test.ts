import assert from 'node:assert/strict';
import test from 'node:test';
import {format5GenerationEntry} from '../apps/web/src/format5-generation-entry.ts';

const provider = {id: 'mock', name: 'Mock · simulated motion', mock: true, configured: true, enabled: true,
  status: 'available', models: ['mock-motion-v1'], modelCapabilities: [{id: 'mock-motion-v1', aspectRatios: ['9:16']}]};
const frame = {fps: 30, width: 720, height: 1280, revision: 7};
const shot = {id: 'shot-1', aspectRatio: '9:16', duration: 4, prompt: '雨夜', projectId: 'project-1'};

test('a format-5 generation entry always carries the project frame source', () => {
  const entry = format5GenerationEntry({shot, provider, model: 'mock-motion-v1', options: {}, frame});
  assert.equal(entry.issue, undefined);
  assert.deepEqual(entry.aspectSource, {kind: 'project', expectedTimelineRevision: 7, aspectRatio: '9:16'});
  assert.equal(entry.shot.aspectRatio, '9:16');
});
test('a missing frame stops the format-5 generation instead of submitting without aspectSource', () => {
  const entry = format5GenerationEntry({shot, provider, model: 'mock-motion-v1', options: {}, frame: null});
  assert.equal(entry.issue?.key, 'shell.generationFrameChanged');
  assert.equal(entry.aspectSource, undefined);
});
