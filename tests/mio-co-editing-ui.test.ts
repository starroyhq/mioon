import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import {
  buildCoEditingComparison,
  clipDraftPatchFromServerValues,
  clipFieldGroup,
  clipFieldTargetKind,
  findMioWriteForTarget,
  parseCoEditingClaimResult,
} from '../apps/web/src/mio-co-editing.ts';
import { createClipDraftController, clipDraftRaw } from '../apps/web/src/clip-draft-state.ts';
import type { AgentTaskEditingWrite, AgentTaskTarget } from '../packages/contracts/src/agent-tasks-v2.ts';
import {
  AGENT_TASK_DISPLAY_TARGET_KINDS,
  agentTaskEditingResolveBatchSchema,
  agentTaskEditingSchema,
  agentTaskEditingTargetRevisionKind,
} from '../packages/contracts/src/agent-tasks-v2.ts';
import { matchesEditingBatchReceipt, RetainedEditingConflict } from '../apps/web/src/agent-retained-editing.ts';
import { taskDisplayTargets } from '../apps/web/src/agent-task-presentation.ts';
import { mioFollowColor } from '../apps/web/src/mio-follow.ts';
import { LOCALES, translate, validateCatalogs } from '../packages/i18n/src/index.ts';
import { createI18nTestContext, i18nTestModule } from './helpers/i18n.ts';
import type { Tree as UiTree, Element as UiElement, Hook as UiHook, Module as UiModule } from './helpers/strict-agent-ui-types.ts';

const readWeb = (file: string) => readFileSync(new URL(`../apps/web/src/${file}`, import.meta.url), 'utf8');
const nodes = (value: UiTree): UiElement[] =>
  Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value, ...nodes(value.props?.children)] : [];
const textOf = (value: UiTree): string =>
  Array.isArray(value) ? value.map(textOf).join(' ') : value && typeof value === 'object' ? textOf(value.props?.children) : String(value ?? '');
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

test('A1: no Edit button exists in editing boundary and search/Mio inputs omit placeholder text', () => {
  const boundary = readWeb('AgentEditingBoundary.tsx');
  assert.doesNotMatch(boundary, /agent-editing-start|agent-editing-release/, 'Edit and Finish editing buttons are removed');
  assert.doesNotMatch(readWeb('AgentTaskPanel.tsx'), /data-testid="agent-task-draft"[^>]*placeholder=/, 'Mio composer has no placeholder');
  for (const file of ['AgentConversationHistory.tsx', 'AssetLibrary.tsx', 'SubjectLibrary.tsx']) {
    assert.doesNotMatch(readWeb(file), /\bplaceholder=/, `${file} search input has no placeholder`);
  }
});

test('A2: Mio write matching isolates clip audio, visual, and timing groups using the round cursor color', () => {
  const clipId = crypto.randomUUID(), otherClipId = crypto.randomUUID(), runId = crypto.randomUUID();
  const writes: AgentTaskEditingWrite[] = [
    { kind: 'timeline_clip_audio', id: clipId, state: 'committing', runId, stepId: crypto.randomUUID() },
  ];
  const audioMatch = findMioWriteForTarget(writes, { kind: 'timeline_clip_audio', id: clipId });
  assert.ok(audioMatch);
  assert.equal(audioMatch.color, mioFollowColor(runId));
  assert.equal(findMioWriteForTarget(writes, { kind: 'timeline_clip_visual', id: clipId }), null, 'visual stays unlocked while Mio edits audio');
  assert.equal(findMioWriteForTarget(writes, { kind: 'timeline_clip_timing', id: clipId }), null, 'timing stays unlocked while Mio edits audio');
  assert.equal(findMioWriteForTarget(writes, { kind: 'timeline_clip_audio', id: otherClipId }), null, 'other clip stays unlocked');

  // Whole-clip write overlaps every group on that clip.
  const wholeWrites: AgentTaskEditingWrite[] = [
    { kind: 'timeline_clip', id: clipId, state: 'committing', runId, stepId: crypto.randomUUID() },
  ];
  for (const kind of ['timeline_clip_audio', 'timeline_clip_visual', 'timeline_clip_timing'] as const) {
    assert.ok(findMioWriteForTarget(wholeWrites, { kind, id: clipId }), `${kind} locks when Mio writes whole clip`);
  }
  assert.equal(clipFieldGroup('gain'), 'audio');
  assert.equal(clipFieldTargetKind('gain'), 'timeline_clip_audio');
  assert.equal(clipFieldGroup('rect'), 'visual');
  assert.equal(clipFieldTargetKind('colour'), 'timeline_clip_visual');
  assert.equal(clipFieldTargetKind('durationFrames'), 'timeline_clip_timing');
  assert.equal(clipFieldTargetKind('name'), 'timeline_clip');
});

