import test from 'node:test';
import assert from 'node:assert/strict';
import {createAssetRelinkHost} from '../apps/desktop/src/asset-relink-host.ts';
import type {AssetRelinkOwner} from '../apps/desktop/src/asset-relink-host.ts';
import {createNativeAssetMediaBridge} from '../apps/desktop/src/asset-relink-preload.ts';
import {
  NATIVE_ASSET_MEDIA_CHANNEL, NATIVE_ASSET_MEDIA_LIMITS,
  nativeRelinkApplyResultSchema,
} from '../packages/contracts/src/asset-media-native.ts';
import type {
  NativeAssetMediaPort, NativeAssetMediaRequestOptions, NativeRelinkCandidateInput, NativeRelinkCandidate,
  NativeRelinkPreviewInput, NativeRelinkPreview, NativeRelinkApplyInput, NativeRelinkApplyResult,
} from '../packages/contracts/src/asset-media-native.ts';
import {projectMediaPath} from '../packages/contracts/src/project-file.ts';
import {readProjectMediaNativeClient} from '../apps/web/src/project-media-native-client.ts';
import {ProjectMediaError} from '../apps/web/src/project-media-client.ts';

const id = (n: number) => `87000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projectId = id(1), assetId = id(2), selectedFile = '/synthetic/移动后的素材/镜头.mp4';
const selection = {projectId, assetId, expectedReferenceRevision: 4};
const tick = () => new Promise(setImmediate);
function applied(outside = false): NativeRelinkApplyResult {
  return nativeRelinkApplyResultSchema.parse({status: 'applied', assets: [{id: assetId, projectId, name: '镜头', mimeType: 'video/mp4', sizeBytes: 123,
    referenceRevision: 5, sha256: 'b'.repeat(64), fingerprint: {sizeBytes: 123, mtimeMs: 1000, sampledSha256: 'a'.repeat(64), fullSha256: 'b'.repeat(64)},
    hashState: 'full', url: projectMediaPath(projectId, assetId)}], confirmedDirectories: outside ? ['/synthetic/移动后的素材'] : []});
}
interface Hooks {
  choose?: () => Promise<string | null>;
  confirm?: () => Promise<boolean>;
  candidate?: (input: NativeRelinkCandidateInput, options?: NativeAssetMediaRequestOptions) => Promise<NativeRelinkCandidate>;
  preview?: (input: NativeRelinkPreviewInput, options?: NativeAssetMediaRequestOptions) => Promise<NativeRelinkPreview>;
  apply?: (input: NativeRelinkApplyInput, options?: NativeAssetMediaRequestOptions) => Promise<NativeRelinkApplyResult>;
  outside?: boolean;
  confirmationRequired?: boolean;
}
function fixture(hooks: Hooks = {}) {
  const key = {}, window = {}, calls: Array<{kind: string; input?: unknown; options?: NativeAssetMediaRequestOptions}> = [];
  let contextId = id(3), backendId = id(4), windowId = id(5), boundProject = projectId, alive = true, enabled = true, clock = 1000, serial = 100;
  const candidates = new Map<string, NativeRelinkCandidate>();
  const owner = (): AssetRelinkOwner => {
    const captured = {contextId, backendId, windowId, projectId: boundProject};
    return {...captured, key, window, isCurrent: () => alive && captured.contextId === contextId && captured.backendId === backendId && captured.windowId === windowId && captured.projectId === boundProject};
  };
  const backend: NativeAssetMediaPort = {
    candidate: async (input, options) => {
      calls.push({kind: 'candidate', input, options}); options?.beforeEffect?.();
      if (hooks.candidate) return hooks.candidate(input, options);
      const candidate = {...selection, candidateToken: id(++serial), displayPath: input.sourcePath, outside: hooks.outside ?? false,
        confirmationRequired: hooks.confirmationRequired ?? hooks.outside ?? false};
      candidates.set(candidate.candidateToken, candidate); return candidate;
    },
    preview: async (input, options) => {
      calls.push({kind: 'preview', input, options}); options?.beforeEffect?.();
      if (hooks.preview) return hooks.preview(input, options);
      const candidate = candidates.get(input.candidateToken); assert.ok(candidate);
      return {...selection, previewToken: id(++serial), displayPath: candidate.displayPath, outside: candidate.outside,
        rows: [{assetId, name: '镜头', from: '/synthetic/原位置/镜头.mp4', to: candidate.displayPath, outcome: 'picked', referenceRevision: 4}], foundBy: null};
    },
    apply: async (input, options) => {calls.push({kind: 'apply', input, options}); options?.beforeEffect?.(); return hooks.apply ? hooks.apply(input, options) : applied(hooks.outside);},
    discard: async input => {calls.push({kind: 'discard', input});},
  };
  const host = createAssetRelinkHost({ownerForEvent: (event: string) => event === 'owner' ? owner() : null, backend, now: () => clock, isReady: () => enabled,
    chooseFile: async () => {calls.push({kind: 'choose'}); return hooks.choose ? hooks.choose() : selectedFile;},
    confirmOutside: async (_owner, input) => {calls.push({kind: 'confirm', input}); return hooks.confirm ? hooks.confirm() : true;}});
  const bridge = createNativeAssetMediaBridge((channel, input) => {assert.equal(channel, NATIVE_ASSET_MEDIA_CHANNEL); return host.handle('owner', input);});
  return {host, bridge, calls, backend, owner,
    replaceDocument() {contextId = id(++serial);}, replaceBackend() {backendId = id(++serial);}, replaceWindow() {windowId = id(++serial);},
    replaceProject() {boundProject = id(++serial);}, closeOwner() {alive = false;}, disable() {enabled = false;}, advance(ms: number) {clock += ms;}};
}
const of = (f: ReturnType<typeof fixture>, kind: string) => f.calls.filter(value => value.kind === kind);

test('preload sends plain relink rejection DTOs and the page retains known versus unknown outcomes',async t=>{
  const errors=[{code:'MEDIA_CHANGED',status:409},{code:'REVISION_CONFLICT',status:409},{code:'ASSET_RELINK_BUSY',status:409},
    {code:'ASSET_RELINK_UNAVAILABLE',status:503},{code:'ASSET_MEDIA_NATIVE_OUTCOME_UNKNOWN',status:409},{code:'PROJECT_ENTRY_OUTCOME_UNKNOWN',status:409}];
  const input={projectId,previewToken:id(900),requestId:'preserved-native-intent'};
  for(const action of ['choose','apply'] as const)for(const failure of errors)await t.test(`${action}/${failure.code}`,async()=>{
    const calls:unknown[]=[];const bridge=createNativeAssetMediaBridge(async(_channel,input)=>{calls.push(input);return {ok:false,error:failure};});
    const call=()=>action==='choose'?bridge.choose(selection):bridge.apply(input);
    await assert.rejects(call(),error=>{assert.equal(error instanceof Error,false);assert.deepEqual(error,failure);return true;});assert.equal(calls.length,1);
    const page=readProjectMediaNativeClient({__mioonAssetMediaNative:bridge});assert.ok(page);
    const pending=action==='choose'?page.choose(selection):page.apply(input);
    await assert.rejects(pending,error=>{
      assert.ok(error instanceof ProjectMediaError);assert.equal(error.code,failure.code);assert.equal(error.status,failure.status);
      assert.equal(error.outcomeUnknown,action==='apply'&&(failure.status>=500||failure.code.endsWith('_OUTCOME_UNKNOWN')));return true;
    });
    assert.equal(calls.length,2,'the page does not retry a refusal or an unknown write');
    assert.deepEqual(calls,[{...(action==='choose'?selection:input),action},{...(action==='choose'?selection:input),action}]);
  });
});

test('lost transport or malformed relink replies remain unknown after a write and are never automatically repeated',async t=>{
  const input={projectId,previewToken:id(900),requestId:'unknown-native-intent'};
  const replies=[null,{ok:false,error:{code:'MEDIA_CHANGED',status:409,extra:true}},{ok:false,error:{code:'MEDIA_CHANGED',status:399}},{ok:false,error:{code:'media_changed',status:409}},{ok:true,data:{}}];
  for(const action of ['choose','apply'] as const)for(let index=0;index<=replies.length;index++)await t.test(`${action}/${index===replies.length?'transport':'malformed-'+index}`,async()=>{
    let calls=0;const bridge=createNativeAssetMediaBridge(async()=>{calls++;if(index===replies.length)throw new Error('Synthetic transport loss');return replies[index];});
    const page=readProjectMediaNativeClient({__mioonAssetMediaNative:bridge});assert.ok(page);
    await assert.rejects(action==='choose'?page.choose(selection):page.apply(input),error=>{
      assert.ok(error instanceof ProjectMediaError);assert.equal(error.code,'ASSET_RELINK_UNAVAILABLE');assert.equal(error.status,undefined);assert.equal(error.outcomeUnknown,action==='apply');return true;
    });assert.equal(calls,1);
  });
});

test('a trusted single-file choice yields a bound S1 preview without importing, applying or granting permission', async () => {
  const f = fixture(), preview = await f.bridge.choose(selection); assert.ok(preview);
  assert.deepEqual(f.calls.map(value => value.kind), ['choose', 'candidate', 'preview']);
  const input = of(f, 'candidate')[0].input as NativeRelinkCandidateInput;
  assert.equal(input.sourcePath, selectedFile); assert.equal(input.projectId, projectId); assert.equal(input.assetId, assetId); assert.equal(input.expectedReferenceRevision, 4);
  assert.match(input.ownerToken, /^[0-9a-f-]{36}$/u); assert.equal(JSON.stringify(preview).includes(input.ownerToken), false);
  assert.equal(preview.displayPath, selectedFile); assert.equal(preview.assetId, assetId); assert.equal(preview.expectedReferenceRevision, 4);
  assert.equal(of(f, 'apply').length, 0); assert.equal(of(f, 'confirm').length, 0);
});

test('cancelling the system file picker does not allocate a candidate or perform any write', async () => {
  const f = fixture({choose: async () => null}); assert.equal(await f.bridge.choose(selection), null);
  assert.deepEqual(f.calls.map(value => value.kind), ['choose']);
});

test('declining explicit outside consent retires only the private candidate and never previews or changes grants', async () => {
  const f = fixture({outside: true, confirm: async () => false}); assert.equal(await f.bridge.choose(selection), null);
  assert.deepEqual(f.calls.map(value => value.kind), ['choose', 'candidate', 'confirm', 'discard']);
  assert.deepEqual(of(f, 'confirm')[0].input, {displayPath: selectedFile});
  assert.ok((of(f, 'discard')[0].input as {candidateToken?: string}).candidateToken);
  assert.equal(of(f, 'preview').length, 0); assert.equal(of(f, 'apply').length, 0);
});

test('outside consent is main-owned and preview does not grant; apply retains exact-request results and truthful confirmed directories', async () => {
  const f = fixture({outside: true}), preview = await f.bridge.choose(selection); assert.ok(preview);
  assert.deepEqual(f.calls.map(value => value.kind), ['choose', 'candidate', 'confirm', 'preview']);
  assert.equal((of(f, 'preview')[0].input as NativeRelinkPreviewInput).allowOutside, true);
  assert.equal(of(f, 'apply').length, 0);
  const input = {projectId, previewToken: preview.previewToken, requestId: 'relink-exact-request'};
  const result = await f.bridge.apply(input); assert.deepEqual(result, applied(true));
  assert.deepEqual(await f.bridge.apply(input), result); assert.equal(of(f, 'apply').length, 1);
  await assert.rejects(f.bridge.apply({...input, requestId: 'different-request'}));
  await assert.rejects(f.bridge.discard({projectId, previewToken: preview.previewToken}));
  assert.equal(of(f, 'apply').length, 1);
});

test('an already confirmed outside directory needs no fabricated new consent', async () => {
  const f = fixture({outside: true, confirmationRequired: false, confirm: async () => assert.fail()});
  assert.ok(await f.bridge.choose(selection)); assert.equal(of(f, 'confirm').length, 0);
  assert.equal((of(f, 'preview')[0].input as NativeRelinkPreviewInput).allowOutside, false);
});

test('an unused preview can be explicitly discarded but an import token or another project cannot authorize relink', async () => {
  const f = fixture(), preview = await f.bridge.choose(selection); assert.ok(preview);
  await assert.rejects(f.bridge.apply({projectId, previewToken: id(998), requestId: 'foreign-import-token'}));
  await assert.rejects(f.bridge.apply({projectId: id(999), previewToken: preview.previewToken, requestId: 'different-project'}));
  await f.bridge.discard({projectId, previewToken: preview.previewToken});
  await assert.rejects(f.bridge.apply({projectId, previewToken: preview.previewToken, requestId: 'discarded-preview'}));
  assert.equal(of(f, 'apply').length, 0);
});

test('the renderer cannot submit paths, consent, owner tokens, extra fields or an oversized request', async () => {
  const f = fixture();
  for (const extra of [{sourcePath: selectedFile}, {allowOutside: true}, {ownerToken: id(20)}, {token: id(21)}, {text: 'x'.repeat(NATIVE_ASSET_MEDIA_LIMITS.requestBytes)}]) {
    const reply = await f.host.handle('owner', {action: 'choose', ...selection, ...extra});
    assert.deepEqual(reply, {ok: false, error: {code: 'ASSET_RELINK_INVALID', status: 400}});
  }
  await assert.rejects(f.host.dispatch('foreign', {action: 'choose', ...selection})); assert.equal(f.calls.length, 0);
});

for (const boundary of ['document', 'backend', 'window', 'project'] as const) test(`a preview cannot cross its ${boundary} owner boundary even if the native frame key is reused`, async () => {
  const f = fixture(), preview = await f.bridge.choose(selection); assert.ok(preview);
  const firstOwnerToken = (of(f, 'candidate')[0].input as NativeRelinkCandidateInput).ownerToken;
  if (boundary === 'document') f.replaceDocument(); else if (boundary === 'backend') f.replaceBackend(); else if (boundary === 'window') f.replaceWindow(); else f.replaceProject();
  await assert.rejects(f.bridge.apply({projectId, previewToken: preview.previewToken, requestId: 'stale-document-request'}));
  assert.equal(of(f, 'apply').length, 0);
  if (boundary !== 'project') {
    assert.ok(await f.bridge.choose(selection));
    assert.notEqual((of(f, 'candidate').at(-1)!.input as NativeRelinkCandidateInput).ownerToken, firstOwnerToken);
  }
  assert.ok(of(f, 'discard').some(value => (value.input as {ownerToken: string}).ownerToken === firstOwnerToken));
});

test('late system selection and outside-consent answers cannot operate for an invalidated document', async () => {
  for (const phase of ['choose', 'consent']) {
    const picked = Promise.withResolvers<string | null>(), consent = Promise.withResolvers<boolean>();
    const f = fixture(phase === 'choose' ? {choose: () => picked.promise} : {outside: true, confirm: () => consent.promise});
    const pending = f.bridge.choose(selection); await tick();
    f.host.invalidateWindow(id(5));
    if (phase === 'choose') picked.resolve(selectedFile); else consent.resolve(true);
    await assert.rejects(pending); assert.equal(of(f, 'preview').length, 0); assert.equal(of(f, 'apply').length, 0);
    assert.equal(of(f, 'candidate').length, phase === 'choose' ? 0 : 1);
  }
});

test('invalidateWindow aborts in-flight preview/hash and permanently retires its private owner token', async () => {
  const waiting = Promise.withResolvers<NativeRelinkPreview>(); let signal: AbortSignal | undefined;
  const f = fixture({preview: async (_input, options) => {signal = options?.signal; return waiting.promise;}});
  const pending = f.bridge.choose(selection); await tick(); assert.ok(signal); assert.equal(signal.aborted, false);
  f.host.invalidateWindow(id(5)); assert.equal(signal.aborted, true);
  waiting.resolve({...selection, previewToken: id(900), displayPath: selectedFile, outside: false,
    rows: [{assetId, name: '镜头', from: '素材/镜头.mp4', to: selectedFile, outcome: 'picked', referenceRevision: 4}], foundBy: null});
  await assert.rejects(pending); assert.equal(of(f, 'apply').length, 0);
  assert.ok(of(f, 'discard').some(value => Object.keys(value.input as object).sort().join(',') === 'ownerToken,projectId'));
});

test('explicit window invalidation cannot remint the same document tuple even if its main callback briefly remains current', async () => {
  const f = fixture(), preview = await f.bridge.choose(selection); assert.ok(preview);
  const chooses = of(f, 'choose').length, candidates = of(f, 'candidate').length;
  assert.equal(f.owner().isCurrent(), true); f.host.invalidateWindow(id(5)); assert.equal(f.owner().isCurrent(), true);
  await assert.rejects(f.bridge.choose(selection));
  await assert.rejects(f.bridge.apply({projectId, previewToken: preview.previewToken, requestId: 'retired-native-tuple'}));
  assert.equal(of(f, 'choose').length, chooses); assert.equal(of(f, 'candidate').length, candidates); assert.equal(of(f, 'apply').length, 0);
});

test('a new context on the same weak frame key can select after the previous tuple was explicitly invalidated', async () => {
  const f = fixture(), preview = await f.bridge.choose(selection); assert.ok(preview);
  const firstToken = (of(f, 'candidate')[0].input as NativeRelinkCandidateInput).ownerToken;
  f.host.invalidateWindow(id(5)); f.replaceDocument();
  const replacement = await f.bridge.choose(selection); assert.ok(replacement);
  assert.notEqual((of(f, 'candidate').at(-1)!.input as NativeRelinkCandidateInput).ownerToken, firstToken);
  await assert.rejects(f.bridge.apply({projectId, previewToken: preview.previewToken, requestId: 'old-native-tuple'}));
  assert.deepEqual(await f.bridge.apply({projectId, previewToken: replacement.previewToken, requestId: 'new-native-tuple'}), applied());
});

test('dispose aborts a pending apply and prevents its late result from being delivered or reused', async () => {
  const waiting = Promise.withResolvers<NativeRelinkApplyResult>(); let signal: AbortSignal | undefined;
  const f = fixture({apply: async (_input, options) => {signal = options?.signal; return waiting.promise;}}), preview = await f.bridge.choose(selection); assert.ok(preview);
  const input = {projectId, previewToken: preview.previewToken, requestId: 'pending-native-apply'}, pending = f.bridge.apply(input); await tick();
  assert.ok(signal); assert.equal(signal.aborted, false); f.host.dispose(); f.host.dispose(); assert.equal(signal.aborted, true);
  waiting.resolve(applied()); await assert.rejects(pending, {code: 'ASSET_MEDIA_NATIVE_OUTCOME_UNKNOWN'}); await assert.rejects(f.bridge.apply(input));
  assert.equal(of(f, 'apply').length, 1);
});

test('only an explicit retry with the same request ID may check an unknown apply without another picker or grant', async () => {
  let attempts = 0;
  const f = fixture({apply: async () => {if (++attempts === 1) throw Object.assign(new Error('lost acknowledgement'), {code: 'PROJECT_ENTRY_OUTCOME_UNKNOWN', status: 409}); return applied();}});
  const preview = await f.bridge.choose(selection); assert.ok(preview);
  const input = {projectId, previewToken: preview.previewToken, requestId: 'exact-unknown-request'};
  await assert.rejects(f.bridge.apply(input), {code: 'PROJECT_ENTRY_OUTCOME_UNKNOWN'});
  await assert.rejects(f.bridge.apply({...input, requestId: 'new-unknown-request'}));
  assert.deepEqual(await f.bridge.apply(input), applied()); assert.equal(attempts, 2);
  assert.equal(of(f, 'choose').length, 1); assert.equal(of(f, 'confirm').length, 0);
});

test('known failed apply reports existing confirmed-directory effects instead of claiming that nothing happened', async () => {
  const result: NativeRelinkApplyResult = {status: 'failed', error: {code: 'REVISION_CONFLICT', status: 409}, confirmedDirectories: ['/synthetic/移动后的素材']};
  const f = fixture({outside: true, apply: async () => result}), preview = await f.bridge.choose(selection); assert.ok(preview);
  const input = {projectId, previewToken: preview.previewToken, requestId: 'known-failed-request'};
  assert.deepEqual(await f.bridge.apply(input), result); assert.deepEqual(await f.bridge.apply(input), result); assert.equal(of(f, 'apply').length, 1);
});

test('an explicit native unknown result retains the original intent for same-ID checking without caching uncertainty as failure', async () => {
  let attempts = 0;
  const unknown: NativeRelinkApplyResult = {status: 'failed', error: {code: 'ASSET_MEDIA_NATIVE_OUTCOME_UNKNOWN', status: 409}, confirmedDirectories: ['/synthetic/移动后的素材']};
  const f = fixture({outside: true, apply: async () => ++attempts === 1 ? unknown : applied(true)}), preview = await f.bridge.choose(selection); assert.ok(preview);
  const input = {projectId, previewToken: preview.previewToken, requestId: 'unknown-native-commit'};
  assert.deepEqual(await f.bridge.apply(input), unknown);
  await assert.rejects(f.bridge.apply({...input, requestId: 'replaced-native-intent'}));
  assert.deepEqual(await f.bridge.apply(input), applied(true)); assert.equal(attempts, 2);
  assert.equal(of(f, 'confirm').length, 1); assert.equal(of(f, 'choose').length, 1);
});

test('a malformed acknowledgement after apply is unknown and can only be checked with the same request key', async () => {
  let attempts = 0;
  const f = fixture({apply: async () => ++attempts === 1 ? {} as NativeRelinkApplyResult : applied()}), preview = await f.bridge.choose(selection); assert.ok(preview);
  const input = {projectId, previewToken: preview.previewToken, requestId: 'malformed-native-ack'};
  await assert.rejects(f.bridge.apply(input), {code: 'ASSET_MEDIA_NATIVE_OUTCOME_UNKNOWN'});
  await assert.rejects(f.bridge.apply({...input, requestId: 'new-malformed-intent'}));
  assert.deepEqual(await f.bridge.apply(input), applied()); assert.equal(attempts, 2);
});

test('an unknown owner admits only the original preview and request until its explicit check settles', async () => {
  let attempts = 0;
  const unknown: NativeRelinkApplyResult = {status: 'failed', error: {code: 'ASSET_MEDIA_NATIVE_OUTCOME_UNKNOWN', status: 409}, confirmedDirectories: []};
  const f = fixture({apply: async () => ++attempts === 1 ? unknown : applied()});
  const first = await f.bridge.choose(selection), second = await f.bridge.choose(selection); assert.ok(first); assert.ok(second);
  const input = {projectId, previewToken: first.previewToken, requestId: 'original-unknown-owner-intent'};
  assert.deepEqual(await f.bridge.apply(input), unknown);
  await assert.rejects(f.bridge.choose(selection), {code: 'ASSET_MEDIA_NATIVE_OUTCOME_UNKNOWN'});
  await assert.rejects(f.bridge.apply({projectId, previewToken: second.previewToken, requestId: 'new-preview-owner-intent'}), {code: 'ASSET_MEDIA_NATIVE_OUTCOME_UNKNOWN'});
  assert.equal(of(f, 'choose').length, 2); assert.equal(of(f, 'apply').length, 1);
  assert.deepEqual(await f.bridge.apply(input), applied());
  assert.ok(await f.bridge.choose(selection)); assert.equal(of(f, 'choose').length, 3);
});

test('an accepted request outlives the temporary selection TTL for exact success or unknown-result checking', async () => {
  for (const initiallyUnknown of [false, true]) {
    let attempts = 0;
    const unknown: NativeRelinkApplyResult = {status: 'failed', error: {code: 'ASSET_MEDIA_NATIVE_OUTCOME_UNKNOWN', status: 409}, confirmedDirectories: []};
    const f = fixture({apply: async () => ++attempts === 1 && initiallyUnknown ? unknown : applied()}), preview = await f.bridge.choose(selection); assert.ok(preview);
    const input = {projectId, previewToken: preview.previewToken, requestId: 'long-lived-original-intent'};
    await f.bridge.apply(input); f.advance(NATIVE_ASSET_MEDIA_LIMITS.ticketMs * 10);
    assert.deepEqual(await f.bridge.apply(input), applied()); assert.equal(attempts, initiallyUnknown ? 2 : 1);
    assert.equal(of(f, 'choose').length, 1);
  }
});

test('another apply or picker cannot enter while the owning apply is still awaiting its original result', async () => {
  const waiting = Promise.withResolvers<NativeRelinkApplyResult>(), f = fixture({apply: () => waiting.promise});
  const first = await f.bridge.choose(selection), second = await f.bridge.choose(selection); assert.ok(first); assert.ok(second);
  const input = {projectId, previewToken: first.previewToken, requestId: 'original-pending-owner-intent'}, pending = f.bridge.apply(input); await tick();
  const same = f.bridge.apply(input);
  await assert.rejects(f.bridge.choose(selection), {code: 'ASSET_RELINK_BUSY'});
  await assert.rejects(f.bridge.apply({projectId, previewToken: second.previewToken, requestId: 'different-pending-owner-intent'}), {code: 'ASSET_RELINK_BUSY'});
  waiting.resolve(applied()); assert.deepEqual(await pending, applied()); assert.deepEqual(await same, applied()); assert.equal(of(f, 'apply').length, 1);
});

test('retained request tickets remain bounded even after their temporary selection TTL has passed', async () => {
  const f = fixture();
  for (let index = 0; index < NATIVE_ASSET_MEDIA_LIMITS.tickets; index++) {
    const preview = await f.bridge.choose(selection); assert.ok(preview);
    await f.bridge.apply({projectId, previewToken: preview.previewToken, requestId: `bounded-native-intent-${index}`});
    f.advance(NATIVE_ASSET_MEDIA_LIMITS.ticketMs + 1);
  }
  await assert.rejects(f.bridge.choose(selection), {code: 'ASSET_RELINK_LIMIT'});
  assert.equal(of(f, 'choose').length, NATIVE_ASSET_MEDIA_LIMITS.tickets);
});

test('preview expiry and parallel picker admission fail closed', async () => {
  const chosen = Promise.withResolvers<string | null>(), f = fixture({choose: () => chosen.promise});
  const first = f.bridge.choose(selection); await tick(); await assert.rejects(f.bridge.choose(selection), {code: 'ASSET_RELINK_BUSY'});
  chosen.resolve(selectedFile); const preview = await first; assert.ok(preview);
  f.advance(NATIVE_ASSET_MEDIA_LIMITS.ticketMs);
  await assert.rejects(f.bridge.apply({projectId, previewToken: preview.previewToken, requestId: 'expired-preview-request'})); assert.equal(of(f, 'apply').length, 0);
});

test('preload validates exact envelopes, response bytes and selection binding without exposing native diagnostics', async () => {
  for (const reply of [null, {ok: true, data: null, extra: true}, {ok: false, error: {code: 'MEDIA_CHANGED', status: 409, message: '/private/native'}},
    {ok: false, error: {code: 'MEDIA_CHANGED', status: 409}, extra: true}, {ok: true, data: 'x'.repeat(NATIVE_ASSET_MEDIA_LIMITS.responseBytes)}]) {
    const bridge = createNativeAssetMediaBridge(async () => reply); await assert.rejects(bridge.choose(selection));
  }
  const f = fixture(), preview = await f.bridge.choose(selection); assert.ok(preview);
  const wrong = createNativeAssetMediaBridge(async () => ({ok: true, data: {...preview, projectId: id(999)}})); await assert.rejects(wrong.choose(selection));
});
