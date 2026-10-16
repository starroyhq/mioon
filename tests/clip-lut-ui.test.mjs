import { translate, renderMessage, formatNumber } from '../packages/i18n/src/index.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { createClipLutController, clipLutSourceIssue, clipLutSourceMessage, clipLutFileIssue, prepareClipLutImport } from '../apps/web/src/clip-lut-state.ts';
import { createClipLutRecovery, clipLutRecoveryKey, clipLutRecoveryMetadata } from '../apps/web/src/clip-lut-recovery.ts';
import { clipDraftRaw, clipDraftPatch, createClipDraftController } from '../apps/web/src/clip-draft-state.ts';
import { clipDraftRawSchema, clipDraftDiskSchema } from '../packages/contracts/src/local-drafts.ts';
import { clipReplacementAcknowledged } from '../apps/web/src/clip-source-replacement.js';

const id = n => `90000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projectId = id(1), clipId = id(2), assetId = id(3), timelineId = id(4), trackId = id(5), stamp = '2026-10-14T18:00:00.000Z';
const hash = 'a'.repeat(64);
const context = patch => ({ scope: 'workspace:project', projectId, timelineId, clipId, assetId, assetSha256: hash, blocked: false, ...patch });
const inspection = patch => ({ projectId, assetId, assetSha256: hash, streamIndex: 0, evidence: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'limited', pixelFormat: 'yuv420p', bitDepth: 8, hdrMetadata: false }, status: 'compatible', reason: null, ...patch });
const source = { assetSha256: hash, streamIndex: 0, profileId: 'rec709-yuv-sdr-v1', range: 'limited', declaredBy: 'user', declaredAt: stamp };
const colour = patch => ({ profileId: 'mioon-rec709-sdr-clip-v1', source, look: null, ...patch });
const resource = patch => ({ id: id(10), projectId, name: 'look.cube', kind: 'cube3d', sha256: 'b'.repeat(64), sizeBytes: 65, profile: 'mioon-cube3d-normalized-tetrahedral-v1', metadata: { profileId: 'mioon-cube3d-normalized-tetrahedral-v1', size: 2, title: null, domainMin: [0, 0, 0], domainMax: [1, 1, 1], rowCount: 8, rowOrder: 'red-fastest', interpolation: 'tetrahedral', numericPrecision: 'float64' }, createdAt: stamp, colourCompatibility: 'unverified', renderBinding: 'not_implemented', ...patch });
const look = { resourceId: id(10), resourceSha256: 'b'.repeat(64), resourceProfile: 'mioon-cube3d-normalized-tetrahedral-v1', purpose: 'rec709-sdr-creative', declaredBy: 'user', enabled: true, strength: 0.37 };
const tick = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((y, n) => { resolve = y; reject = n; }); return { promise, resolve, reject }; };
function memoryRecovery(data = new Map(), overrides = {}) {
  const store = { getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); }, removeItem: key => { data.delete(key); }, ...overrides };
  return { data, store, adapter: createClipLutRecovery({ storage: () => store, lock: async (_name, action) => action() }) };
}
function harness(t, { current = context(), handler, imports = new Map(), timeoutMs = 1000, recoveryStore = new Map(), recoveryAdapter, workspaceReader } = {}) {
  let live = structuredClone(current), workspace = hash; const recovery = recoveryAdapter ?? memoryRecovery(recoveryStore).adapter; const calls = [], edits = [], changes = [];
  const controller = createClipLutController({ getContext: () => live, imports, recovery, readWorkspace: workspaceReader ?? (async key => ({ supported: true, workspaceScope: workspace, instanceId: id(70), key, revision: 0, targetStatus: 'matching', draft: null })), now: () => stamp, newRequestId: () => id(20), timeoutMs,
    rpc: async (operation, input) => { calls.push([operation, structuredClone(input)]); if (handler) { const result = handler(operation, input); if (result !== undefined) return result; }
      if (operation === 'timeline.colour.source.inspect') return inspection({ projectId: input.projectId, assetId: input.assetId });
      if (operation === 'lut.list') return { projectId: input.projectId, items: [resource()], nextAfter: null };
      if (operation === 'lut.inspect') return { resource: resource(), integrity: 'verified' };
      throw Error(`Unexpected ${operation}`); },
    edit: value => { edits.push(structuredClone(value)); live.colour = value; }, onChange: state => changes.push(state),
  });
  t.after(() => controller.dispose());
  return { controller, calls, edits, changes, state: () => controller.getState(), live: () => live, set: patch => { live = { ...live, ...patch }; }, imports, recovery, recoveryStore, setWorkspace: value => { workspace = value; } };
}

async function enabled(t, options) {
  const h = harness(t, options); h.controller.open(); await tick(); h.controller.chooseRange('limited'); h.controller.declareSource(true); assert.equal(h.controller.confirmSource(), true); return h;
}

test('legacy is unchanged until explicit open, range choice and source declaration', async t => {
  const h = harness(t); assert.deepEqual(h.calls, []); assert.deepEqual(h.edits, []);
  assert.equal(h.controller.confirmSource(), false); h.controller.open(); await tick();
  assert.deepEqual(h.calls.map(x => x[0]), ['timeline.colour.source.inspect', 'lut.list']);
  assert.equal(h.state().range, ''); assert.equal(h.state().sourceDeclared, false); assert.deepEqual(h.edits, []);
  h.controller.declareSource(true); assert.equal(h.controller.confirmSource(), false);
  h.controller.chooseRange('limited'); assert.equal(h.controller.confirmSource(), false, 'range changes revoke declaration');
  h.controller.declareSource(true); assert.equal(h.controller.confirmSource(), true);
  assert.deepEqual(h.edits, [colour()]); assert.equal(h.state().sourceDeclared, false);
  assert.equal(h.calls.some(x => x[0] === 'timeline.clip.update'), false, 'only common Save may persist the clip');
});

test('known HDR/Log/tag/range conflicts cannot be overridden by declaration', async t => {
  for (const value of [inspection({ status: 'unsupported', reason: 'HDR refused' }), inspection({ evidence: { ...inspection().evidence, hdrMetadata: true } }), inspection({ evidence: { ...inspection().evidence, transfer: 'smpte2084' } }), inspection({ evidence: { ...inspection().evidence, transfer: 'arib-std-b67' } }), inspection({ evidence: { ...inspection().evidence, transfer: 'log100' } }), inspection({ evidence: { ...inspection().evidence, primaries: 'bt2020' } }), inspection({ evidence: { ...inspection().evidence, matrix: 'bt470bg' } }), inspection({ evidence: { ...inspection().evidence, range: 'full' } })]) {
    const h = harness(t, { handler: op => op === 'timeline.colour.source.inspect' ? value : undefined }); h.controller.open(); await tick();
    h.controller.chooseRange('limited'); h.controller.declareSource(true); assert.equal(h.controller.confirmSource(), false); assert.deepEqual(h.edits, []);
  }
  const missing = inspection({ status: 'needs_interpretation', evidence: { ...inspection().evidence, primaries: null, transfer: null, matrix: null, range: null } });
  assert.equal(clipLutSourceIssue(missing, 'full'), ''); assert.ok(clipLutSourceIssue(missing, ''));
});

test('source inspection binds project asset and exact hash and ignores stale owners', async t => {
  for (const patch of [{ projectId: id(90) }, { assetId: id(91) }, { assetSha256: 'f'.repeat(64) }]) {
    const h = harness(t, { handler: op => op === 'timeline.colour.source.inspect' ? inspection(patch) : undefined }); h.controller.open(); await tick();
    assert.equal(h.state().sourcePhase, 'error'); assert.equal(h.state().inspection, null);
  }
  for (const patch of [{ projectId: id(90) }, { clipId: id(91) }, { assetId: id(92) }, { assetSha256: 'f'.repeat(64) }, { scope: 'new-open' }]) {
    const gate = deferred(), h = harness(t, { handler: op => op === 'timeline.colour.source.inspect' ? gate.promise : undefined }); h.controller.open(); h.set(patch); gate.resolve(inspection()); await tick();
    assert.equal(h.state().opened, false); assert.equal(h.state().inspection, null); assert.deepEqual(h.edits, []);
  }
});

test('resource inspection and creative declaration are separate from import and source confirmation', async t => {
  const h = await enabled(t); await h.controller.selectResource(id(10)); assert.equal(h.state().resourcePhase, 'ready');
  assert.equal(h.controller.applyLook(), false); h.controller.declareLook(true); assert.equal(h.controller.applyLook(), true);
  assert.deepEqual(h.live().colour.look, { ...look, strength: 1 });
  for (const strength of [0, 0.5, 1]) { assert.equal(h.controller.changeLook({ strength }), true); assert.equal(h.live().colour.look.strength, strength); }
  for (const strength of [-0.1, 1.1, NaN, Infinity]) assert.equal(h.controller.changeLook({ strength }), false);
  assert.equal(h.controller.changeLook({ enabled: false }), true); assert.equal(h.live().colour.look.enabled, false);
  assert.equal(h.controller.removeLook(), true); assert.equal(h.live().colour.look, null); assert.deepEqual(h.live().colour.source, source);
  assert.equal(h.controller.disableColour(), true); assert.equal(h.live().colour, null);
});

test('selection races, disconnected controls and reconfirmed replacement preserve safe boundaries', async t => {
  const gate = deferred(), h = await enabled(t, { handler: op => op === 'lut.inspect' ? gate.promise : undefined });
  const pending = h.controller.selectResource(id(10)); await h.controller.selectResource(''); gate.resolve({ resource: resource(), integrity: 'verified' }); await pending;
  assert.equal(h.state().selected, null); assert.equal(h.state().selectedId, '');
  h.set({ blocked: true }); h.controller.declareLook(true); assert.equal(h.controller.applyLook(), false); assert.equal(h.controller.disableColour(), false);
  const replacement = await enabled(t, { current: context({ colour: colour({ source: null, look }) }) });
  assert.deepEqual(replacement.live().colour.look, look); assert.deepEqual(replacement.live().colour.source, source);
});

const cube = 'LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n';
const file = () => new File([cube], 'look.cube');
const importResponse = input => ({ requestId: input.requestId, resource: resource({ name: input.name, sha256: createHash('sha256').update(Buffer.from(input.dataBase64, 'base64')).digest('hex'), sizeBytes: Buffer.from(input.dataBase64, 'base64').length }) });

test('explicit Cube imports are bounded, byte-exact and never change clip drafts', async t => {
  assert.ok(clipLutFileIssue({ name: 'look.png', size: 100 })); assert.ok(clipLutFileIssue({ name: 'look.cube', size: 7 * 1024 * 1024 + 1 })); assert.ok(clipLutFileIssue({ name: 'look.cube', size: 0 }));
  assert.equal(clipLutFileIssue({ name: 'look.CUBE', size: 7 * 1024 * 1024 }), '');
  const prepared = await prepareClipLutImport(file(), projectId, id(20)); assert.equal(Buffer.from(prepared.input.dataBase64, 'base64').toString(), cube);
  const h = harness(t, { handler: (op, input) => op === 'lut.import' ? importResponse(input) : undefined }); h.controller.open(); await tick();
  assert.equal(await h.controller.importFile(file()), true); assert.equal(h.state().importRecord.phase, 'imported'); assert.deepEqual(h.edits, []); assert.equal(h.state().selected, null);
  assert.equal(h.calls.filter(x => x[0] === 'lut.import').length, 1);
});

test('unknown imports block replacement files and retry only exact original bytes and request ID', async t => {
  let attempts = 0; const h = harness(t, { handler: (op, input) => { if (op !== 'lut.import') return; if (++attempts === 1) throw Error('Disconnected'); return importResponse(input); } });
  h.controller.open(); await tick(); assert.equal(await h.controller.importFile(file()), false); assert.equal(h.state().importRecord.phase, 'unknown');
  assert.equal(await h.controller.importFile(new File(['different'], 'other.cube')), false); assert.equal(attempts, 1);
  assert.equal(await h.controller.retryImport(), true); assert.equal(attempts, 2);
  const calls = h.calls.filter(x => x[0] === 'lut.import'); assert.deepEqual(calls[0][1], calls[1][1]); assert.deepEqual(h.edits, []);
});

test('hash-mismatched ACK is uncertain; same-session navigation retains exact retry without stale clip writes', async t => {
  const imports = new Map(), recoveryStore = new Map(), gate = deferred();
  const h = harness(t, { imports, recoveryStore, handler: op => op === 'lut.import' ? gate.promise : undefined }); h.controller.open(); await tick();
  const pending = h.controller.importFile(file()); while (!h.calls.some(x => x[0] === 'lut.import')) await new Promise(resolve => setTimeout(resolve, 0));
  h.set({ clipId: id(30) }); gate.resolve({ requestId: id(20), resource: resource({ sha256: 'f'.repeat(64) }) }); await pending;
  assert.equal(h.state().opened, false); assert.equal(h.state().importRecord, null); assert.deepEqual(h.edits, []);
  const next = harness(t, { imports, recoveryStore, current: context({ clipId: id(30) }), handler: (op, input) => op === 'lut.import' ? importResponse(input) : undefined });
  next.controller.open(); await tick(); assert.equal(next.state().importRecord.phase, 'unknown'); assert.equal(await next.controller.retryImport(), true);
  assert.deepEqual(next.calls.find(x => x[0] === 'lut.import')[1], h.calls.find(x => x[0] === 'lut.import')[1]);
});

test('stale chosen-file reads never dispatch import for a different clip or project', async t => {
  const gate = deferred(), h = harness(t); h.controller.open(); await tick();
  const pending = h.controller.importFile({ name: 'look.cube', size: cube.length, arrayBuffer: () => gate.promise });
  h.set({ projectId: id(40) }); gate.resolve(new TextEncoder().encode(cube).buffer); await pending;
  assert.equal(h.calls.some(x => x[0] === 'lut.import'), false); assert.deepEqual(h.edits, []);
});

const raw = { name: 'clip', trackId, startFrame: 0, durationFrames: 30, sourceInFrame: 0, rect: { x: 0, y: 0, width: 720, height: 1280 }, gain: 1 };
test('colour absent, null, disabled and full settings remain exact across raw patches and durable schema', () => {
  for (const extras of [{}, { colour: null }, { colour: colour({ look }) }, { colour: colour({ source: null, look: { ...look, enabled: false, strength: 0 } }) }]) {
    const value = { ...raw, ...extras }, parsed = clipDraftRawSchema.parse(value);
    assert.deepEqual(parsed, value); assert.deepEqual(clipDraftRaw(value), value); assert.deepEqual(clipDraftPatch(value), value);
    const disk = { version: 1, workspaceScope: hash, entries: [{ projectId, timelineId, clipId, revision: 1, draft: { baseRevision: 1, source: { assetId, assetSha256: hash }, raw: value, updatedAt: stamp } }] };
    assert.deepEqual(clipDraftDiskSchema.parse(JSON.parse(JSON.stringify(disk))), disk);
  }
  assert.equal(clipDraftPatch({ ...raw, colour: colour({ look: { ...look, strength: 2 } }) }), null);
});

test('common draft controller persists and restores LUT edits and rejects ACKs dropping colour', async t => {
  const key = { projectId, timelineId, clipId }, ctx = { ...key, scope: 's', restored: false, connected: true, busy: false, visible: true, timelineRevision: 1, source: { assetId, assetSha256: hash }, saved: raw };
  let record = { supported: true, workspaceScope: hash, instanceId: id(50), key, revision: 0, targetStatus: 'matching', draft: null }, deletes = 0;
  const client = { get: async () => structuredClone(record), put: async input => (record = { ...record, revision: record.revision + 1, draft: { raw: structuredClone(input.raw), source: input.source, baseRevision: input.baseRevision, updatedAt: stamp } }), remove: async () => { deletes++; return record = { ...record, revision: record.revision + 1, draft: null }; } };
  const c = createClipDraftController({ context: ctx, client, delay: 100000, validateTimeline: () => true }); t.after(() => c.dispose()); await c.load();
  assert.equal(c.edit('colour', colour({ look })), true); await c.flush(); assert.deepEqual(record.draft.raw.colour, colour({ look }));
  await c.save(async () => ({ id: timelineId, projectId, revision: 2, clips: [{ id: clipId, assetId, ...raw }] })); assert.equal(c.getState().dirty, true); assert.equal(deletes, 0);
  await c.save(async (_id, patch) => ({ id: timelineId, projectId, revision: 2, clips: [{ id: clipId, assetId, ...patch }] })); assert.equal(c.getState().dirty, false); assert.equal(deletes, 1);
});

test('source replacement ACK must clear interpretation but retain exact creative look', () => {
  const before = { id: clipId, assetId, ...raw, colour: colour({ look }) }, newId = id(60), review = { timelineId, projectId, clipId, expectedRevision: 1, clip: before, candidate: { assetId: newId } };
  const response = c => ({ id: timelineId, projectId, revision: 2, clips: [{ ...before, assetId: newId, colour: c }] });
  assert.equal(clipReplacementAcknowledged(review, response(colour({ look }))), false);
  assert.equal(clipReplacementAcknowledged(review, response(colour({ source: null, look }))), true);
  assert.equal(clipReplacementAcknowledged(review, response(colour({ source: null, look: { ...look, strength: 1 } }))), false);
  assert.equal(clipReplacementAcknowledged(review, response(null)), false);
});

function renderControls(state, ctx = context(), kind = 'video', locale = 'zh-Hans', options = {}) {
  const module = { exports: {} }, noop = () => {}, controller = options.controller ?? new Proxy({ getState: () => state }, { get: (target, key) => target[key] || noop });
  const react = { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), useRef: value => ({ current: value }), useState: () => [state, noop], useLayoutEffect: options.controller ? action => { action(); } : noop }; react.default = react;
  const output = transformSync(readFileSync(new URL('../apps/web/src/ClipLutControls.tsx', import.meta.url), 'utf8'), { loader: 'tsx', format: 'cjs' }).code;
  Function('require', 'module', 'exports', output)(name => {
    if (name === 'react') return react;
    if (name === './i18n/I18nProvider.tsx') return { useI18n: () => ({ t: (key, params) => translate(locale, key, params), renderMessage: value => renderMessage(locale, value), formatNumber: value => formatNumber(locale, value) }) };
    if (name === './LookPackControls.tsx') return { default: 'LookPackControls', LookPackDetails: 'LookPackDetails' };
    if (name === './clip-draft-client.ts') return { createClipDraftClient: () => ({ get: noop }) };
    if (name === './clip-lut-state.ts') return { createClipLutController: () => controller, clipLutSourceIssue, clipLutSourceMessage };
    if (name.startsWith('@mioon/ui/components/')) return { [name.split('/').at(-1).replace(/^./, value => value.toUpperCase())]: name };
    throw Error(`Unexpected ${name}`);
  }, module, module.exports);
  return module.exports.default({ context: ctx, kind, onEdit: options.onEdit ?? noop, rpc: options.rpc ?? noop, Select: 'Select' });
}
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : [];
const textOf = tree => Array.isArray(tree) ? tree.map(textOf).join(' ') : tree && typeof tree === 'object' ? textOf(tree.props?.children) : tree ?? '';
test('actual controls disclose whole-timeline adoption, source-ungraded status and import versus save', async t => {
  const h = harness(t); let tree = renderControls(h.state()); assert.match(textOf(tree), /不会自动迁移/); assert.match(textOf(tree), /所有可见视频/); assert.match(textOf(tree), /原始、未调色/);
  assert.equal(renderControls(h.state(), context(), 'audio'), null); assert.match(textOf(renderControls(h.state(), context(), 'image')), /sRGB.*Rec.709 \/ Gamma 2.4/);
  h.controller.open(); await tick(); const record = await prepareClipLutImport(file(), projectId, id(20)); record.phase = 'imported'; record.resource = resource();
  tree = renderControls({ ...h.state(), importRecord: record }, context({ colour: colour({ source: null, look }) }));
  const byId = id => nodes(tree).find(node => node.props?.['data-testid'] === id);
  assert.match(textOf(tree), /色彩解释已失效/); assert.match(textOf(byId('clip-lut-import-success')), /尚未应用或保存到片段/);
  assert.equal(byId('confirm-clip-colour-source').props.disabled, true); assert.equal(byId('apply-clip-lut').props.disabled, true);
  assert.match(textOf(byId('clip-lut-domain-disclosure')), /小于 0 或大于 1/); assert.match(textOf(byId('clip-lut-domain-disclosure')), /转换仍会执行/);
  assert.equal(byId('clip-lut-file').props.accept, '.cube'); assert.equal(byId('clip-lut-strength').props.min, 0); assert.equal(byId('clip-lut-strength').props.max, 100);
  assert.equal(nodes(tree).filter(node => String(node.type).includes('button')).every(node => node.props.type === 'button'), true);
  assert.match(readFileSync(new URL('../apps/web/src/TimelineInspector.jsx', import.meta.url), 'utf8'), /<ClipLutControls/);
  assert.match(readFileSync(new URL('../apps/web/src/Preview.jsx', import.meta.url), 'utf8'), /t\('timeline\.preview\.sourceUnprocessed'\)/);
  assert.match(translate('zh-Hans', 'timeline.preview.sourceUnprocessed'), /未调色，不应用片段 LUT/);
});

test('retained controls cannot act after disposal; source reinspection revokes old approval', async t => {
  const h = await enabled(t); h.controller.chooseRange('limited'); h.controller.declareSource(true);
  await h.controller.inspectSource(); assert.equal(h.state().sourceDeclared, false); assert.equal(h.state().range, '');
  const before = h.edits.length; h.controller.dispose(); h.controller.chooseRange('limited'); h.controller.declareSource(true);
  assert.equal(h.controller.confirmSource(), false); assert.equal(h.controller.disableColour(), false); assert.equal(h.edits.length, before);
});

test('timed-out imports remain uncertain and exact replay resolves them without creating another request', async t => {
  let attempt = 0;
  const h = harness(t, { timeoutMs: 15, handler: (op, input) => { if (op !== 'lut.import') return; return ++attempt === 1 ? new Promise(() => {}) : importResponse(input); } });
  h.controller.open(); await tick(); assert.equal(await h.controller.importFile(file()), false); assert.equal(h.state().importRecord.phase, 'unknown');
  assert.equal(await h.controller.retryImport(), true); assert.deepEqual(h.calls.filter(x => x[0] === 'lut.import')[0][1], h.calls.filter(x => x[0] === 'lut.import')[1][1]);
  assert.equal(h.imports.size, 0, 'Resolved imports release retained binary recovery bytes');
});

test('LUT project/hash mismatches and stale selection replies never become applicable', async t => {
  for (const patch of [{ projectId: id(91) }, { id: id(92) }, { sha256: 'f'.repeat(64) }]) {
    const h = await enabled(t, { handler: op => op === 'lut.inspect' ? { resource: resource(patch), integrity: 'verified' } : undefined });
    await h.controller.selectResource(id(10)); assert.equal(h.state().resourcePhase, 'error'); h.controller.declareLook(true); assert.equal(h.controller.applyLook(), false);
  }
  const gate = deferred(), h = await enabled(t, { handler: op => op === 'lut.inspect' ? gate.promise : undefined });
  const pending = h.controller.selectResource(id(10)); h.set({ clipId: id(93) }); gate.resolve({ resource: resource(), integrity: 'verified' }); await pending;
  assert.equal(h.state().selected, null); assert.equal(h.state().opened, false);
});

test('shared source evidence classifier blocks opaque RGB, alpha, unsupported depth and forged compatibility', () => {
  for (const patch of [{ pixelFormat: 'rgb24' }, { pixelFormat: 'yuva420p' }, { pixelFormat: 'yuv420p12le', bitDepth: 12 }, { bitDepth: 10 }]) {
    assert.ok(clipLutSourceIssue(inspection({ evidence: { ...inspection().evidence, ...patch } }), 'limited'));
  }
});

async function pendingRecovery(t, recoveryStore = new Map()) {
  const h = harness(t, { recoveryStore, handler: op => op === 'lut.import' ? Promise.reject(Error('Lost ACK')) : undefined });
  h.controller.open(); await tick(); assert.equal(await h.controller.importFile(file()), false);
  assert.equal(h.state().importRecord.phase, 'unknown'); return h;
}

test('pending metadata survives a fresh controller and changed editor scope; only reselect plus explicit retry dispatches', async t => {
  const original = await pendingRecovery(t), rawRecord = [...original.recoveryStore.values()][0], metadata = JSON.parse(rawRecord);
  assert.deepEqual(Object.keys(metadata), ['version', 'workspaceScope', 'projectId', 'requestId', 'name', 'sizeBytes', 'sha256']);
  assert.ok(Buffer.byteLength(rawRecord) < 2048); assert.equal(rawRecord.includes('dataBase64'), false); assert.equal(rawRecord.includes(cube), false);
  original.controller.dispose();
  const reopened = harness(t, { recoveryStore: original.recoveryStore, current: context({ scope: 'new-editor:after-restart', clipId: id(72) }), handler: (op, input) => op === 'lut.import' ? importResponse(input) : undefined });
  reopened.controller.open(); await tick(); assert.deepEqual(reopened.state().recovery, metadata); assert.equal(reopened.state().importRecord, null);
  assert.equal(reopened.calls.some(call => call[0] === 'lut.import'), false); assert.equal(await reopened.controller.retryImport(), false);
  assert.equal(await reopened.controller.importFile(file()), false, 'New requests cannot displace a retained request');
  assert.equal(await reopened.controller.reselectImportFile(file()), true);
  assert.equal(reopened.calls.some(call => call[0] === 'lut.import'), false, 'Reselection only verifies bytes');
  assert.equal(await reopened.controller.retryImport(), true);
  assert.deepEqual(reopened.calls.find(call => call[0] === 'lut.import')[1], original.calls.find(call => call[0] === 'lut.import')[1]);
  assert.equal(original.recoveryStore.size, 0); assert.deepEqual(reopened.edits, []);
});

test('reselected name, size or same-size different bytes cannot reuse the original request ID', async t => {
  const original = await pendingRecovery(t), stored = [...original.recoveryStore.values()][0];
  const reopened = harness(t, { recoveryStore: original.recoveryStore, imports: new Map() }); reopened.controller.open(); await tick();
  for (const wrong of [new File([cube], 'renamed.cube'), new File([cube + '\n'], 'look.cube'), new File([cube.replace('0 0 0', '0 0 1')], 'look.cube')]) {
    assert.equal(await reopened.controller.reselectImportFile(wrong), false); assert.equal(reopened.state().importRecord, null); assert.equal(await reopened.controller.retryImport(), false);
    assert.equal(reopened.calls.some(call => call[0] === 'lut.import'), false); assert.equal([...original.recoveryStore.values()][0], stored);
  }
});

test('verified workspace fingerprints isolate identical project IDs; live workspace changes block every import dispatch', async t => {
  const original = await pendingRecovery(t), stored = [...original.recoveryStore.values()][0];
  const other = harness(t, { recoveryStore: original.recoveryStore }); other.setWorkspace('d'.repeat(64)); other.controller.open(); await tick();
  assert.equal(other.state().recovery, null); assert.equal(await other.controller.retryImport(), false); assert.equal([...original.recoveryStore.values()][0], stored);
  const live = harness(t); live.controller.open(); await tick(); live.setWorkspace('d'.repeat(64));
  assert.equal(await live.controller.importFile(file()), false); assert.equal(live.calls.some(call => call[0] === 'lut.import'), false); assert.equal(live.recoveryStore.size, 0);
  assert.match(live.state().recoveryError, /身份已变化/);
  const reopened = harness(t, { recoveryStore: original.recoveryStore }); reopened.controller.open(); await tick(); assert.equal(await reopened.controller.reselectImportFile(file()), true);
  reopened.setWorkspace('e'.repeat(64)); assert.equal(await reopened.controller.retryImport(), false); assert.equal(reopened.calls.some(call => call[0] === 'lut.import'), false);
  assert.equal([...original.recoveryStore.values()][0], stored);
});

test('unverified, foreign-key, restored and missing-clip workspace replies prevent storage or import', async t => {
  const valid = key => ({ supported: true, workspaceScope: hash, instanceId: id(70), key, revision: 0, targetStatus: 'matching', draft: null });
  for (const workspaceReader of [async () => null, async () => ({ supported: false, reason: 'RESTORED_WORKSPACE_UNSUPPORTED' }), async key => ({ ...valid(key), key: { ...key, projectId: id(75) } }), async key => ({ ...valid(key), targetStatus: 'missing' }), async key => ({ ...valid(key), workspaceScope: 'unverified' })]) {
    const h = harness(t, { workspaceReader }); h.controller.open(); await tick(); assert.equal(h.state().recoveryPhase, 'error');
    assert.equal(await h.controller.importFile(file()), false); assert.equal(h.recoveryStore.size, 0); assert.equal(h.calls.some(call => call[0] === 'lut.import'), false);
    h.controller.chooseRange('limited'); h.controller.declareSource(true); assert.equal(h.controller.confirmSource(), true, 'Storage failure does not prevent source-only edits');
  }
});

test('quota errors and unconfirmed writes fail before RPC; already-written metadata stays recoverable', async t => {
  for (const afterWrite of [false, true]) {
    const data = new Map(), fixture = memoryRecovery(data, { setItem: (key, value) => { if (afterWrite) data.set(key, value); throw Error('QuotaExceededError'); } });
    const h = harness(t, { recoveryStore: data, recoveryAdapter: fixture.adapter }); h.controller.open(); await tick();
    assert.equal(await h.controller.importFile(file()), false); assert.equal(h.calls.some(call => call[0] === 'lut.import'), false); assert.equal(h.state().recoveryPhase, 'error');
    assert.equal(data.size, afterWrite ? 1 : 0);
    if (afterWrite) { const next = harness(t, { recoveryStore: data }); next.controller.open(); await tick(); assert.equal(next.state().recovery.requestId, id(20)); }
  }
  const h = harness(t, { recoveryAdapter: createClipLutRecovery({ storage: () => { throw Error('denied'); }, lock: async (_key, action) => action() }) });
  h.controller.open(); await tick(); assert.equal(h.state().recoveryPhase, 'error'); assert.equal(await h.controller.importFile(file()), false);
});

test('corrupt, duplicate-key, foreign-identity, extra-field and oversized metadata is preserved and blocks import', async t => {
  const prepared = await prepareClipLutImport(file(), projectId, id(20)), identity = { workspaceScope: hash, projectId }, metadata = clipLutRecoveryMetadata(identity, prepared);
  const raw = JSON.stringify(metadata), key = clipLutRecoveryKey(identity);
  const values = ['{', '[1]', raw.replace('"version":1', '"version":1,"version":1'), JSON.stringify({ ...metadata, workspaceScope: 'f'.repeat(64) }), JSON.stringify({ ...metadata, dataBase64: prepared.input.dataBase64 }), ' '.repeat(2049), JSON.stringify({ ...metadata, name: 'broken\ud800.cube' })];
  for (const bad of values) {
    const data = new Map([[key, bad]]), h = harness(t, { recoveryStore: data }); h.controller.open(); await tick();
    assert.equal(h.state().recoveryPhase, 'error'); assert.equal(await h.controller.importFile(file()), false); assert.equal(data.get(key), bad); assert.equal(h.calls.some(call => call[0] === 'lut.import'), false);
  }
});

test('new imports cannot overwrite another window’s pending metadata, and old success cannot clear a newer request', async t => {
  const data = new Map(), h = harness(t, { recoveryStore: data }), prepared = await prepareClipLutImport(file(), projectId, id(81));
  h.controller.open(); await tick(); const foreign = clipLutRecoveryMetadata({ workspaceScope: hash, projectId }, prepared); await h.recovery.reserve(foreign);
  assert.equal(await h.controller.importFile(file()), false); assert.equal(h.calls.some(call => call[0] === 'lut.import'), false); assert.deepEqual(await h.recovery.read(foreign), foreign);
  const earlier = { ...foreign, requestId: id(80) }; await assert.rejects(h.recovery.complete(earlier)); assert.deepEqual(await h.recovery.read(foreign), foreign);
});

test('a verified import ACK with failed metadata cleanup stays visibly successful and can clean up without another import', async t => {
  const data = new Map(); let refuse = true;
  const fixture = memoryRecovery(data, { removeItem: key => { if (refuse) throw Error('storage denied'); data.delete(key); } });
  const h = harness(t, { recoveryStore: data, recoveryAdapter: fixture.adapter, handler: (op, input) => op === 'lut.import' ? importResponse(input) : undefined });
  h.controller.open(); await tick(); assert.equal(await h.controller.importFile(file()), true);
  assert.equal(h.state().importRecord.phase, 'imported'); assert.ok(h.state().recovery); assert.equal(h.state().recoveryPhase, 'error'); assert.equal(h.calls.filter(call => call[0] === 'lut.import').length, 1);
  assert.equal(await h.controller.importFile(file()), false); refuse = false; assert.equal(await h.controller.clearConfirmedRecovery(), true);
  assert.equal(data.size, 0); assert.equal(h.state().recovery, null); assert.equal(h.calls.filter(call => call[0] === 'lut.import').length, 1);
});

test('actual reopened controls require reselect and explicit retry and disclose desktop and web persistence boundaries', async t => {
  const original = await pendingRecovery(t), h = harness(t, { recoveryStore: original.recoveryStore }); h.controller.open(); await tick();
  const tree = renderControls(h.state()), byId = id => nodes(tree).find(node => node.props?.['data-testid'] === id);
  assert.ok(byId('clip-lut-reselect')); assert.equal(byId('clip-lut-file').props.disabled, true); assert.equal(byId('retry-clip-lut-import'), undefined);
  assert.match(textOf(byId('clip-lut-recovery-disclosure')), /不保存 LUT 内容或路径/); assert.match(textOf(byId('clip-lut-recovery-disclosure')), /不会自动导入或应用/);
  assert.match(textOf(byId('clip-lut-recovery-disclosure')), /网页版仍仅支持同一站点地址/);
  assert.match(textOf(byId('clip-lut-recovery-disclosure')), /正常退出重启或本地地址变化后仍可恢复/);
  assert.match(textOf(byId('clip-lut-recovery-disclosure')), /清除相应本地数据会丢失记录/);
});

test('browser storage requires cross-window lock support and preserves one canonical pending request under concurrent reserve', async () => {
  const fixture = memoryRecovery(), identity = { workspaceScope: hash, projectId }, original = clipLutRecoveryMetadata(identity, await prepareClipLutImport(file(), projectId, id(20)));
  const unsupported = createClipLutRecovery({ storage: () => fixture.store });
  if (!globalThis.navigator?.locks?.request) await assert.rejects(unsupported.read(identity), /无法安全/);
  let tail = Promise.resolve(); const calls = [];
  const adapter = createClipLutRecovery({ storage: () => fixture.store, lock: (name, action) => { calls.push(name); const run = tail.then(action); tail = run.catch(() => {}); return run; } });
  const other = { ...original, requestId: id(82) }, attempts = await Promise.allSettled([adapter.reserve(original), adapter.reserve(other)]);
  assert.deepEqual(attempts.map(item => item.status), ['fulfilled', 'rejected']); assert.deepEqual(await adapter.read(identity), original);
  assert.ok(calls.every(name => name === clipLutRecoveryKey(identity))); await adapter.complete(original); assert.equal(fixture.data.size, 0);
});

test('metadata published before a blocked dispatch is retained without submitting and can be reselected after reconnect', async t => {
  const data = new Map(), fixture = memoryRecovery(data); let h;
  const adapter = { ...fixture.adapter, reserve: async value => { await fixture.adapter.reserve(value); h.set({ blocked: true }); } };
  h = harness(t, { recoveryStore: data, recoveryAdapter: adapter }); h.controller.open(); await tick();
  assert.equal(await h.controller.importFile(file()), false); assert.equal(h.calls.some(call => call[0] === 'lut.import'), false);
  assert.equal(data.size, 1); assert.equal(h.state().importing, false); assert.ok(h.state().recovery);
  h.set({ blocked: false }); assert.equal(await h.controller.reselectImportFile(file()), true); assert.equal(h.calls.some(call => call[0] === 'lut.import'), false);
});

test('selected project Look declaration is read-only, identity-bound and stale-selection fenced', async t => {
  const { parseLookPackBytes } = await import('../packages/business/src/look-pack.ts');
  const bytes = readFileSync(new URL('../examples/look-packs/synthetic-nonlinear.mioon-look.cube', import.meta.url));
  const pack = await parseLookPackBytes(bytes), packed = resource({ sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length, metadata: pack.cubeMetadata });
  let gate = null, bad = false;
  const h = harness(t, { handler: (operation, input) => {
    if (operation === 'lut.list') return { projectId, items: [packed], nextAfter: null };
    if (operation === 'lut.inspect') return { resource: packed, integrity: 'verified' };
    if (operation === 'lut.look.inspect') return gate?.promise ?? { resource: { ...packed, ...(bad ? { sha256: 'c'.repeat(64) } : {}) }, integrity: 'verified', status: 'verified', pack };
  } });
  h.controller.open(); await tick(); await h.controller.selectResource(packed.id);
  assert.equal(h.calls.some(([op]) => op === 'lut.look.inspect'), false, 'metadata read is explicit');
  await h.controller.inspectSelectedPack(); assert.deepEqual(h.state().pack, pack); assert.deepEqual(h.edits, []);
  bad = true; await h.controller.inspectSelectedPack(); assert.equal(h.state().packPhase, 'error'); assert.equal(h.state().pack, null);
  bad = false; gate = deferred(); const pending = h.controller.inspectSelectedPack();
  await h.controller.selectResource(''); gate.resolve({ resource: packed, integrity: 'verified', status: 'verified', pack }); await pending;
  assert.equal(h.state().packPhase, 'idle'); assert.equal(h.state().pack, null); assert.deepEqual(h.edits, []);
});

const imageInspection=patch=>({projectId,assetId,assetSha256:hash,kind:'image',status:'needs_interpretation',evidence:{profileId:'png-rgb8-srgb-v1',sha256:hash,sourceByteLength:123,width:64,height:48,bitDepth:8,alphaMode:'straight',orientation:1,colourTag:'untagged'},...patch});
test('PNG controller uses dedicated inspection and explicit sRGB declaration with no range guess',async t=>{
 const h=harness(t,{current:context({kind:'image'}),handler:op=>op==='timeline.colour.image.inspect'?imageInspection():undefined});h.controller.open();await tick();
 assert.equal(h.calls[0][0],'timeline.colour.image.inspect');assert.equal(h.state().sourcePhase,'ready');assert.equal(h.controller.confirmSource(),false);h.controller.declareSource(true);assert.equal(h.controller.confirmSource(),true);
 assert.equal(h.live().colour.profileId,'mioon-srgb-image-clip-v1');assert.equal(h.live().colour.source.interpretation,'srgb');assert.deepEqual(h.live().colour.source.evidence,imageInspection().evidence);assert.equal(Object.hasOwn(h.live().colour.source,'range'),false);
 await h.controller.selectResource(id(10));h.controller.declareLook(true);assert.equal(h.controller.applyLook(),true);assert.equal(h.live().colour.look.resourceId,id(10));assert.equal(h.calls.some(([op])=>op==='timeline.clip.update'),false);
});
test('PNG reply cannot widen colour, lose byte binding or survive kind/source changes',async t=>{
 for(const response of [imageInspection({assetSha256:'f'.repeat(64)}),imageInspection({status:'compatible'}),imageInspection({evidence:{...imageInspection().evidence,colourTag:'icc'}})]){const h=harness(t,{current:context({kind:'image'}),handler:op=>op==='timeline.colour.image.inspect'?response:undefined});h.controller.open();await tick();assert.equal(h.state().sourcePhase,'error');h.controller.declareSource(true);assert.equal(h.controller.confirmSource(),false);}
 const gate=deferred(),h=harness(t,{current:context({kind:'image'}),handler:op=>op==='timeline.colour.image.inspect'?gate.promise:undefined});h.controller.open();h.set({kind:'video'});gate.resolve(imageInspection());await tick();assert.equal(h.state().inspection,null);assert.deepEqual(h.edits,[]);
});
test('image controls disclose reference display, strict PNG admission, alpha and encoded composition',async t=>{
 const h=harness(t,{current:context({kind:'image'}),handler:op=>op==='timeline.colour.image.inspect'?imageInspection():undefined});h.controller.open();await tick();const tree=renderControls(h.state(),h.live(),'image'),all=textOf(tree);
 assert.match(all,/Gamma 2.4/);assert.match(all,/不是线性光或 HDR/);assert.match(all,/没有 sRGB 标签/);assert.match(all,/ICC \/ P3 \/ HDR/);assert.match(all,/系统和显示器/);assert.equal(nodes(tree).some(node=>node.props?.['data-testid']==='clip-lut-source-range'),false);
 const declaration=nodes(tree).find(node=>node.props?.['data-testid']==='clip-lut-source-declaration');assert.equal(declaration.props.checked,false);assert.equal(declaration.props.disabled,false);
});

test('confirmed cleanup acknowledged after disposal retires only its exact shared map entry', async t => {
  for (const replace of [false, true]) {
    const data = new Map(), imports = new Map(), fixture = memoryRecovery(data), gate = deferred(); let completes = 0;
    const adapter = { ...fixture.adapter, complete: async value => {
      if (++completes === 1) throw Error('initial cleanup unavailable');
      await fixture.adapter.complete(value); await gate.promise;
    } };
    const first = harness(t, { imports, recoveryStore: data, recoveryAdapter: adapter, handler: (op, input) => op === 'lut.import' ? importResponse(input) : undefined });
    first.controller.open(); await tick(); assert.equal(await first.controller.importFile(file()), true);
    const key = [...imports.keys()][0], original = imports.get(key), clearing = first.controller.clearConfirmedRecovery();
    await tick(); assert.equal(data.size, 0); first.controller.dispose();
    const replacement = { ...original, phase: 'unknown' }; if (replace) imports.set(key, replacement);
    gate.resolve(); assert.equal(await clearing, false, 'old UI remains fenced');
    if (replace) assert.equal(imports.get(key), replacement, 'newer shared entry is never cleared');
    else {
      assert.equal(imports.size, 0);
      const next = harness(t, { imports, recoveryStore: data }); next.controller.open(); await tick();
      assert.equal(next.state().recoveryPhase, 'ready'); assert.equal(next.state().recovery, null);
    }
    assert.equal(first.calls.filter(([op]) => op === 'lut.import').length, 1);
  }
});

test('lost cleanup ACK reconciles only confirmed outcomes after validated absent-hint read, without writes or retry', async t => {
  for (const phase of ['imported', 'rejected', 'unknown', 'sending']) {
    const data = new Map(), imports = new Map(), fixture = memoryRecovery(data), record = await prepareClipLutImport(file(), projectId, id(20));
    record.phase = phase;
    const key = clipLutRecoveryKey({ workspaceScope: hash, projectId }); imports.set(key, record);
    let writes = 0;
    const recovery = { ...fixture.adapter, reserve: async () => { writes++; }, complete: async () => { writes++; } };
    const h = harness(t, { imports, recoveryStore: data, recoveryAdapter: recovery }); h.controller.open(); await tick(); await h.controller.checkRecovery();
    const confirmed = ['imported', 'rejected'].includes(phase);
    assert.equal(h.state().recoveryPhase, confirmed ? 'ready' : 'error');
    assert.equal(imports.has(key), !confirmed);
    if (confirmed) assert.equal(h.state().importRecord?.phase ?? phase, phase);
    assert.equal(writes, 0); assert.equal(h.calls.some(([op]) => op === 'lut.import'), false); assert.deepEqual(h.edits, []);
  }
  const data = new Map(), imports = new Map(), fixture = memoryRecovery(data);
  const recovery = { ...fixture.adapter, complete: async value => { await fixture.adapter.complete(value); throw Error('cleanup committed, ACK lost'); } };
  const first = harness(t, { imports, recoveryStore: data, recoveryAdapter: recovery, handler: (op, input) => op === 'lut.import' ? importResponse(input) : undefined });
  first.controller.open(); await tick(); assert.equal(await first.controller.importFile(file()), true);
  assert.equal(data.size, 0); assert.equal(imports.size, 1); first.controller.dispose();
  const reopened = harness(t, { imports, recoveryStore: data }); reopened.controller.open(); await tick();
  assert.equal(reopened.state().recoveryPhase, 'ready'); assert.equal(reopened.state().importRecord.phase, 'imported');
  assert.equal(imports.size, 0); assert.equal(reopened.calls.some(([op]) => op === 'lut.import'), false);
});

test('absent-hint reconciliation preserves newer, foreign, mismatching and unconfirmed records', async t => {
  for (const scenario of ['replacement', 'unavailable', 'mismatch', 'scope']) {
    const data = new Map(), imports = new Map(), fixture = memoryRecovery(data), record = await prepareClipLutImport(file(), projectId, id(20));
    record.phase = 'imported';
    const key = clipLutRecoveryKey({ workspaceScope: hash, projectId }); imports.set(key, record);
    const replacement = { ...record, phase: 'unknown' };
    const other = clipLutRecoveryMetadata({ workspaceScope: hash, projectId }, { ...record, input: { ...record.input, requestId: id(81) } });
    const adapter = { ...fixture.adapter, read: async identity => {
      if (scenario === 'replacement') imports.set(key, replacement);
      if (scenario === 'unavailable') throw Error('read ACK missing');
      return scenario === 'mismatch' ? other : fixture.adapter.read(identity);
    } };
    const h = harness(t, { imports, recoveryStore: data, recoveryAdapter: adapter });
    if (scenario === 'scope') h.setWorkspace('b'.repeat(64));
    h.controller.open(); await tick();
    assert.equal(imports.get(key), scenario === 'replacement' ? replacement : record);
    assert.equal(h.calls.some(([op]) => op === 'lut.import'), false); assert.deepEqual(h.edits, []);
    if (scenario !== 'scope') assert.equal(h.state().recoveryPhase, 'error');
  }
});

const sourceInfoLocales = ['zh-Hans', 'zh-Hant', 'en', 'ja'];
const controlById = (tree, testId) => nodes(tree).find(node => node.props?.['data-testid'] === testId);
const renderLiveControls = (h, locale = 'en', kind = h.live().kind ?? 'video') => renderControls(h.state(), h.live(), kind, locale, {
  controller: h.controller,
  rpc: () => assert.fail('rendering source information must not dispatch a new RPC'),
  onEdit: () => assert.fail('rendering source information must not edit a clip'),
});
const assertControlMessage = (tree, testId, locale, key, params) => {
  const node = controlById(tree, testId);
  assert.ok(node, `${testId} is visible in ${locale}`);
  assert.equal(textOf(node), translate(locale, key, params));
};
const assertNoProbeEvidence = tree => {
  for (const testId of ['clip-lut-source-evidence', 'clip-lut-source-depth', 'clip-lut-source-provenance']) assert.equal(controlById(tree, testId), undefined, testId);
};
const assertReadOnlySourceCalls = (h, expected) => {
  assert.deepEqual(h.calls.map(([operation]) => operation), expected);
  assert.deepEqual(h.edits, []);
};

for (const locale of sourceInfoLocales) test(`video limits and unknown source are visible before any explicit probe (${locale})`, t => {
  for (const savedColour of [undefined, colour()]) {
    const h = harness(t, { current: context({ colour: savedColour }) });
    const tree = renderLiveControls(h, locale);
    assertControlMessage(tree, 'clip-lut-video-limits', locale, 'colour.lut.videoLimits');
    assertControlMessage(tree, 'clip-lut-source-uninspected', locale, 'colour.lut.sourceUninspected');
    assertNoProbeEvidence(tree);
    assert.equal(Boolean(controlById(tree, 'clip-lut-source-confirmed')), Boolean(savedColour), 'saved user interpretation is separate from probe evidence');
    assert.equal(controlById(tree, 'open-clip-lut').props.type, 'button');
    assert.equal(controlById(tree, 'inspect-clip-colour-source'), undefined);
    assertReadOnlySourceCalls(h, []);
  }
});

for (const locale of sourceInfoLocales) for (const depth of [8, 10, null]) test(`explicit source check shows exact ${depth ?? 'unknown'}-bit stream observations (${locale})`, async t => {
  const response = inspection({ streamIndex: 3, status: depth === null ? 'unsupported' : 'compatible',
    evidence: { ...inspection().evidence, pixelFormat: depth === 10 ? 'yuv422p10le' : 'yuv420p', bitDepth: depth } });
  const h = harness(t, { handler: operation => operation === 'timeline.colour.source.inspect' ? response : undefined });
  let tree = renderLiveControls(h, locale);
  assertReadOnlySourceCalls(h, []);
  assert.equal(controlById(tree, 'open-clip-lut').props.onClick(), true);
  await tick();
  assert.equal(h.state().sourcePhase, 'ready', 'the fixture is accepted by the existing inspection contract');
  tree = renderLiveControls(h, locale);
  assertControlMessage(tree, 'clip-lut-video-limits', locale, 'colour.lut.videoLimits');
  assertControlMessage(tree, 'clip-lut-source-depth', locale, 'colour.lut.videoBitDepth', { stream: 3, depth: depth ?? translate(locale, 'colour.lut.unknown') });
  assertControlMessage(tree, 'clip-lut-source-provenance', locale, 'colour.lut.videoEvidenceLimits');
  assertControlMessage(tree, 'clip-lut-source-evidence', locale, 'colour.lut.videoEvidence', {
    primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'limited', pixel: response.evidence.pixelFormat, hdr: translate(locale, 'colour.lut.noHdrMetadata'),
  });
  assert.equal(controlById(tree, 'clip-lut-source-uninspected'), undefined);
  assert.equal(h.state().inspection.evidence.bitDepth, depth, 'display does not fill a missing depth or reinterpret 10-bit as HDR');
  assert.equal(h.state().range, '');
  assert.equal(h.state().sourceDeclared, false);
  assert.equal(controlById(tree, 'confirm-clip-colour-source').props.disabled, true);
  renderLiveControls(h, locale);
  assertReadOnlySourceCalls(h, ['timeline.colour.source.inspect', 'lut.list']);
});

test('observed HDR, Log and non-709 tags remain raw and cannot be overridden from the actual controls', async t => {
  const cases = [
    { transfer: 'smpte2084' }, { transfer: 'arib-std-b67' }, { transfer: 'log100' },
    { primaries: 'bt2020' }, { matrix: 'bt470bg' }, { hdrMetadata: true }, { pixelFormat: 'yuv420p12le', bitDepth: 12 },
  ];
  for (const evidence of cases) {
    const response = inspection({ status: 'unsupported', reason: 'Observed tags are outside the supported source interpretation', evidence: { ...inspection().evidence, ...evidence } });
    const h = harness(t, { handler: operation => operation === 'timeline.colour.source.inspect' ? response : undefined });
    controlById(renderLiveControls(h), 'open-clip-lut').props.onClick(); await tick();
    assert.equal(h.state().sourcePhase, 'ready');
    const tree = renderLiveControls(h), allEvidence = textOf(controlById(tree, 'clip-lut-source-evidence'));
    for (const [field, value] of Object.entries(evidence)) if (typeof value === 'string') assert.ok(allEvidence.includes(value), `${field} is displayed without classification`);
    if (evidence.hdrMetadata) assert.ok(allEvidence.includes(translate('en', 'colour.lut.hdrMetadata')));
    if (evidence.bitDepth) assertControlMessage(tree, 'clip-lut-source-depth', 'en', 'colour.lut.videoBitDepth', { stream: 0, depth: evidence.bitDepth });
    assert.equal(controlById(tree, 'clip-lut-source-range').props.disabled, true);
    assert.equal(controlById(tree, 'clip-lut-source-declaration').props.disabled, true);
    assert.equal(controlById(tree, 'confirm-clip-colour-source').props.disabled, true);
    assert.ok(controlById(tree, 'clip-lut-source-issue'));
    controlById(tree, 'clip-lut-source-range').props.onChange({ target: { value: 'limited' } });
    controlById(tree, 'clip-lut-source-declaration').props.onChange({ target: { checked: true } });
    assert.equal(controlById(tree, 'confirm-clip-colour-source').props.onClick(), false, 'retained handlers do not bypass the original source guard');
    assertReadOnlySourceCalls(h, ['timeline.colour.source.inspect', 'lut.list']);
  }
});

test('missing tags and no reported HDR side data stay observations, with no automatic SDR declaration', async t => {
  for (const locale of sourceInfoLocales) {
    const response = inspection({ status: 'needs_interpretation', evidence: { ...inspection().evidence, primaries: null, transfer: null, matrix: null, range: null } });
    const h = harness(t, { handler: operation => operation === 'timeline.colour.source.inspect' ? response : undefined });
    controlById(renderLiveControls(h, locale), 'open-clip-lut').props.onClick(); await tick();
    const tree = renderLiveControls(h, locale), evidence = textOf(controlById(tree, 'clip-lut-source-evidence'));
    assert.equal(h.state().sourcePhase, 'ready');
    assert.equal(h.state().inspection.status, 'needs_interpretation');
    assert.equal(h.state().inspection.evidence.primaries, null);
    assert.ok(evidence.includes(translate(locale, 'colour.lut.untagged')));
    assert.ok(evidence.includes(translate(locale, 'colour.lut.noHdrMetadata')));
    assertControlMessage(tree, 'clip-lut-source-provenance', locale, 'colour.lut.videoEvidenceLimits');
    assert.equal(h.state().range, ''); assert.equal(h.state().sourceDeclared, false);
    assert.equal(controlById(tree, 'confirm-clip-colour-source').props.disabled, true);
    assertReadOnlySourceCalls(h, ['timeline.colour.source.inspect', 'lut.list']);
  }
  assert.match(translate('en', 'colour.lut.videoEvidenceLimits'), /10-bit depth or no reported HDR side data do not prove SDR/);
  assert.match(translate('en', 'colour.lut.videoEvidenceLimits'), /Log is not inferred from filenames or brands/);
  assert.match(translate('en', 'colour.lut.sourceUninspected'), /user declaration.*does not mean SDR/);
});

test('10-bit inspection remains read-only until the original range and declaration buttons are used', async t => {
  const response = inspection({ evidence: { ...inspection().evidence, pixelFormat: 'p010le', bitDepth: 10 } });
  const h = harness(t, { handler: operation => operation === 'timeline.colour.source.inspect' ? response : undefined });
  controlById(renderLiveControls(h), 'open-clip-lut').props.onClick(); await tick();
  let tree = renderLiveControls(h);
  assert.equal(controlById(tree, 'confirm-clip-colour-source').props.onClick(), false);
  controlById(tree, 'clip-lut-source-range').props.onChange({ target: { value: 'limited' } });
  tree = renderLiveControls(h);
  assert.equal(controlById(tree, 'confirm-clip-colour-source').props.disabled, true);
  assertReadOnlySourceCalls(h, ['timeline.colour.source.inspect', 'lut.list']);
  controlById(tree, 'clip-lut-source-declaration').props.onChange({ target: { checked: true } });
  tree = renderLiveControls(h);
  assert.equal(controlById(tree, 'confirm-clip-colour-source').props.disabled, false);
  assert.equal(controlById(tree, 'confirm-clip-colour-source').props.onClick(), true);
  assert.deepEqual(h.edits, [colour()]);
  assert.equal(Object.hasOwn(h.live().colour.source, 'evidence'), false, 'a video user declaration does not persist probe observations as technical conversion evidence');
  assert.deepEqual(h.calls.map(([operation]) => operation), ['timeline.colour.source.inspect', 'lut.list'], 'source confirmation still edits only the draft, with no Save, import or render RPC');
});

test('explicit reinspection clears old observations while loading and after probe errors', async t => {
  const gate = deferred(); let attempts = 0;
  const h = harness(t, { handler: operation => operation === 'timeline.colour.source.inspect' ? (++attempts === 1 ? inspection() : gate.promise) : undefined });
  controlById(renderLiveControls(h), 'open-clip-lut').props.onClick(); await tick();
  let tree = renderLiveControls(h);
  assert.ok(controlById(tree, 'clip-lut-source-depth'));
  controlById(tree, 'inspect-clip-colour-source').props.onClick();
  assert.equal(h.state().sourcePhase, 'loading');
  for (const locale of sourceInfoLocales) {
    tree = renderLiveControls(h, locale);
    assertControlMessage(tree, 'clip-lut-source-uninspected', locale, 'colour.lut.sourceUninspected');
    assertNoProbeEvidence(tree);
    assert.equal(controlById(tree, 'inspect-clip-colour-source').props.disabled, true);
  }
  gate.reject(Error('Synthetic inspection unavailable')); await tick();
  assert.equal(h.state().sourcePhase, 'error');
  for (const locale of sourceInfoLocales) {
    tree = renderLiveControls(h, locale);
    assertControlMessage(tree, 'clip-lut-source-uninspected', locale, 'colour.lut.sourceUninspected');
    assertNoProbeEvidence(tree);
    assert.equal(controlById(tree, 'confirm-clip-colour-source').props.disabled, true);
  }
  assertReadOnlySourceCalls(h, ['timeline.colour.source.inspect', 'lut.list', 'timeline.colour.source.inspect']);
});

test('a retained observed snapshot never displays probe evidence for a different project, asset or hash', async t => {
  const h = harness(t); controlById(renderLiveControls(h), 'open-clip-lut').props.onClick(); await tick();
  h.controller.chooseRange('limited'); h.controller.declareSource(true);
  const observed = h.state(); assert.ok(observed.inspection); assert.equal(observed.sourceDeclared, true);
  for (const patch of [{ projectId: id(90) }, { assetId: id(91) }, { assetSha256: 'f'.repeat(64) }]) {
    for (const locale of sourceInfoLocales) {
      const tree = renderControls(observed, context(patch), 'video', locale);
      assertControlMessage(tree, 'clip-lut-source-uninspected', locale, 'colour.lut.sourceUninspected');
      assertNoProbeEvidence(tree);
      assert.equal(controlById(tree, 'clip-lut-source-issue'), undefined, 'no old-source interpretation issue is attributed to the new source');
      assert.equal(controlById(tree, 'clip-lut-source-range').props.disabled, true);
      assert.equal(controlById(tree, 'confirm-clip-colour-source').props.disabled, true);
    }
  }
  assertReadOnlySourceCalls(h, ['timeline.colour.source.inspect', 'lut.list']);
});

test('source replacement drops late responses and requires an explicit check of the replacement bytes', async t => {
  const gate = deferred(), nextHash = 'f'.repeat(64); let attempts = 0;
  const h = harness(t, { handler: (operation, input) => operation === 'timeline.colour.source.inspect' ? (++attempts === 1 ? gate.promise : inspection({ assetId: input.assetId, assetSha256: nextHash, streamIndex: 2 })) : undefined });
  controlById(renderLiveControls(h), 'open-clip-lut').props.onClick();
  h.set({ assetId: id(91), assetSha256: nextHash }); h.controller.refresh();
  gate.resolve(inspection()); await tick();
  let tree = renderLiveControls(h);
  assert.equal(h.state().inspection, null); assertNoProbeEvidence(tree);
  assertControlMessage(tree, 'clip-lut-source-uninspected', 'en', 'colour.lut.sourceUninspected');
  assertReadOnlySourceCalls(h, ['timeline.colour.source.inspect', 'lut.list']);
  controlById(tree, 'open-clip-lut').props.onClick(); await tick(); tree = renderLiveControls(h);
  assert.equal(h.state().inspection.assetId, id(91)); assert.equal(h.state().inspection.assetSha256, nextHash);
  assertControlMessage(tree, 'clip-lut-source-depth', 'en', 'colour.lut.videoBitDepth', { stream: 2, depth: 8 });
  assertReadOnlySourceCalls(h, ['timeline.colour.source.inspect', 'lut.list', 'timeline.colour.source.inspect', 'lut.list']);
});

test('image and audio controls do not inherit video limits or video probe depth', async t => {
  const video = harness(t); controlById(renderLiveControls(video), 'open-clip-lut').props.onClick(); await tick();
  for (const locale of sourceInfoLocales) {
    const h = harness(t, { current: context({ kind: 'image' }), handler: operation => operation === 'timeline.colour.image.inspect' ? imageInspection() : undefined });
    for (const opened of [false, true]) {
      if (opened) { controlById(renderLiveControls(h, locale), 'open-clip-lut').props.onClick(); await tick(); }
      const tree = renderLiveControls(h, locale);
      for (const testId of ['clip-lut-video-limits', 'clip-lut-source-uninspected', 'clip-lut-source-depth', 'clip-lut-source-provenance', 'clip-lut-source-evidence']) assert.equal(controlById(tree, testId), undefined, testId);
      assert.equal(Boolean(controlById(tree, 'clip-image-source-evidence')), opened);
      assert.equal(renderLiveControls(h, locale, 'audio'), null);
    }
    assertReadOnlySourceCalls(h, ['timeline.colour.image.inspect', 'lut.list']);
    const retainedVideoTree = renderControls(video.state(), context({ kind: 'image' }), 'image', locale);
    for (const testId of ['clip-lut-video-limits', 'clip-lut-source-uninspected', 'clip-lut-source-depth', 'clip-lut-source-provenance', 'clip-lut-source-evidence']) assert.equal(controlById(retainedVideoTree, testId), undefined, `image cannot display retained ${testId}`);
    assert.equal(controlById(retainedVideoTree, 'clip-lut-source-issue'), undefined, 'image cannot inherit a video interpretation issue');
    assert.equal(controlById(retainedVideoTree, 'confirm-clip-colour-source').props.disabled, true);
  }
  assertReadOnlySourceCalls(video, ['timeline.colour.source.inspect', 'lut.list']);
});