test('A3: structured conflict parsing handles all three rejection reasons and formats side-by-side values', () => {
  const clipId = crypto.randomUUID();
  const target: AgentTaskTarget = { kind: 'timeline_clip_audio', id: clipId, revision: 2 };
  const revisionConflict = parseCoEditingClaimResult({
    status: 'rejected',
    code: 'AGENT_TASK_TARGET_CHANGED',
    requestId: 'req-1',
    details: {
      reason: 'revision_changed',
      targets: [{
        kind: 'timeline_clip_audio',
        id: clipId,
        expectedRevision: 2,
        currentRevision: 3,
        currentValues: { gain: 10 ** (-6 / 20), fadeInFrames: 15, muted: false },
      }],
    },
  }, target);
  assert.equal(revisionConflict?.kind, 'revision_changed');
  if (revisionConflict?.kind === 'revision_changed') {
    assert.equal(revisionConflict.currentRevision, 3);
    const { t, formatNumber } = createI18nTestContext('zh-Hans');
    const comparison = buildCoEditingComparison({
      localValues: { gain: 10 ** (-3 / 20), fadeInFrames: 15, muted: false },
      serverValues: revisionConflict.currentValues as Record<string, unknown>,
      baselineValues: { gain: 1, fadeInFrames: 15, muted: false },
      fields: ['gain', 'fadeInFrames', 'muted'],
      format: { fps: 30, t, formatNumber },
    });
    assert.equal(comparison.rows.length, 1);
    assert.equal(comparison.rows[0]?.field, 'gain');
    assert.equal(comparison.rows[0]?.label, '音量');
    assert.equal(comparison.rows[0]?.mine, '−3.0 dB');
    assert.equal(comparison.rows[0]?.mio, '−6.0 dB');
    assert.equal(comparison.conflictedFields.has('gain'), true);
    assert.equal(comparison.conflictedFields.has('fadeInFrames'), false);

    // Adopting Mio's audio values patches only audio fields and leaves sibling groups untouched.
    const audioPatch = clipDraftPatchFromServerValues('audio', revisionConflict.currentValues as Record<string, unknown>);
    assert.ok(typeof audioPatch.gain === 'number');
    assert.equal(audioPatch.fadeInFrames, 15);
    assert.equal(Object.hasOwn(audioPatch, 'rect'), false);
  }

  const committing = parseCoEditingClaimResult({
    status: 'rejected',
    code: 'AGENT_TASK_MIO_COMMITTING',
    details: { reason: 'mio_committing', writes: [{ kind: 'timeline_clip_audio', id: clipId, state: 'committing', runId: 'r1', stepId: 's1' }] },
  }, target);
  assert.equal(committing?.kind, 'mio_committing');

  const outcomeUnknown = parseCoEditingClaimResult({
    status: 'rejected',
    code: 'AGENT_TASK_UNKNOWN_RESULT',
    details: { reason: 'outcome_unknown', writes: [{ kind: 'timeline_clip_audio', id: clipId, state: 'outcome_unknown', runId: 'r1', stepId: 's1' }] },
  }, target);
  assert.equal(outcomeUnknown?.kind, 'outcome_unknown');

  const claimUnknown = parseCoEditingClaimResult({
    status: 'unknown',
    code: 'AGENT_TASK_UNKNOWN_RESULT',
    requestId: 'req-lost',
  }, target);
  assert.deepEqual(claimUnknown, {
    kind: 'claim_unknown',
    targetKind: 'timeline_clip_audio',
    targetId: clipId,
    revision: 2,
    requestId: 'req-lost',
  });
});

