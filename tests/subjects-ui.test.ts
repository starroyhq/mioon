import type {SubjectResponse,SubjectVersionResponse,SubjectBindingResponse} from '../packages/contracts/src/subjects.ts';
import type {SubjectControllerOptions,SubjectState,SubjectReadInput} from '../apps/web/src/subject-state.ts';
import type {ElementProps} from './helpers/strict-timeline-audio-harness-types.ts';
type SubjectController=Omit<ReturnType<typeof createSubjectController>,'create'> & {create:(scope?:string|null)=>Promise<SubjectResponse|null>};
type SubjectHook={state:SubjectState|null;controller:SubjectController};
type SubjectModule={default:(props:Record<string,unknown>)=>ElementTree;useSubjects:(options:unknown)=>SubjectHook;[key:string]:unknown};
type SaveOptions=Parameters<SubjectControllerOptions['save']>[2];
import type {ElementTree, ElementNode, HookSlot} from './helpers/strict-timeline-audio-harness-types.ts';
import { i18nTestModule, renderMessage } from './helpers/i18n.ts';
import { subjectsMessages } from '../packages/i18n/src/catalogs/subjects.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import * as subjectState from '../apps/web/src/subject-state.ts';

const { createSubjectController, subjectDraftDirty, filterSubjects, subjectImage } = subjectState;
const id = (kind: number, n = 1) => `${kind}0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projectId = id(1), otherProject = id(1, 2), shotId = id(2), subjectId = id(3), assetId = id(4), versionId = (n: number) => id(5, n);
const date = '2026-10-10T09:00:00.000Z';
const image = (n = 1, patch = {}) => ({ id: id(4, n), projectId, name: `Image ${n}`, mimeType: 'image/png', ...patch });
const version = (number = 1, patch = {}): SubjectVersionResponse => (({ id: versionId(number), projectId, subjectId, number, assetId: id(4, number), sha256: 'a'.repeat(64), mimeType: 'image/png', width: 64, height: 64, provenance: { kind: 'user-import', versionId: null, shotId: null, jobId: null }, createdAt: date, ...patch }) as unknown as SubjectVersionResponse);
const subject = (revision = 1, patch = {}): SubjectResponse => (({ id: subjectId, projectId, kind: 'character', name: 'Hero', revision, headVersionId: versionId(revision), headVersion: version(revision), createdAt: date, updatedAt: date, ...patch }) as unknown as SubjectResponse);
const binding = (patch = {}): SubjectBindingResponse => (({ id: id(6), projectId, shotId, subjectId, role: 'subject', revision: 1, subjectVersionId: versionId(1), reviewedHeadVersionId: versionId(1), headVersionId: versionId(1), subjectRevision: 1, needsReview: false, createdAt: date, updatedAt: date, ...patch }) as unknown as SubjectBindingResponse);
const context = (patch = {}) => ({ scope: `${projectId}:1`, projectId, assets: [image(), image(2)], shotIds: [shotId], ...patch });
const envelope = <T>(items: readonly T[]) => ({ projectId, items, nextCursor: null });
const defer = <T = unknown>() => { let resolve!: (value?: T | PromiseLike<T>) => void, reject!: (reason?: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = (a as (value?: T | PromiseLike<T>) => void); reject = b; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
async function fixture(options:Partial<SubjectControllerOptions> = {}) {
  const remote = { subject: subject(), bindings: [] as SubjectBindingResponse[], versions: [version()] }, writes: { operation: string; input: Record<string,unknown>; }[] = [];
  const controller = createSubjectController({
    requestId: () => `subject-request-${writes.length + 1}`,
    read: async operation => envelope<SubjectResponse|SubjectVersionResponse|SubjectBindingResponse>(operation === 'subject.list' ? [remote.subject] : operation === 'subject.version.list' ? remote.versions : remote.bindings),
    save: async (operation, input) => {
      writes.push({ operation, input });
      if (operation === 'subject.create') return remote.subject = subject(1, { kind: input.kind, name: input.name, headVersion: version(1, { assetId: input.assetId }) });
      if (operation === 'subject.version.add') { remote.subject = subject((input.expectedRevision as number) + 1, { headVersion: version((input.expectedRevision as number) + 1, { assetId: input.assetId }) }); remote.versions.unshift(remote.subject.headVersion); return remote.subject; }
      const result = binding({ ...Object.fromEntries(Object.entries(input).filter(([key]) => ['shotId', 'subjectId', 'role', 'subjectVersionId'].includes(key))), revision: (input.expectedRevision as number) + 1, subjectRevision: input.expectedSubjectRevision, headVersionId: versionId(input.expectedSubjectRevision as number), reviewedHeadVersionId: versionId(input.expectedSubjectRevision as number) }); remote.bindings = [result]; return result;
    }, ...options,
  });
  controller.setContext(context()); await flush();
  return { controller:controller as SubjectController, remote, writes };
}

test('only existing owned supported images are eligible and filters leave data untouched', () => {
  assert.equal(subjectImage(image(), projectId), true);
  for (const asset of [image(1, { projectId: otherProject }), image(1, { mimeType: 'image/gif' }), image(1, { mimeType: 'video/mp4' })]) assert.equal(subjectImage(asset, projectId), false);
  const rows = [subject(), subject(1, { id: id(3, 2), kind: 'look', name: 'Warm' })], before = structuredClone(rows);
  assert.deepEqual(filterSubjects(rows, { kind: 'look', search: 'wAr' }).map(row => row.name), ['Warm']); assert.deepEqual(rows, before);
});

test('create freezes one exact managed image, mints identity once, clears only a validated draft', async () => {
  const f = await fixture(); f.controller.updateCreate({ name: '  Hero  ', assetId, kind: 'character' });
  assert.equal(subjectDraftDirty(f.controller.getState()), true);
  const result = await f.controller.create(); assert.equal(result!.name, 'Hero');
  assert.deepEqual(f.writes[0], { operation: 'subject.create', input: { projectId, kind: 'character', name: 'Hero', assetId, requestId: 'subject-request-1' } });
  assert.equal(Object.isFrozen(f.writes[0].input), true); assert.equal(subjectDraftDirty(f.controller.getState()), false);
});

test('name/type-only drafts are guarded and readonly refresh never replaces unsaved input', async () => {
  const f = await fixture(); f.controller.updateCreate({ kind: 'look', name: 'Unsaved' });
  await f.controller.read(); assert.equal(f.controller.getState().createDraft.name, 'Unsaved'); assert.equal(subjectDraftDirty(f.controller.getState()), true);
  f.controller.resetCreate(); f.controller.updateCreate({ kind: 'look' }); assert.equal(subjectDraftDirty(f.controller.getState()), true);
  assert.equal(await f.controller.create(), null); assert.equal(f.writes.length, 0);
});

test('duplicate clicks and edits while preparing cannot create another mutation identity', async () => {
  const hold = defer(), calls: {op:string;input:Record<string,unknown>;options:SaveOptions}[] = [];
  const f = await fixture({ save: (op: string, input: Record<string,unknown>, options: SaveOptions) => { calls.push({ op, input, options }); return hold.promise; } });
  f.controller.updateCreate({ name: 'Hero', assetId }); const writing = f.controller.create();
  f.controller.updateCreate({ name: 'Changed' }); assert.equal(await f.controller.create(), null); assert.equal(calls.length, 1);
  assert.equal(calls[0].options.canExecute(), true); hold.resolve!(subject()); await writing;
  assert.equal(subjectDraftDirty(f.controller.getState()), false);
});

test('unknown and wrong acknowledgements retain original drafts and pending lane despite latest GET', async () => {
  for (const answer of [null, subject(2), subject(1, { projectId: otherProject }), { ok: true }]) {
    let pending = false, calls = 0;
    const f = await fixture({ hasPending: () => pending, save: async () => { calls++; pending = true; return answer; } });
    f.controller.updateCreate({ name: 'Hero', assetId }); await f.controller.create(); await f.controller.read();
    assert.equal(f.controller.getState().createDraft.name, 'Hero'); assert.equal(f.controller.getState().uncertain, true);
    await f.controller.create(); assert.equal(calls, 1); assert.match(renderMessage('zh-Hans', f.controller.getState().mutationError), /确认/);
  }
});

test('explicit discard invalidates prepared intent and stale completion cannot clear a new draft', async () => {
  const hold = defer(); let canExecute;
  const f = await fixture({ save: (_op: unknown, _input: unknown, options: SaveOptions) => { canExecute = options.canExecute; return hold.promise; } });
  f.controller.updateCreate({ name: 'Hero', assetId }); const writing = f.controller.create();
  assert.equal(f.controller.discardDrafts(), true); assert.equal(canExecute!(), false);
  hold.resolve!(subject()); await writing; assert.equal(subjectDraftDirty(f.controller.getState()), false);
});

test('project/epoch fences reject old GET, queued dispatch, ACK and retained prior-scope callbacks', async () => {
  const oldRead = defer(), oldWrite = defer(); let reads = 0, execute;
  const f = await fixture({ read: async (_op: unknown, input: SubjectReadInput) => ++reads === 2 ? oldRead.promise : { projectId: input.projectId, items: input.projectId === projectId ? [subject()] : [], nextCursor: null }, save: (_op: unknown, _input: unknown, options: SaveOptions) => { execute = options.canExecute; return oldWrite.promise; } });
  f.controller.updateCreate({ name: 'Hero', assetId }); const writing = f.controller.create(), reading = f.controller.read();
  f.controller.setContext(context({ scope: `${otherProject}:2`, projectId: otherProject })); await flush(); assert.equal(execute!(), false);
  f.controller.setContext(context({ scope: `${projectId}:3` })); await flush();
  oldRead.resolve!(envelope([subject(9)])); oldWrite.resolve!(subject()); await reading; await writing;
  assert.equal(f.controller.getState().subjects[subjectId].revision, 1); assert.equal(await f.controller.create(`${projectId}:1`), null);
  assert.equal(subjectDraftDirty(f.controller.getState()), false); f.controller.dispose(); assert.equal(await f.controller.create(), null);
});

test('append is CAS pinned to selected subject revision and requires explicit reconfirm after a newer head', async () => {
  const f = await fixture(); f.controller.updateVersion(subjectId, id(4, 2)); f.remote.subject = subject(2); f.remote.versions = [version(2), version()]; await f.controller.read();
  assert.equal(await f.controller.addVersion(subjectId), null); assert.equal(f.writes.length, 0); assert.equal(f.controller.getState().versionDrafts[subjectId].assetId, id(4, 2));
  f.controller.updateVersion(subjectId, id(4, 2)); await f.controller.addVersion(subjectId);
  assert.equal(f.writes[0].input.expectedRevision, 2); assert.equal(f.writes[0].input.subjectId, subjectId);
});

test('older list generations and stale subject revisions cannot replace a newer confirmed head', async () => {
  const old = defer(), newer = defer(); let reads = 0;
  const f = await fixture({ read: () => ++reads === 1 ? old.promise : reads === 2 ? newer.promise : Promise.resolve(envelope([subject()])) });
  const refresh = f.controller.read(); newer.resolve!(envelope([subject(3)])); await refresh;
  old.resolve!(envelope([subject()])); await flush(); await f.controller.read();
  assert.equal(f.controller.getState().subjects[subjectId].revision, 3);
});

test('invalid, foreign and duplicate pages fail closed without pretending an empty successful library', async () => {
  for (const result of [envelope([subject(), subject()]), { ...envelope([]), projectId: otherProject }, envelope([subject(1, { headVersionId: versionId(2) })])]) {
    const f = await fixture({ read: async () => result }); assert.equal(f.controller.getState().list.phase, 'error'); assert.equal(f.controller.getState().list.items.length, 0);
  }
});

test('list pagination is visible bounded and never silently scans or repeats a cursor', async () => {
  const calls: SubjectReadInput[] = [];
  const f = await fixture({ read: async (_op: unknown, input: SubjectReadInput) => { calls.push(input); return { ...envelope([subject()]), nextCursor: input.cursor ? null : 'page-two' }; } });
  assert.equal(calls.length, 1); assert.equal(calls[0].limit, 20);
  await f.controller.subjectPage('next'); assert.equal(calls[1].cursor, 'page-two'); assert.equal(f.controller.getState().list.history.length, 1);
  await f.controller.subjectPage('previous'); assert.equal('cursor' in calls[2], false);
  await f.controller.subjectPage('first'); assert.equal(f.controller.getState().list.history.length, 0);
});

test('focus and save refresh read only the active shot, leaving other cached shots stale until selected', async () => {
  const calls: { operation: unknown; input: SubjectReadInput; }[] = [], shotIds = Array.from({ length: 40 }, (_, index) => id(2, index + 1));
  const f = await fixture({ read: async (operation: string, input: SubjectReadInput) => { calls.push({ operation, input }); return envelope<SubjectResponse|SubjectVersionResponse|SubjectBindingResponse>(operation === 'subject.list' ? [subject()] : []); } });
  f.controller.setContext(context({ shotIds }));
  for (const shot of shotIds) await f.controller.readBindings(shot);
  calls.length = 0; await f.controller.read();
  const reads = calls.filter(call => call.operation === 'subject.binding.list');
  assert.equal(reads.length, 1); assert.equal(reads[0].input.shotId, shotIds.at(-1));
  assert.equal(f.controller.getState().bindings[shotIds[0]].phase, 'stale');
  await f.controller.readBindings(shotIds[0]); assert.equal(f.controller.getState().bindings[shotIds[0]].phase, 'ready');
});

test('binding drafts capture exact historical version and use tombstone revision for relink', async () => {
  const f = await fixture(); f.remote.subject = subject(2); f.remote.versions = [version(2), version()]; f.remote.bindings = [binding({ revision: 4, subjectVersionId: null, subjectRevision: 2, headVersionId: versionId(2), reviewedHeadVersionId: versionId(2) })];
  await f.controller.read(); await f.controller.readBindings(shotId); await f.controller.readVersions(subjectId);
  f.controller.chooseBinding(shotId, subjectId, versionId(1)); await f.controller.setBinding(shotId);
  assert.equal(f.writes[0].input.subjectVersionId, versionId(1)); assert.equal(f.writes[0].input.expectedRevision, 4); assert.equal(f.writes[0].input.expectedSubjectRevision, 2);
  assert.equal(f.controller.getState().bindingDrafts[shotId], null);
});

test('review keeps or updates the exact pinned version; unlink retains independent revision', async () => {
  for (const chosen of [versionId(1), versionId(2), null]) {
    const f = await fixture(); f.remote.subject = subject(2); f.remote.bindings = [binding({ revision: 7, subjectRevision: 2, headVersionId: versionId(2), needsReview: true })]; await f.controller.read(); await f.controller.readBindings(shotId);
    const row = f.controller.getState().bindings[shotId].items[0]; await f.controller.reviewBinding(row, chosen);
    assert.equal(f.writes[0].input.subjectVersionId, chosen); assert.equal(f.writes[0].input.expectedRevision, 7); assert.equal(f.writes[0].input.expectedSubjectRevision, 2);
    assert.equal(f.controller.getState().bindings[shotId].items[0].revision, 8);
    assert.equal(await f.controller.reviewBinding(row, chosen), null);
  }
});

test('late historical binding ACK preserves newer head and binding clocks even when follow-up reads fail', async () => {
  for (const newer of [
    binding({ revision: 2, subjectRevision: 2, headVersionId: versionId(2), needsReview: true }),
    binding({ revision: 3, subjectVersionId: versionId(2), reviewedHeadVersionId: versionId(2), subjectRevision: 3, headVersionId: versionId(3), needsReview: true }),
  ]) {
    const hold = defer(), ack = binding({ revision: 2 }), unchangedAck = structuredClone(ack); let remote = binding(), failed = false;
    const f = await fixture({ read: async (operation: string) => { if (failed) throw Error('Refresh offline'); return envelope<SubjectResponse|SubjectVersionResponse|SubjectBindingResponse>(operation === 'subject.list' ? [subject()] : operation === 'subject.binding.list' ? [remote] : [version()]); }, save: () => hold.promise });
    await f.controller.readBindings(shotId); f.controller.chooseBinding(shotId, subjectId, versionId(1)); const writing = f.controller.setBinding(shotId);
    remote = newer; await f.controller.readBindings(shotId); failed = true; hold.resolve!(ack); const receipt = await writing;
    const entry = f.controller.getState().bindings[shotId];
    assert.equal(receipt, ack, 'The exact historical receipt remains the acknowledgement'); assert.deepEqual(ack, unchangedAck);
    assert.deepEqual(entry.items[0], newer); assert.deepEqual(entry.known![ack.id], newer); assert.equal(entry.phase, 'error');
    assert.equal(entry.items[0].needsReview, true); assert.equal(f.controller.getState().bindingDrafts[shotId], null);
  }
});

test('GET begun before ACK installation merges against live binding cache, including failed refresh', async () => {
  const saveHold = defer(), readHold = defer(), refreshHold = defer(); let holdGet = false, holdRefresh = false, failReads = false;
  const ack = binding({ revision: 2 });
  const f = await fixture({ read: (operation: string) => {
    if (failReads) return Promise.reject(Error('Refresh offline'));
    if (operation === 'subject.list') return holdRefresh ? refreshHold.promise : Promise.resolve(envelope([subject()]));
    if (operation === 'subject.binding.list') return holdGet ? readHold.promise : Promise.resolve(envelope([binding()]));
    return Promise.resolve(envelope([version()]));
  }, save: () => saveHold.promise });
  await f.controller.readBindings(shotId); f.controller.chooseBinding(shotId, subjectId, versionId(1)); const writing = f.controller.setBinding(shotId);
  holdGet = true; const reading = f.controller.readBindings(shotId); holdRefresh = true; saveHold.resolve!(ack); await flush();
  assert.equal(f.controller.getState().bindings[shotId].items[0].revision, 2);
  readHold.resolve!(envelope([binding()])); await reading;
  assert.equal(f.controller.getState().bindings[shotId].items[0].revision, 2, 'A pre-ACK GET cannot restore its captured old cache');
  failReads = true; refreshHold.reject!(Error('Refresh offline')); await writing;
  assert.equal(f.controller.getState().bindings[shotId].items[0].revision, 2); assert.equal(f.controller.getState().bindings[shotId].phase, 'error');
});

test('binding merge preserves independent clocks and rejects contradictory equal revisions', () => {
  const newerHead = binding({ subjectRevision: 2, headVersionId: versionId(2), needsReview: true }), ack = binding({ revision: 2 });
  const merged = subjectState.mergeSubjectBinding(newerHead, ack);
  assert.equal(merged.revision, 2); assert.equal(merged.subjectRevision, 2); assert.equal(merged.needsReview, true); assert.equal(ack.needsReview, false);
  for (const contradictory of [binding({ subjectVersionId: versionId(2) }), binding({ reviewedHeadVersionId: versionId(2), needsReview: true }), binding({ updatedAt: '2026-10-11' }), binding({ headVersionId: versionId(2), needsReview: true })])
    assert.throws(() => subjectState.mergeSubjectBinding(binding(), contradictory), /不匹配/);
});

test('partial binding list blocks writes until all explicitly requested pages have been read', async () => {
  const f = await fixture({ read: async (op: string, input: SubjectReadInput) => op === 'subject.binding.list' ? { ...envelope(input.cursor ? [binding()] : []), nextCursor: input.cursor ? null : 'remaining-bindings' } : envelope([subject()]) });
  await f.controller.readBindings(shotId); f.controller.chooseBinding(shotId, subjectId, versionId(1)); assert.equal(f.controller.getState().bindingDrafts[shotId], undefined);
  await f.controller.readBindings(shotId, f.controller.getState().scope, true); f.controller.chooseBinding(shotId, subjectId, versionId(1)); assert.equal(f.controller.getState().bindingDrafts[shotId]!.expectedRevision, 1);
});

test('eight active bindings prevent adding a ninth but allow editing existing and style role is derived explicitly', async () => {
  const f = await fixture(); f.remote.bindings = Array.from({ length: 8 }, (_, index) => binding({ id: id(6, index + 1), subjectId: id(3, index + 2) })); await f.controller.readBindings(shotId);
  f.controller.chooseBinding(shotId, subjectId, versionId(1)); assert.equal(await f.controller.setBinding(shotId), null); assert.equal(f.writes.length, 0);
  f.remote.subject = subject(2, { kind: 'look' }); f.remote.versions = [version(2)]; f.remote.bindings = f.remote.bindings.map(row => ({ ...row, revision: 2, subjectVersionId: null })); await f.controller.read(); await f.controller.readBindings(shotId);
  f.controller.chooseBinding(shotId, subjectId, versionId(2)); assert.equal(f.controller.getState().bindingDrafts[shotId]!.role, 'style');
});

const nodes = (value: ElementTree): ElementNode[] => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value, ...nodes(value.props?.children)] : [];
function harness(filename: string) {
  const slots: HookSlot[] = []; let cursor = 0, effects: number[] = []; type CapturedHarness1 = { visible: boolean; locale: import('../packages/i18n/src/index.ts').Locale; } & {
"render": (props: Record<string,unknown>, name?: string) => ElementNode[];
"renderWithSubjects": (options: unknown, props?: {}) => ElementNode[];
"subjects": SubjectHook;
"unmount": () => void;
};
const h = { visible: true, locale: 'zh-Hans' } as CapturedHarness1;
  const react = { createElement: (type: unknown, props: Record<string,unknown>|null, ...children: ElementTree[]) => ({ type, props: { ...props, children } }),
    useRef: (value: unknown) => { const index = cursor++; return slots[index] ||= { current: value }; },
    useState: (value: unknown) => { const index = cursor++; if (!slots[index]) slots[index] = { value }; return [slots[index].value, (next: unknown) => { slots[index].value = typeof next === 'function' ? next(slots[index].value) : next; }]; },
    useMemo: (fn: () => unknown, deps: readonly unknown[] | undefined) => { const index = cursor++; if (!slots[index] || deps!.some((value: unknown, i: number) => value !== slots[index].deps![i])) slots[index] = { value: fn(), deps }; return slots[index].value; },
    useLayoutEffect: (fn: () => void | (() => void), deps: readonly unknown[] | undefined) => { const index = cursor++; if (!slots[index] || deps!.some((value: unknown, i: number) => value !== slots[index].deps![i])) { slots[index] = { fn, deps, cleanup: slots[index]?.cleanup }; effects.push(index); } },
    useEffect: () => { cursor++; },
  };
  const modules:Record<string,SubjectModule> = {};
  function load(file: string):SubjectModule {
    if (modules[file]) return modules[file];
    const source = readFileSync(new URL(`../apps/web/src/${file}`, import.meta.url), 'utf8'), code = transformSync(source, { loader: file.endsWith('.tsx') ? 'tsx' : file.endsWith('.ts') ? 'ts' : 'jsx', format: 'cjs' }).code, module = { exports: {} as SubjectModule };
    Function('require', 'module', 'exports', code)((name: string) => name === 'react' ? { ...react, default: react } : name === './i18n/I18nProvider.tsx' ? { useI18n: () => i18nTestModule(h.locale).useI18n() } : name.endsWith('subject-state.ts') ? subjectState : name.endsWith('workspace-visibility.tsx') ? { useWorkspaceVisibility: () => h.visible } : name.endsWith('use-subjects.ts') ? load('use-subjects.ts') : name==='./AgentEditingBoundary.tsx' ? {__esModule:true,default:'AgentEditingBoundary'} : name.endsWith('api.ts') ? { assetUrl: (asset: { id: unknown; }) => `/media/${asset.id}` } : new Proxy({}, { get: (_, key) => String(key) }), module, module.exports);
    return modules[file] = module.exports;
  }
  const component = load(filename);
  const render = (action: ()=>ElementTree) => { cursor = 0; effects = []; const tree = action(); for (const index of effects) { slots[index].cleanup?.(); slots[index].cleanup = slots[index].fn!(); } return nodes(tree); };
  h.render = (props: Record<string,unknown>, name = 'default') => render(() => (component[name] as (props:Record<string,unknown>)=>ElementTree)(props));
  h.renderWithSubjects = (options: unknown, props = {}) => render(() => { h.subjects = load('use-subjects.ts').useSubjects(options); return component.default({ ...props, subjects: h.subjects }); });
  h.unmount = () => slots.forEach(slot => slot?.cleanup?.()); return h;
}
const byId = (tree: ElementNode[], id: string) => tree.find((node: ElementNode) => node.props?.['data-testid'] === id);

test('subject library renders a passive loading state before its context exists, including while hidden', () => {
  const h = harness('SubjectLibrary.tsx');
  const controller = createSubjectController({ read: async () => assert.fail('Loading view read'), save: async () => assert.fail('Loading view saved') });
  for (const visible of [true, false]) {
    h.visible = visible;
    for (const props of [{}, { subjects: null }, { subjects: { state: null, controller } }]) {
      const tree = h.render(props);
      assert.ok(byId(tree, 'subject-library'));
      assert.ok(tree.some((node: ElementNode) => node.props?.role === 'status'));
      assert.equal(tree.some((node: ElementNode) => typeof node.props?.onClick === 'function' || typeof node.props?.onChange === 'function'), false);
    }
  }
  h.unmount();
});

test('first project mount becomes usable after layout context setup without replacing its controller', async () => {
  const h = harness('SubjectLibrary.tsx'), reads: { operation: unknown; input: SubjectReadInput; }[] = [], writes: (unknown[])[] = [];
  const options = { ...context(), read: async (operation: string, input: SubjectReadInput) => { reads.push({ operation, input }); return envelope([subject()]); }, save: async (...args: unknown[]) => { writes.push(args); return null; } };
  const first = h.renderWithSubjects(options);
  const controller = h.subjects.controller;
  assert.equal(h.subjects.state, null);
  assert.ok(first.some((node: ElementNode) => node.props?.role === 'status'));
  assert.equal(byId(first, 'subject-new'), undefined);
  await flush();
  const ready = h.renderWithSubjects(options);
  assert.equal(h.subjects.controller, controller);
  assert.equal(h.subjects.state!.projectId, projectId);
  assert.equal(byId(ready, 'subject-new')!.props.disabled, false);
  assert.ok(byId(ready, `subject-card-${subjectId}`));
  assert.deepEqual(reads.map(row => row.input.projectId), [projectId]);
  assert.equal(writes.length, 0);
  h.unmount();
});

test('project switch withholds old subjects and drafts and rejects retained callbacks before new context is ready', async () => {
  const h = harness('SubjectLibrary.tsx'), lateA = defer(), reads: ({ operation: unknown; input: SubjectReadInput; })[] = [], writes: (unknown[])[] = [];
  let delayA = false;
  const read = async (operation: unknown, input: SubjectReadInput) => {
    reads.push({ operation, input });
    if (input.projectId === projectId) return delayA ? lateA.promise : envelope([subject()]);
    return { projectId: otherProject, items: [], nextCursor: null };
  };
  const save = async (...args: unknown[]) => { writes.push(args); return null; };
  const a = { ...context(), read, save };
  h.renderWithSubjects(a); await flush(); h.renderWithSubjects(a);
  const controller = h.subjects.controller;
  controller.updateCreate({ name: 'Project A private draft', assetId });
  const create = byId(h.renderWithSubjects(a), 'subject-create');
  delayA = true;
  const oldRead = controller.read();
  const b = { ...context({ scope: `${otherProject}:2`, projectId: otherProject, assets: [], shotIds: [] }), read, save };
  const transitioning = h.renderWithSubjects(b);
  assert.equal(h.subjects.state, null);
  assert.ok(transitioning.some((node: ElementNode) => node.props?.role === 'status'));
  assert.equal(JSON.stringify(transitioning).includes('Project A private draft'), false);
  assert.equal(byId(transitioning, 'subject-create'), undefined);
  create!.props.onClick();
  assert.equal(writes.length, 0);
  await flush();
  const ready = h.renderWithSubjects(b);
  assert.equal(h.subjects.controller, controller);
  assert.equal(h.subjects.state!.projectId, otherProject);
  assert.equal(h.subjects.state!.createDraft.name, '');
  assert.deepEqual((h.subjects.state!.list.items as unknown), []);
  assert.equal(byId(ready, `subject-card-${subjectId}`), undefined);
  lateA.resolve!(envelope([subject()])); await oldRead; await flush();
  h.renderWithSubjects(b);
  assert.equal(h.subjects.state!.projectId, otherProject);
  assert.deepEqual((h.subjects.state!.list.items as unknown), []);
  assert.equal(reads.filter(row => row.input.projectId === otherProject).length, 1);
  assert.equal(writes.length, 0);
  h.unmount();
});

test('real library callbacks reject hidden, re-shown, stale form, wrong project and unmounted events', async () => {
  const f = await fixture(); f.controller.updateCreate({ name: 'Hero', assetId }); const h = harness('SubjectLibrary.tsx');
  const props = () => ({ subjects: { state: f.controller.getState(), controller: f.controller }, assets: [image()] });
  const first = byId(h.render(props()), 'subject-create'); h.visible = false; const hidden = byId(h.render(props()), 'subject-create'); assert.equal(hidden!.props.disabled, true); first!.props.onClick(); assert.equal(f.writes.length, 0);
  h.visible = true; const shown = byId(h.render(props()), 'subject-create'); first!.props.onClick(); hidden!.props.onClick(); assert.equal(f.writes.length, 0);
  f.controller.updateCreate({ name: 'Changed' }); const changed = byId(h.render(props()), 'subject-create'); shown!.props.onClick(); assert.equal(f.writes.length, 0);
  f.controller.setContext(context({ scope: `${otherProject}:2`, projectId: otherProject })); changed!.props.onClick(); assert.equal(f.writes.length, 0);
  h.unmount(); changed!.props.onClick(); assert.equal(f.writes.length, 0);
});

test('shot controls render exact Use V2 and Keep V1 choices and reject retained row callbacks', async () => {
  const f = await fixture(); f.remote.subject = subject(2); f.remote.versions = [version(2), version()]; f.remote.bindings = [binding({ subjectRevision: 2, headVersionId: versionId(2), needsReview: true })]; await f.controller.read(); await f.controller.readBindings(shotId); await f.controller.readVersions(subjectId);
  const h = harness('ShotSubjectBindings.tsx'), state = f.controller.getState(), row = state.bindings[shotId].items[0];
  const props = { binding: row, state, controller: f.controller, assets: [image(), image(2)], scope: state.scope };
  const tree = h.render(props, 'BoundSubject'); const use = byId(tree, `subject-use-head-${row.id}`), keep = byId(tree, `subject-keep-version-${row.id}`);
  assert.equal(use!.props.disabled, false); assert.match(JSON.stringify(use!.props.children), /V2/); assert.match(JSON.stringify(keep!.props.children), /V1/);
  const pinnedImage = nodes(byId(tree, `subject-review-pinned-${row.id}`)).find((node: ElementNode) => node.type === 'SubjectImage');
  const headImage = nodes(byId(tree, `subject-review-head-${row.id}`)).find((node: ElementNode) => node.type === 'SubjectImage');
  assert.equal((pinnedImage!.props.version as SubjectVersionResponse).id, row.subjectVersionId); assert.equal((pinnedImage!.props.version as SubjectVersionResponse).assetId, assetId);
  assert.equal((headImage!.props.version as SubjectVersionResponse).id, row.headVersionId); assert.equal((headImage!.props.version as SubjectVersionResponse).assetId, id(4, 2));
  h.visible = false; h.render(props, 'BoundSubject'); use!.props.onClick(); assert.equal(f.writes.length, 0);
  h.visible = true; h.render(props, 'BoundSubject'); keep!.props.onClick(); assert.equal(f.writes.length, 0);
});

test('new binding displays the exact selected historical image rather than silently previewing head', async () => {
  const f = await fixture(); f.remote.subject = subject(2); f.remote.versions = [version(), version(2)]; await f.controller.read(); await f.controller.readBindings(shotId); await f.controller.readVersions(subjectId);
  f.controller.chooseBinding(shotId, subjectId, versionId(1));
  const h = harness('ShotSubjectBindings.tsx'), state = f.controller.getState();
  const tree = h.render({ shot: { id: shotId, projectId }, subjects: { state, controller: f.controller }, assets: [image(), image(2)] });
  const preview = byId(tree, 'shot-subject-selected-preview'), displayed = nodes(preview).find((node: ElementNode) => node.type === 'SubjectImage');
  assert.equal((displayed!.props.version as SubjectVersionResponse).id, versionId(1)); assert.equal((displayed!.props.version as SubjectVersionResponse).assetId, assetId); assert.match(displayed!.props.label as string, /V1/);
});

test('library composition retains both panes and never changes source/range selection or imports images', () => {
  const library = readFileSync(new URL('../apps/web/src/AssetLibrary.tsx', import.meta.url), 'utf8');
  assert.match(library, /library-subjects-pane/); assert.match(library, /WorkspaceVisibilityProvider visible=\{libraryView === 'assets'\}/); assert.match(library, /hidden=\{libraryView !== 'subjects'\} inert=\{libraryView !== 'subjects'\}/);
  assert.doesNotMatch(library, /setQuickAssetId|setSelectedClipId|sourceRangeScope/);
  // The subject's shot usage moved from the library list to the properties pane (C7b).
  const componentSources = ['SubjectInspector.tsx', 'ShotSubjectBindings.tsx', 'SubjectLibrary.tsx'].map(file => readFileSync(new URL(`../apps/web/src/${file}`, import.meta.url), 'utf8'));
  for (const component of componentSources.slice(0, 2)) {
    assert.match(component, /subjects.library.planningNote/);
    assert.equal(subjectsMessages['subjects.library.planningNote']['zh-Hans'], '策划关联不会自动用于生成；生成输入需另行选择版本');
    assert.doesNotMatch(component, /尚不作为生成输入/);
  }
  assert.match(componentSources[0], /subjects.binding.heading/);
  assert.equal(subjectsMessages['subjects.binding.heading']['zh-Hans'], '策划关联此主体的镜头');
  assert.match(componentSources[0], /subjects.version.retained/);
  assert.match(subjectsMessages['subjects.version.retained']['zh-Hans'], /策划关联的镜头需要逐个确认新版本/);
  assert.match(componentSources[0], /subjects.binding.noneLoaded/);
  assert.match(subjectsMessages['subjects.binding.noneLoaded']['zh-Hans'], /已读取的策划关联中没有镜头/);
  assert.doesNotMatch(componentSources[0], /使用此主体的镜头|使用中的镜头/);
  const components = componentSources.join('\n');
  assert.doesNotMatch(components, /generation\.submit|asset\.import|<video|<Dialog|referenceAssetIds\s*=/);
  assert.doesNotMatch(components, /更早版本/); assert.match(library, /const libraryScope = project\?\.id/);
});

test('subject library live relabeling preserves one controller, filters, selected subject and every draft', async () => {
  const f = await fixture();
  f.controller.selectSubject(subjectId); await flush();
  f.controller.updateCreate({ name: 'User text 简繁 English 日本語', assetId });
  f.controller.updateVersion(subjectId, id(4, 2));
  const state = f.controller.getState(), create = state.createDraft, versionDraft = state.versionDrafts[subjectId];
  const props = { subjects: { state, controller: f.controller }, assets: [image(), image(2)] };
  const h = harness('SubjectLibrary.tsx');
  let tree = h.render(props);
  tree.find((node: ElementNode) => node.props?.['aria-label'] === subjectsMessages['subjects.library.search']['zh-Hans'])!.props.onChange({ target: { value: 'Hero' } });
  for (const locale of (['zh-Hans', 'zh-Hant', 'en', 'ja'] as const)) {
    h.locale = locale; tree = h.render(props);
    const section = byId(tree, 'subject-library');
    assert.equal(section!.props['aria-label'], subjectsMessages['subjects.library.label'][locale]);
    const search = tree.find((node: ElementNode) => node.props?.['aria-label'] === subjectsMessages['subjects.library.search'][locale]);
    assert.equal(search!.props.value, 'Hero');
    assert.equal(byId(tree, 'subject-name')!.props.value, 'User text 简繁 English 日本語');
    assert.equal(f.controller.getState(), state);
    assert.equal(state.createDraft, create); assert.equal(state.versionDrafts[subjectId], versionDraft);
    assert.equal(state.selectedSubjectId, subjectId); assert.equal(f.writes.length, 0);
  }
});

test('read failures store a safe descriptor separately from original diagnostics and relabel without another read', async () => {
  let calls = 0;
  const raw = 'PRIVATE_PROVIDER_DETAIL /original/path 不可自动翻译';
  const f = await fixture({ read: async () => { calls++; throw Error(raw); } });
  const state = f.controller.getState(), notice = state.list.error;
  assert.equal(notice!.key, 'subjects.read.failed'); assert.equal(Object.isFrozen(notice), true);
  assert.equal(state.list.diagnostic, raw); assert.equal(calls, 1);
  const h = harness('SubjectLibrary.tsx');
  for (const locale of (['zh-Hans', 'zh-Hant', 'en', 'ja'] as const)) {
    h.locale = locale;
    const tree = h.render({ subjects: { state, controller: f.controller } });
    const alerts = tree.filter((node: ElementNode) => node.props?.role === 'alert');
    assert.ok(JSON.stringify(alerts).includes(subjectsMessages['subjects.read.failed'][locale]));
    assert.equal(JSON.stringify(alerts).includes(raw), false);
    assert.equal(state.list.error, notice); assert.equal(calls, 1);
  }
});

test('pending mutation notice relabels while retaining exact request identity and unsaved draft', async () => {
  let pending = false; const requests: {operation:string;input:Record<string,unknown>}[] = [];
  const f = await fixture({ hasPending: () => pending, save: async (operation: string, input: Record<string,unknown>) => { requests.push({ operation, input }); pending = true; return null; } });
  f.controller.updateCreate({ name: 'Unchanged draft', assetId }); await f.controller.create();
  const state = f.controller.getState(), draft = state.createDraft, notice = state.mutationError;
  const h = harness('SubjectLibrary.tsx');
  assert.equal(notice!.key, 'subjects.mutation.unconfirmed');
  for (const locale of (['zh-Hans', 'zh-Hant', 'en', 'ja'] as const)) {
    h.locale = locale;
    const tree = h.render({ state }, 'SubjectNotice');
    assert.ok(JSON.stringify(tree).includes(subjectsMessages['subjects.mutation.unconfirmed'][locale]));
    assert.equal(state.createDraft, draft); assert.equal(state.mutationError, notice);
    assert.equal(state.uncertain, true); assert.equal(requests.length, 1);
    assert.equal(requests[0].input.requestId, 'subject-request-1');
  }
});

test('shot binding review and selected historical draft relabel without changing bound version targets', async () => {
  const f = await fixture(); f.remote.subject = subject(2); f.remote.versions = [version(), version(2)];
  f.remote.bindings = [binding({ subjectRevision: 2, headVersionId: versionId(2), needsReview: true })];
  await f.controller.read(); await f.controller.readBindings(shotId); await f.controller.readVersions(subjectId);
  f.controller.chooseBinding(shotId, subjectId, versionId(1));
  const state = f.controller.getState(), row = state.bindings[shotId].items[0], draft = state.bindingDrafts[shotId];
  const h = harness('ShotSubjectBindings.tsx'), review = harness('ShotSubjectBindings.tsx');
  const reviewProps = { binding: row, state, controller: f.controller, assets: [image(), image(2)], scope: state.scope };
  const retainedKeep = byId(review.render(reviewProps, 'BoundSubject'), `subject-keep-version-${row.id}`)!.props.onClick;
  for (const locale of (['zh-Hans', 'zh-Hant', 'en', 'ja'] as const)) {
    h.locale = locale; review.locale = locale;
    const tree = h.render({ shot: { id: shotId, projectId }, subjects: { state, controller: f.controller }, assets: [image(), image(2)] });
    const rows = review.render(reviewProps, 'BoundSubject');
    assert.equal(byId(tree, 'shot-subjects')!.props['aria-label'], subjectsMessages['subjects.binding.sectionLabel'][locale]);
    assert.equal(byId(tree, 'shot-subject-version')!.props.value, versionId(1));
    assert.equal((nodes(byId(rows, `subject-review-pinned-${row.id}`)).find((node: ElementNode) => node.type === 'SubjectImage')!.props.version as SubjectVersionResponse).id, versionId(1));
    assert.equal((nodes(byId(rows, `subject-review-head-${row.id}`)).find((node: ElementNode) => node.type === 'SubjectImage')!.props.version as SubjectVersionResponse).id, versionId(2));
    assert.ok(JSON.stringify(byId(rows, `subject-keep-version-${row.id}`)!.props.children).includes(subjectsMessages['subjects.binding.keepVersion'][locale].replace('{version}', 'V1')));
    assert.equal(state.bindingDrafts[shotId], draft); assert.equal(state.bindings[shotId].items[0], row); assert.equal(f.writes.length, 0);
  }
  retainedKeep(); await flush();
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0].input.subjectVersionId, versionId(1));
  assert.equal(f.writes[0].input.expectedRevision, row.revision);
});

test('subject library renders its loading state before the project controller is available', async () => {
  const h = harness('SubjectLibrary.tsx');
  assert.ok(byId(h.render({ subjects: null }), 'subject-library'));
  assert.equal(byId(h.render({}), 'subject-create'), undefined);
  const f = await fixture();
  assert.ok(byId(h.render({ subjects: { state: f.controller.getState(), controller: f.controller }, assets: [image()] }), 'subject-library'));
});

// Group actions are a prop, not children; the pane's tests look inside both.
const deep = (value: ElementTree): ElementNode[] => nodes(value).flatMap((node: ElementNode) => [node, ...(node.props?.actions ? deep(node.props.actions as ElementTree) : [])]);
const deepId = (tree: ElementTree, testId: string) => deep(tree).find((node: ElementNode) => node.props?.['data-testid'] === testId);
// Visible text of a subtree, in order, so assertions read like the rendered label.
const text = (value: unknown): string => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text((value as ElementNode).props?.children) : value === null || value === undefined || typeof value === 'boolean' ? '' : String(value);

test('existing subject version drafts are protected by their own server target and cannot release while dirty or unknown',async()=>{
  const f=await fixture();await f.controller.selectSubject(subjectId);const h=harness('SubjectInspector.tsx');const render=()=>h.render({subjects:{controller:f.controller,state:f.controller.getState()},subjectId,assets:[image(),image(2)]});
  assert.equal(render().some((node: ElementNode)=>node.type==='AgentEditingBoundary'),false);
  (deepId(render(),'subject-version-add-open')!.props.onClick as ()=>unknown)();
  const tree=render(),boundary=tree.find((node: ElementNode)=>node.type==='AgentEditingBoundary');assert.ok(boundary);assert.deepEqual(boundary.props.targets,[{kind:'subject',id:subjectId,revision:1}]);assert.equal((boundary.props.canRelease as ()=>boolean)(),true);f.controller.updateVersion(subjectId,id(4,2));assert.equal((boundary.props.canRelease as ()=>boolean)(),false);(boundary.props.onDiscard as ()=>unknown)();assert.equal(f.controller.getState().versionDrafts[subjectId].assetId,'');assert.equal((boundary.props.canRelease as ()=>boolean)(),true);h.unmount();
});

test('library cards hand the subject to the properties pane and follow its highlight, without reading versions themselves', async () => {
  const f = await fixture(); const h = harness('SubjectLibrary.tsx'), inspected: string[] = [];
  const props = (patch = {}) => ({ subjects: { state: f.controller.getState(), controller: f.controller }, assets: [image()], onInspectSubject: (subjectId: string) => { inspected.push(subjectId); }, ...patch });
  let tree = h.render(props({ inspectedSubjectId: null }));
  const card = byId(tree, `subject-card-${subjectId}`)!;
  assert.equal(card.props['aria-pressed'], false);
  (card.props.onClick as () => unknown)();
  assert.deepEqual(inspected, [subjectId]);
  assert.equal(f.controller.getState().selectedSubjectId, '', 'the host selects after its own navigation guard');
  tree = h.render(props({ inspectedSubjectId: subjectId }));
  assert.equal(byId(tree, `subject-card-${subjectId}`)!.props['aria-pressed'], true);
  assert.match(text(byId(tree, `subject-card-${subjectId}`)), new RegExp(subjectsMessages['subjects.library.defaultVersion']['zh-Hans'].replace('{number}', '1')));
  // Kind chips filter this page only and leave the controller untouched.
  (byId(tree, 'subject-kind-product')!.props.onClick as () => unknown)();
  tree = h.render(props({ inspectedSubjectId: subjectId }));
  assert.equal(byId(tree, `subject-card-${subjectId}`), undefined);
  assert.equal(byId(tree, 'subject-kind-product')!.props['aria-pressed'], true);
  (byId(tree, 'subject-kind-all')!.props.onClick as () => unknown)();
  assert.ok(byId(h.render(props()), `subject-card-${subjectId}`));
  assert.equal(f.writes.length, 0); h.unmount();
});

test('the properties pane shows read-only basics, default and variant labels, and which version each shot uses', async () => {
  const f = await fixture();
  const angle = { kind: 'angle', position: 'front-left', focal: 'wide', batchId: id(7), sourceVersionId: versionId(1) };
  const light = { kind: 'light', azimuth: 45, elevation: 30, quality: 'soft', kelvin: 4800, batchId: id(7, 2), sourceVersionId: versionId(1) };
  const generated = { kind: 'generated', versionId: null, shotId: null, jobId: null, imageSource: { imageGroupId: id(8), imageTaskId: id(8, 2), imageVersionId: id(8, 3) } };
  f.remote.subject = subject(4, { headVersionId: versionId(2), headVersion: version(2) });
  f.remote.versions = [version(1), version(2), version(3, { variant: angle, provenance: generated }), version(4, { variant: light, provenance: { ...generated, kind: 'synthetic-mock' } })];
  f.remote.bindings = [binding({ subjectVersionId: versionId(3), reviewedHeadVersionId: versionId(2), headVersionId: versionId(2), subjectRevision: 4 })];
  await f.controller.read(); f.controller.selectSubject(subjectId); await flush();
  const shots = [{ id: id(2, 9), title: 'Other', orderIndex: 0 }, { id: shotId, title: 'Neon close-up', orderIndex: 1 }];
  const h = harness('SubjectInspector.tsx'), inspectedShots: string[] = [];
  const props = () => ({ subjects: { state: f.controller.getState(), controller: f.controller }, subjectId, assets: [image(), image(2), image(3), image(4)], shots, onInspectShot: (shot: string) => { inspectedShots.push(shot); } });
  let tree = h.render(props());
  assert.ok(byId(tree, 'subject-inspector'));
  assert.equal(tree.some((node: ElementNode) => ['Input', 'WorkbenchSelect', 'Textarea'].includes(String(node.type))), false, 'name and type are read-only');
  assert.match(text(tree), new RegExp(subjectsMessages['subjects.inspector.readOnly']['zh-Hans']));
  const label = (n: number) => text(tree.find((node: ElementNode) => node.props?.role === 'listitem' && node.props?.key === versionId(n)));
  assert.match(label(1), new RegExp(subjectsMessages['subjects.origin.import']['zh-Hans']), 'an ordinary version shows its origin, never an angle');
  assert.match(label(2), new RegExp(subjectsMessages['subjects.inspector.defaultVersion']['zh-Hans']));
  assert.match(label(3), /左前 · 广角/);
  assert.match(label(4), new RegExp(subjectsMessages['subjects.light.soft']['zh-Hans']));
  // The default version is selected first; choosing a variant explains it never becomes the default.
  assert.match(text(byId(tree, 'subject-version-detail')), /V2/);
  (byId(tree, `subject-version-${versionId(3)}`)!.props.onClick as () => unknown)();
  tree = h.render(props());
  const detail = text(byId(tree, 'subject-version-detail'));
  assert.match(detail, /V3 · 左前 · 广角/); assert.match(detail, /GPT Image/);
  assert.match(detail, /不会成为默认版本。默认版本仍是 V2，用到Hero的镜头不需要复核。/);
  (byId(tree, `subject-version-${versionId(4)}`)!.props.onClick as () => unknown)();
  assert.match(text(byId(h.render(props()), 'subject-version-detail')), /模拟服务[\s\S]*方位 45° · 俯仰 30° · 4800K/);
  // Usage names the shot by its order and the exact pinned variant.
  tree = h.render(props());
  const use = byId(tree, `subject-use-${id(6)}`)!;
  assert.equal(text(use), '02Neon close-upV3 · 左前 · 广角');
  (use.props.onClick as () => unknown)(); assert.deepEqual(inspectedShots, [shotId]);
  assert.match(text(tree), new RegExp(subjectsMessages['subjects.library.planningNote']['zh-Hans']));
  // Hidden panes reject retained callbacks.
  h.visible = false; h.render(props()); (use.props.onClick as () => unknown)(); assert.deepEqual(inspectedShots, [shotId]);
  assert.equal(f.writes.length, 0); h.unmount();
});

test('the properties pane withholds a subject the project has not loaded', () => {
  const h = harness('SubjectInspector.tsx');
  const controller = createSubjectController({ read: async () => assert.fail('No read'), save: async () => assert.fail('No save') });
  for (const props of [{ subjectId }, { subjectId, subjects: { state: null, controller } }]) {
    const tree = h.render(props);
    assert.ok(byId(tree, 'subject-inspector')); assert.ok(tree.some((node: ElementNode) => node.props?.role === 'status'));
    assert.equal(tree.some((node: ElementNode) => typeof node.props?.onClick === 'function'), false);
  }
});