test('A3: subtitle and note comparisons preserve user-authored text verbatim', () => {
  const { t, formatNumber } = createI18nTestContext('zh-Hans');
  const comparison = buildCoEditingComparison({
    localValues: { text: '我的字幕文案', startFrame: 30, durationFrames: 90 },
    serverValues: { text: 'Mio 改后的字幕', startFrame: 30, durationFrames: 60 },
    baselineValues: { text: '原字幕', startFrame: 30, durationFrames: 90 },
    fields: ['text', 'startFrame', 'durationFrames'],
    format: { fps: 30, t, formatNumber },
  });
  assert.deepEqual(comparison.rows.map(row => row.field), ['text', 'durationFrames']);
  assert.equal(comparison.rows[0]?.mine, '我的字幕文案');
  assert.equal(comparison.rows[0]?.mio, 'Mio 改后的字幕');
  assert.equal(comparison.rows[1]?.mine, '3.0s');
  assert.equal(comparison.rows[1]?.mio, '2.0s');
});

test('A4: unfinished edits bar collapses to one line, expands deduplicated rows with badges, locate, End all (N), and static In use', async () => {
  const projectId = crypto.randomUUID();
  const clipId = crypto.randomUUID(), subId = crypto.randomUUID(), assetId = crypto.randomUUID();
  const retainedOwner = `normal:${crypto.randomUUID()}:timeline_clip_audio:${clipId}`;
  const localOwner = `normal:${crypto.randomUUID()}:timeline_subtitle:${subId}`;
  const foreignOwner = `normal:${crypto.randomUUID()}:asset_annotation:${assetId}`;
  const retainedClaimId = crypto.randomUUID(), subClaimId = crypto.randomUUID(), foreignClaimId = crypto.randomUUID();

  let statusView = {
    groups: [
      {
        projectId,
        kind: 'timeline_clip',
        id: clipId,
        locator: { kind: 'timeline_clip', id: clipId },
        canEnd: true,
        status: 'unconfirmed' as const,
        owners: [{
          claim: { id: retainedClaimId, projectId, ownerId: retainedOwner, target: { kind: 'timeline_clip_audio', id: clipId, revision: 2 }, state: 'active' as const, createdAt: '2026-11-28T00:00:00Z', updatedAt: '2026-11-28T00:00:00Z' },
          generation: 10, sequence: 1, claimSnapshot: 'a'.repeat(64), liveness: 'retained' as const,
          locator: { kind: 'timeline_clip_audio', id: clipId }, canEnd: true, status: 'unconfirmed' as const,
        }],
      },
      {
        projectId,
        kind: 'timeline_subtitle',
        id: subId,
        locator: { kind: 'timeline_subtitle', id: subId },
        canEnd: false,
        status: 'local_unsaved' as const,
        owners: [{
          claim: { id: subClaimId, projectId, ownerId: localOwner, target: { kind: 'timeline_subtitle', id: subId, revision: 1 }, state: 'active' as const, createdAt: '2026-11-28T00:00:00Z', updatedAt: '2026-11-28T00:00:00Z' },
          generation: 11, sequence: 2, claimSnapshot: 'b'.repeat(64), liveness: 'in_use' as const,
          locator: { kind: 'timeline_subtitle', id: subId }, canEnd: false, status: 'local_unsaved' as const,
        }],
      },
      {
        projectId,
        kind: 'asset_annotation',
        id: assetId,
        locator: { kind: 'asset_annotation', id: assetId },
        canEnd: false,
        status: 'another_window' as const,
        owners: [{
          claim: { id: foreignClaimId, projectId, ownerId: foreignOwner, target: { kind: 'asset_annotation', id: assetId, revision: 1 }, state: 'active' as const, createdAt: '2026-11-28T00:00:00Z', updatedAt: '2026-11-28T00:00:00Z' },
          generation: 12, sequence: 3, claimSnapshot: 'c'.repeat(64), liveness: 'in_use' as const,
          locator: { kind: 'asset_annotation', id: assetId }, canEnd: false, status: 'another_window' as const,
        }],
      },
    ],
    endableClaimCount: 1,
    endableGroupCount: 1,
  };

  const located: Array<{ kind: string; id: string }> = [];
  const batchInputs: Array<{ claims: Array<{ claimId: string }> }> = [];
  const slots: UiHook[] = [];
  let cursor = 0, effects: number[] = [];
  const react = {
    createElement: (type: unknown, props: Record<string, unknown> | null, ...children: UiTree[]) => ({ type, props: { ...props, children } }) as unknown as UiElement,
    Fragment: 'fragment',
    useRef: (value: unknown) => slots[cursor++] ??= { current: value },
    useState: (value: unknown) => {
      const at = cursor++;
      slots[at] ??= { value };
      return [slots[at].value, (next: unknown) => { slots[at].value = typeof next === 'function' ? (next as (prev: unknown) => unknown)(slots[at].value) : next; }];
    },
    useLayoutEffect: (fn: () => void | (() => void), deps: readonly unknown[]) => {
      const at = cursor++, old = slots[at];
      if (!old || deps.some((value, index) => value !== old.deps![index])) {
        slots[at] = { ...old, fn, deps };
        effects.push(at);
      }
    },
  };
  (react as typeof react & { default?: unknown }).default = react;
  const previousStorage = globalThis.sessionStorage;
  const storage = new Map<string, string>();
  globalThis.sessionStorage = {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v),
    removeItem: (k: string) => storage.delete(k),
  } as unknown as Storage;

  try {
    const mod: UiModule = { exports: {} };
    Function('require', 'module', 'exports', transformSync(readWeb('AgentRetainedEditing.tsx'), { loader: 'tsx', format: 'cjs' }).code)((id: string) => {
      if (id === 'react') return react;
      if (id === './i18n/I18nProvider.tsx') return i18nTestModule('zh-Hans');
      if (id.includes('workbench-controls')) return { WorkbenchButton: 'button' };
      if (id.includes('workbench-confirm')) return { useConfirmation: () => async () => true };
      if (id.includes('packages/i18n')) return { message: (key: string) => ({ key }) };
      if (id.includes('agent-tasks-v2')) return { AGENT_TASK_DISPLAY_TARGET_KINDS, agentTaskEditingResolveBatchSchema, agentTaskEditingSchema, agentTaskEditingTargetRevisionKind };
      if (id === './agent-editing-protection.ts') return { createAgentEditingClient: () => ({}) };
      if (id === './AgentEditingBoundary.tsx') return {
        agentRetainedEditingEvidence: () => ({ ownsWindow: (ownerId: string) => ownerId === localOwner }),
        invalidateAgentEditingOwner() {},
        releaseLocalAgentEditingOwner: async () => true,
        subscribeAgentEditingChanges: () => () => {},
      };
      if (id === './agent-retained-editing.ts') return {
        createRetainedEditingClient: () => ({
          readStatus: async () => structuredClone(statusView),
          resolve: async (input: { projectId: string; requestId: string; claims: Array<{ claimId: string }> }) => {
            batchInputs.push(input);
            const released = input.claims.map(c => c.claimId);
            statusView = {
              groups: statusView.groups.filter(g => !g.owners.every(o => released.includes(o.claim.id))),
              endableClaimCount: 0,
              endableGroupCount: 0,
            };
            return { projectId: input.projectId, requestId: input.requestId, releasedClaimIds: released };
          },
          lookup: async () => null,
        }),
        matchesEditingBatchReceipt,
        RetainedEditingConflict,
      };
      if (id === './agent-task-presentation.ts') return { taskDisplayTargets };
      if (id === './icons.tsx') return { __esModule: true, default: 'Icon' };
      if (id.endsWith('.css')) return {};
      throw Error(`Unmocked: ${id}`);
    }, mod, mod.exports);

    const render = () => {
      cursor = 0; effects = [];
      const tree = mod.exports.default!({
        projectId, visible: true, readOnly: false,
        targetName: (kind: string, id: string) => id === clipId ? '窗口剪影' : id === subId ? '雨后的城市街道' : id === assetId ? 'scene-b.mp4' : undefined,
        onLocateTarget: (locator: { kind: string; id: string }) => located.push(locator),
      });
      for (const at of effects) { slots[at].cleanup?.(); slots[at].cleanup = slots[at].fn!(); }
      return tree;
    };

    render(); await flush();
    const collapsed = render();
    const toggle = nodes(collapsed).find(node => node.props?.['data-testid'] === 'agent-retained-toggle')!;
    assert.ok(toggle);
    assert.equal(toggle.props['aria-expanded'], false, 'collapsed by default');
    assert.match(textOf(toggle), /3 处编辑没结束/);
    assert.equal(nodes(collapsed).find(node => node.props?.['data-testid'] === 'agent-retained-list'), undefined, 'rows hidden when collapsed');

    // Expand bar: shows End all (1), 3 deduplicated rows, locate, End, and static In use for another_window.
    toggle.props.onClick();
    const expanded = render();
    const endAll = nodes(expanded).find(node => node.props?.['data-testid'] === 'agent-retained-end-all')!;
    assert.ok(endAll);
    assert.match(textOf(endAll), /全部结束 \(1\)/);
    const rows = nodes(expanded).filter(node => node.props?.['data-testid'] === 'agent-retained-row');
    assert.equal(rows.length, 3);
    const foreignRow = rows.find(row => row.props['data-status'] === 'another_window')!;
    assert.ok(nodes(foreignRow).find(node => node.props?.['data-testid'] === 'agent-retained-in-use'), 'another_window shows static In use');
    assert.equal(nodes(foreignRow).find(node => node.props?.['data-testid'] === 'agent-retained-end'), undefined, 'another_window cannot be ended');

    // Locate button invokes callback with the group's locator.
    const locateButtons = nodes(expanded).filter(node => node.props?.['data-testid'] === 'agent-retained-locate');
    assert.equal(locateButtons.length, 2);
    locateButtons[0]!.props.onClick();
    assert.deepEqual(located, [{ kind: 'timeline_clip', id: clipId }]);

    // Clicking End all (1) resolves only the host-confirmed retained claim, leaving another_window untouched.
    await endAll.props.onClick();
    await flush();
    assert.equal(batchInputs.length, 1);
    assert.deepEqual(batchInputs[0]?.claims.map(c => c.claimId), [retainedClaimId]);
    const afterEndAll = render();
    const remainingRows = nodes(afterEndAll).filter(node => node.props?.['data-testid'] === 'agent-retained-row');
    assert.equal(remainingRows.length, 2);
    assert.ok(remainingRows.some(row => row.props['data-status'] === 'another_window'));
  } finally {
    for (const slot of slots) slot.cleanup?.();
    globalThis.sessionStorage = previousStorage;
  }
});

test('A3: reconcileCoEditing patches only the conflicted group and absorbs the refreshed timeline revision cleanly', () => {
  const projectId = crypto.randomUUID(), timelineId = crypto.randomUUID(), clipId = crypto.randomUUID(), assetId = crypto.randomUUID();
  const baseRaw = clipDraftRaw({
    name: 'Clip 1',
    trackId: 'track-v1',
    startFrame: 0,
    durationFrames: 90,
    sourceInFrame: 0,
    gain: 1,
    rect: { x: 0, y: 0, width: 1280, height: 720 },
  });
  const baseCtx = {
    scope: `${projectId}:${clipId}`,
    projectId,
    timelineId,
    clipId,
    connected: true,
    busy: false,
    visible: true,
    volumeEnvelopeEditable: false,
    audioRoleEditable: false,
    timelineRevision: 2,
    source: { assetId, assetSha256: 'a'.repeat(64) },
    saved: baseRaw,
  };
  const controller = createClipDraftController({
    context: baseCtx,
    client: {
      get: async () => ({ supported: true, key: { projectId, timelineId, clipId }, workspaceScope: 'ws', instanceId: 'i1', revision: 0, draft: null, targetStatus: 'matching' }),
      put: async req => ({ supported: true, key: { projectId, timelineId, clipId }, workspaceScope: req.workspaceScope, instanceId: req.instanceId, revision: req.expectedRevision + 1, draft: { raw: req.raw, baseRevision: req.baseRevision, source: req.source, updatedAt: '2026-11-28T00:00:00Z' }, targetStatus: 'matching' }),
      remove: async req => ({ supported: true, key: { projectId, timelineId, clipId }, workspaceScope: req.workspaceScope, instanceId: req.instanceId, revision: req.expectedRevision + 1, draft: null, targetStatus: 'matching' }),
    },
  });

  // User edited both visual (rect) and audio (gain). Mio modified only audio (gain -> -6 dB).
  controller.edit('rect', { x: 10, y: 20, width: 1280, height: 720 });
  controller.edit('gain', 10 ** (-3 / 20));
  assert.equal(controller.getState().dirty, true);

  const mioGain = 10 ** (-6 / 20);
  const patch = clipDraftPatchFromServerValues('audio', { gain: mioGain });
  controller.reconcileCoEditing({ patch, clearConflict: true, adoptNextRevision: true });
  assert.equal(controller.getState().raw.gain, mioGain, 'adopting Mio updates only audio');
  assert.deepEqual(controller.getState().raw.rect, { x: 10, y: 20, width: 1280, height: 720 }, 'dirty visual edit is preserved');
  assert.equal(controller.getState().dirty, true);
  assert.equal(controller.getState().conflict, false);

  // When refreshed timeline revision 3 arrives right after reconcileCoEditing, it rebases cleanly without re-flagging conflict.
  controller.setContext({
    ...baseCtx,
    timelineRevision: 3,
    saved: { ...baseRaw, gain: mioGain },
  });
  assert.equal(controller.getState().baseRevision, 3);
  assert.equal(controller.getState().conflict, false);
  assert.deepEqual(controller.getState().raw.rect, { x: 10, y: 20, width: 1280, height: 720 });

  // A subsequent third write at revision 4 still triggers strict conflict detection.
  controller.setContext({
    ...baseCtx,
    timelineRevision: 4,
    saved: { ...baseRaw, gain: mioGain, name: 'Renamed' },
  });
  assert.equal(controller.getState().conflict, true);
  controller.dispose();
});

test('i18n: all co-editing keys exist in all four locales and English contains no CJK', () => {
  assert.deepEqual(validateCatalogs(), []);
  const keys = [
    'agent.coEdit.mioEditing', 'agent.coEdit.conflictHeading', 'agent.coEdit.mineValue',
    'agent.coEdit.mioValue', 'agent.coEdit.adoptMio', 'agent.coEdit.keepMine',
    'agent.coEdit.unresolvedConflict', 'agent.coEdit.retainedBar', 'agent.coEdit.endAll',
    'agent.coEdit.endOne', 'agent.coEdit.inUse', 'agent.coEdit.status.local_unsaved',
    'agent.coEdit.status.local_occupied', 'agent.coEdit.status.another_window', 'agent.coEdit.status.unconfirmed',
  ] as const;
  for (const key of keys) {
    for (const locale of LOCALES) {
      const value = translate(locale, key as never, { group: 'Audio', value: '−3.0 dB', count: 2 } as never);
      assert.ok(value.length > 0, `${key}/${locale}`);
      if (locale === 'en') {
        assert.doesNotMatch(value, /[\u4e00-\u9fff\u3040-\u30ff]/u, `English key ${key} must not contain CJK: ${value}`);
      }
    }
  }
});
