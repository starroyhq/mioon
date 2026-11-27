import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {FCP_EXPORT_TASK_KIND} from '../packages/contracts/src/fcp-export.ts';
import type {FcpClipRef} from '../packages/contracts/src/fcp-export.ts';
import {
  PREMIERE_EXPORT_OPERATIONS,
  PREMIERE_EXPORT_TASK_KIND,
  PREMIERE_ITEM_CODES,
  PREMIERE_MISSING_ITEM_CODES,
  premiereExportPreviewOutputSchema,
} from '../packages/contracts/src/premiere-export.ts';
import type {PremiereExportPreviewOutput} from '../packages/contracts/src/premiere-export.ts';
import {
  PREMIERE_EXPORT_NATIVE_CHANNEL,
  PREMIERE_EXPORT_NATIVE_GLOBAL,
} from '../packages/contracts/src/premiere-export-native.ts';
import {rpcPathFor} from '../packages/contracts/src/project-addressing.ts';
import {LOCALES, renderMessage, translate} from '../packages/i18n/src/index.ts';
import {readFcpExportBridge, readPremiereExportBridge} from '../apps/web/src/fcp-export-bridge.ts';
import {
  applyFcpTaskUpdate,
  exportStartKey,
  fcpBundleFileName,
  fcpItemAffectedText,
  fcpItemLabelMessage,
  fcpItemTooltipText,
  formatFcpErrorFrames,
  isEditorExportHistoryRow,
  isFcpExportHistoryRow,
  isPremiereExportHistoryRow,
  mergeFcpExportHistory,
  mergeFcpStartReceipt,
  needsFcpTaskStatus,
} from '../apps/web/src/fcp-export-state.ts';
import type {EditorExportItem, FcpExportTaskRecord} from '../apps/web/src/fcp-export-state.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (file: string) => readFileSync(join(root, file), 'utf8');

const clip = (id: string, name: string, trackLabel?: string): FcpClipRef =>
  trackLabel ? {id, name, trackLabel} : {id, name};

interface BuiltEditorUi {
  renderDialog(props: Record<string, unknown>, locale?: string): string;
  renderToast(props: Record<string, unknown>, locale?: string): string;
  renderTaskCenterEntries(tasks: readonly FcpExportTaskRecord[], locale?: string): Array<{
    key: string;
    label: string;
    status: string;
    active: boolean;
    warning: boolean;
    group: string;
    html: string;
  }>;
  overviewItems(tasks: readonly FcpExportTaskRecord[], locale?: string): Array<{
    id: string;
    label: string;
    status: string;
    phase?: string;
    tone?: string;
    progress?: number;
    detail?: string;
  }>;
}

let built: BuiltEditorUi | null = null;
async function ui(): Promise<BuiltEditorUi> {
  if (built) return built;
  const fixture = `
    import React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import { renderMessage, translate } from '../../packages/i18n/src/index.ts';
    import FcpExportDialog, { FcpExportToast, fcpExportTaskCenterEntries, fcpExportTaskOverviewItems } from './src/FcpExportDialog.tsx';

    const noop = () => {};
    const makeT = (locale = 'zh-Hans') => ({
      t: (key, params) => translate(locale, key, params),
      renderMessage: value => renderMessage(locale, value),
    });

    export const renderDialog = (props) =>
      renderToStaticMarkup(
        <FcpExportDialog
          open={true}
          target="premiere-export"
          phase="setup"
          preview={null}
          previewLoading={false}
          previewError={false}
          name=""
          copyMedia={true}
          displayPath=""
          starting={false}
          cancelling={false}
          task={null}
          finalCutInstalled={true}
          onOpenChange={noop}
          onNameChange={noop}
          onCopyMediaChange={noop}
          onChooseDestination={noop}
          onStart={noop}
          onCancelExport={noop}
          onReveal={noop}
          onOpenInFinalCut={noop}
          onRetry={noop}
          onChangeLocation={noop}
          {...props}
        />,
      );

    export const renderToast = (props) =>
      renderToStaticMarkup(
        <FcpExportToast task={null} onReveal={noop} onDismiss={noop} {...props} />,
      );

    export const renderTaskCenterEntries = (tasks, locale = 'zh-Hans') => {
      const helpers = makeT(locale);
      return fcpExportTaskCenterEntries(tasks, {
        ...helpers,
        onOpen: noop,
        onCancel: noop,
        onReveal: noop,
        onRetry: noop,
      }).map(entry => ({
        key: entry.key,
        label: entry.label,
        status: entry.status,
        active: entry.active,
        warning: entry.warning,
        group: entry.group,
        html: renderToStaticMarkup(entry.detail),
      }));
    };

    export const overviewItems = (tasks, locale = 'zh-Hans') => {
      const helpers = makeT(locale);
      return fcpExportTaskOverviewItems(tasks, {
        ...helpers,
        onOpen: noop,
        onCancel: noop,
        onRetry: noop,
      });
    };
  `;
  const result = await build({
    stdin: {contents: fixture, loader: 'tsx', resolveDir: join(root, 'apps/web')},
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    jsx: 'automatic',
    loader: {'.css': 'empty'},
    define: {'process.env.NODE_ENV': '"production"'},
    plugins: [{
      name: 'ssr-dialog-inline',
      setup(pluginBuild) {
        pluginBuild.onResolve({filter: /^@mioon\/ui\/components\/dialog$/}, () => ({
          path: 'ssr-dialog',
          namespace: 'ssr-stub',
        }));
        pluginBuild.onLoad({filter: /.*/, namespace: 'ssr-stub'}, () => ({
          loader: 'tsx',
          resolveDir: join(root, 'apps/web'),
          contents: `
            import React from 'react';
            export const Dialog = ({open, children}) => open ? <div data-slot="dialog-root">{children}</div> : null;
            export const DialogContent = ({children, showCloseButton: _s, ...rest}) => <div data-slot="dialog-content" {...rest}>{children}</div>;
            export const DialogTitle = ({children, ...rest}) => <h2 data-slot="dialog-title" {...rest}>{children}</h2>;
            export const DialogDescription = ({children, ...rest}) => <p data-slot="dialog-description" {...rest}>{children}</p>;
            export const DialogClose = ({children, ...rest}) => <button type="button" {...rest}>{children}</button>;
          `,
        }));
      },
    }],
  });
  const mod = {exports: {}};
  Function('require', 'module', 'exports', result.outputFiles![0]!.text)(
    createRequire(import.meta.url),
    mod,
    mod.exports,
  );
  built = mod.exports as BuiltEditorUi;
  return built;
}

const samplePremierePreview: PremiereExportPreviewOutput = {
  timeline: {width: 1080, height: 1920, fps: 30, durationFrames: 720, clipCount: 8},
  defaultName: '城市夜景短片',
  projectDestination: {displayPath: '~/影片/城市夜景短片/导出'},
  mediaFiles: 6,
  mediaBytes: Math.round(1.2 * 1024 * 1024 * 1024),
  missing: [
    {code: 'LUT', clips: [clip('c1', 'scene-a'), clip('c3', 'scene-c')]},
    {code: 'PLACEHOLDER', clips: [clip('c4', '镜头 04')]},
    {
      code: 'SUBTITLES',
      clips: Array.from({length: 12}, (_, index) => clip(`sub-${index + 1}`, `字幕 ${index + 1}`, '字幕')),
    },
  ],
  approximations: [
    {
      code: 'TRANSITION',
      clips: [clip('t1', 'scene-a'), clip('t2', 'scene-b'), clip('t3', 'scene-c')],
      values: {from: '向左推入', to: 'Push'},
    },
    {
      code: 'VOLUME_KEYFRAMES',
      clips: [
        clip('a1', 'bgm-1', 'A1'),
        clip('a2', 'bgm-2', 'A1'),
        clip('a3', 'bgm-3', 'A1'),
        clip('a4', 'bgm-4', 'A1'),
      ],
    },
    {
      code: 'ANCHOR',
      clips: [clip('o1', 'overlay-1', 'V2'), clip('o2', 'overlay-2', 'V2'), clip('o3', 'overlay-3', 'V2')],
    },
    {
      code: 'MUTE',
      clips: [clip('c1', 'scene-a')],
    },
    {
      code: 'FADES',
      clips: [clip('c2', 'scene-b')],
    },
  ],
};

function samplePremiereTask(overrides: Partial<FcpExportTaskRecord> = {}): FcpExportTaskRecord {
  return {
    exportId: 'exp_pr_01',
    projectId: '11111111-1111-4111-8111-111111111111',
    kind: PREMIERE_EXPORT_TASK_KIND,
    name: '城市夜景短片',
    requestId: 'pr-request-1',
    startInput: {
      projectId: '11111111-1111-4111-8111-111111111111',
      requestId: 'pr-request-1',
      name: '城市夜景短片',
      copyMedia: true,
      destination: {kind: 'project'},
    },
    displayPath: '~/影片/城市夜景短片/导出',
    status: 'running',
    progress: {
      files: 3,
      totalFiles: 6,
      bytes: 420 * 1024 * 1024,
      totalBytes: Math.round(1.2 * 1024 * 1024 * 1024),
    },
    missing: samplePremierePreview.missing,
    approximations: samplePremierePreview.approximations,
    createdAt: '2026-11-27T12:00:00.000Z',
    ...overrides,
  };
}

test('Premiere export contracts validate operations, SUBTITLES missing code, native bridge global, and RPC path', () => {
  assert.deepEqual(PREMIERE_EXPORT_OPERATIONS, [
    'export.premiere.preview',
    'export.premiere.start',
    'export.premiere.get',
    'export.premiere.cancel',
  ]);
  assert.equal(PREMIERE_EXPORT_TASK_KIND, 'premiere-export');
  assert.equal(PREMIERE_EXPORT_NATIVE_GLOBAL, '__mioonPremiereExport');
  assert.equal(PREMIERE_EXPORT_NATIVE_CHANNEL, 'mioon:premiere-export');
  assert.ok(PREMIERE_MISSING_ITEM_CODES.includes('SUBTITLES'));
  assert.ok(PREMIERE_ITEM_CODES.includes('SUBTITLES'));

  const projectId = '11111111-1111-4111-8111-111111111111';
  for (const op of PREMIERE_EXPORT_OPERATIONS) {
    assert.equal(rpcPathFor(op, {projectId}), `/api/projects/${projectId}/rpc`);
  }

  const parsed = premiereExportPreviewOutputSchema.parse(samplePremierePreview);
  assert.equal(parsed.missing.find(item => item.code === 'SUBTITLES')?.clips.length, 12);
  assert.throws(() => premiereExportPreviewOutputSchema.parse({
    ...samplePremierePreview,
    approximations: [{code: 'SUBTITLES', clips: [clip('s1', '字幕 1')]}],
  }));
});

test('desktop bridge reader reads __mioonPremiereExport independently of __mioonFcpExport', () => {
  assert.equal(readPremiereExportBridge({}), null);
  assert.equal(readPremiereExportBridge({[PREMIERE_EXPORT_NATIVE_GLOBAL]: null}), null);
  assert.equal(readPremiereExportBridge({[PREMIERE_EXPORT_NATIVE_GLOBAL]: {chooseDestination: () => null}}), null);

  const premiereBridge = {
    chooseDestination: async () => ({token: 't1', displayPath: '~/Desktop'}),
    reveal: async () => true,
    openInPremiere: async () => true,
    premiereInstalled: async () => true,
  };
  assert.equal(readPremiereExportBridge({[PREMIERE_EXPORT_NATIVE_GLOBAL]: premiereBridge}), premiereBridge);
  assert.equal(readFcpExportBridge({[PREMIERE_EXPORT_NATIVE_GLOBAL]: premiereBridge}), null);
});

test('Premiere folder name, SUBTITLES, SPEED copy mapping, and Premiere UI strings work in all 4 locales', () => {
  assert.equal(fcpBundleFileName('城市夜景短片', PREMIERE_EXPORT_TASK_KIND), '城市夜景短片 Premiere');
  assert.equal(fcpBundleFileName('城市夜景短片 Premiere', PREMIERE_EXPORT_TASK_KIND), '城市夜景短片 Premiere');
  assert.equal(fcpBundleFileName('城市夜景短片 Premiere 2', PREMIERE_EXPORT_TASK_KIND), '城市夜景短片 Premiere 2');
  assert.equal(fcpBundleFileName('', PREMIERE_EXPORT_TASK_KIND), 'Premiere');
  assert.equal(exportStartKey(FCP_EXPORT_TASK_KIND, 'p1'), 'fcpxml-export:p1');
  assert.equal(exportStartKey(PREMIERE_EXPORT_TASK_KIND, 'p1'), 'premiere-export:p1');

  assert.equal(formatFcpErrorFrames(0), '0');
  assert.equal(formatFcpErrorFrames(1), '1');
  assert.equal(formatFcpErrorFrames(0.037257), '0.04');
  assert.equal(formatFcpErrorFrames(0.0042), '0.004');
  assert.equal(formatFcpErrorFrames(1.093937), '1.09');

  const subtitlesItem: EditorExportItem = {
    code: 'SUBTITLES',
    clips: Array.from({length: 12}, (_, index) => clip(`s-${index + 1}`, `字幕 ${index + 1}`, '字幕')),
  };
  const speedItems: EditorExportItem[] = [
    {code: 'SPEED', clips: [clip('c1', 'scene-a'), clip('c2', 'scene-b')]},
    {
      code: 'SPEED',
      clips: [clip('c1', 'scene-a')],
      values: {from: '变速', to: '保留时间线长度，按原速写入'},
    },
    {
      code: 'SPEED',
      clips: [clip('c2', 'scene-b')],
      values: {from: '光流', to: '按原片取帧'},
    },
    {
      code: 'SPEED',
      clips: [clip('c1', 'scene-a'), clip('c3', 'scene-c')],
      values: {from: '曲线变速', to: '线性关键时间点', maxErrorFrames: 0.037257},
    },
    {
      code: 'SPEED',
      clips: [],
      values: {from: '曲线变速', to: '线性关键时间点', maxErrorFrames: 0.24409},
    },
  ];

  for (const locale of LOCALES) {
    for (const key of [
      'fcpExport.menu.exportPremiere',
      'fcpExport.premiere.title',
      'fcpExport.premiere.bundleSuffix',
      'fcpExport.premiere.action.openInPremiere',
      'fcpExport.premiere.done.toast',
      'fcpExport.premiere.task.group',
      'fcpExport.item.SUBTITLES',
      'fcpExport.item.SPEED',
    ] as const) {
      const value = translate(locale, key);
      assert.ok(value.length > 0 && !value.includes('fcpExport.') && !value.includes('{'), `${locale}:${key} => ${value}`);
    }
    const subLabel = renderMessage(locale, fcpItemLabelMessage(subtitlesItem));
    const subAffected = fcpItemAffectedText(subtitlesItem, locale);
    assert.ok(subLabel.length > 0 && !subLabel.includes('{'));
    assert.ok(subAffected.includes('12'), `${locale} => ${subAffected}`);
    for (const item of speedItems) {
      const label = renderMessage(locale, fcpItemLabelMessage(item));
      const affected = fcpItemAffectedText(item, locale);
      assert.ok(label.length > 0 && !label.includes('fcpExport.') && !label.includes('{'), `${locale}:${label}`);
      assert.ok(affected.length > 0 && !affected.includes('fcpExport.') && !affected.includes('{'), `${locale}:${affected}`);
    }
  }

  // Exact Chinese plain-language checks matching 24-07 and SPEED guidance.
  assert.equal(renderMessage('zh-Hans', fcpItemLabelMessage(subtitlesItem)), '字幕');
  assert.equal(fcpItemAffectedText(subtitlesItem, 'zh-Hans'), '12 条');
  assert.equal(renderMessage('zh-Hans', fcpItemLabelMessage(speedItems[0]!)), '变速');
  assert.equal(fcpItemAffectedText(speedItems[0]!, 'zh-Hans'), 'scene-a、scene-b');
  assert.equal(renderMessage('zh-Hans', fcpItemLabelMessage(speedItems[1]!)), '变速 · 保留时间线长度，按原速写入');
  assert.equal(renderMessage('zh-Hans', fcpItemLabelMessage(speedItems[2]!)), '变速 · 光流 → 按原片取帧');
  assert.equal(renderMessage('zh-Hans', fcpItemLabelMessage(speedItems[3]!)), '变速 · 曲线变速 → 线性关键时间点');
  assert.equal(fcpItemAffectedText(speedItems[3]!, 'zh-Hans'), '最大偏差 0.04 帧 · scene-a、scene-c');
  assert.equal(fcpItemTooltipText(speedItems[3]!, 'zh-Hans'), '最大偏差 0.04 帧 · scene-a、scene-c');
  assert.equal(fcpItemAffectedText(speedItems[4]!, 'zh-Hans'), '最大偏差 0.24 帧');
  assert.equal(fcpItemTooltipText(speedItems[4]!, 'zh-Hans'), '最大偏差 0.24 帧');
  assert.equal(fcpItemAffectedText(speedItems[3]!, 'en'), 'Max error 0.04 frames · scene-a, scene-c');
});

test('FcpExportDialog renders Premiere setup (24-07), running, done with/without Premiere (24-08, 24-09), and failed phases', async () => {
  const rendered = await ui();
  const setupHtml = rendered.renderDialog({
    target: PREMIERE_EXPORT_TASK_KIND,
    phase: 'setup',
    preview: samplePremierePreview,
    name: samplePremierePreview.defaultName,
    copyMedia: true,
    displayPath: samplePremierePreview.projectDestination.displayPath,
  });
  assert.match(setupHtml, /data-target="premiere"/);
  assert.match(setupHtml, /导出到 Premiere Pro/);
  assert.match(setupHtml, /1080×1920 · 30 fps · 00:00:24 · 8 个片段/);
  assert.match(setupHtml, /class="fcp-export-name-suffix"[^>]*>Premiere</);
  assert.doesNotMatch(setupHtml, /\.fcpxmld/);
  assert.match(setupHtml, /data-testid="fcp-export-missing-group"/);
  assert.match(setupHtml, /data-testid="fcp-export-item-SUBTITLES"/);
  assert.match(setupHtml, />字幕</);
  assert.match(setupHtml, />12 条</);
  assert.match(setupHtml, /data-testid="fcp-export-approximations-group"/);
  assert.match(setupHtml, /aria-expanded="false"/);

  const runningHtml = rendered.renderDialog({
    target: PREMIERE_EXPORT_TASK_KIND,
    phase: 'running',
    task: samplePremiereTask(),
    name: '城市夜景短片',
  });
  assert.match(runningHtml, /导出到 Premiere Pro/);
  assert.match(runningHtml, /城市夜景短片 Premiere/);
  assert.match(runningHtml, /正在复制素材 3 \/ 6/);
  assert.match(runningHtml, /420 MB \/ 1\.2 GB/);
  assert.match(runningHtml, /取消导出/);

  const doneTask = samplePremiereTask({
    status: 'done',
    result: {
      bundleName: '城市夜景短片 Premiere',
      displayPath: '~/影片/城市夜景短片/导出',
      bytes: samplePremierePreview.mediaBytes,
      missingCount: 3,
    },
  });
  const doneWithPremiere = rendered.renderDialog({
    target: PREMIERE_EXPORT_TASK_KIND,
    phase: 'done',
    task: doneTask,
    finalCutInstalled: true,
  });
  assert.match(doneWithPremiere, /导出到 Premiere Pro/);
  assert.match(doneWithPremiere, /城市夜景短片 Premiere/);
  assert.match(doneWithPremiere, /1\.2 GB · ~\/影片\/城市夜景短片\/导出/);
  assert.match(doneWithPremiere, /3 项没带过去/);
  assert.match(doneWithPremiere, /data-testid="fcp-export-reveal"[^>]*data-variant="secondary"[^>]*>在 Finder 中显示/);
  assert.match(doneWithPremiere, /data-testid="fcp-export-open-premiere"[^>]*data-variant="primary"[^>]*>用 Premiere Pro 打开/);
  assert.doesNotMatch(doneWithPremiere, /fcp-export-open-fcp/);

  const doneNumbered = rendered.renderDialog({
    target: PREMIERE_EXPORT_TASK_KIND,
    phase: 'done',
    task: samplePremiereTask({
      status: 'done',
      result: {
        bundleName: '城市夜景短片 Premiere 2',
        displayPath: '~/影片/城市夜景短片/导出',
        bytes: 2048,
        missingCount: 0,
      },
    }),
    finalCutInstalled: false,
  });
  assert.match(doneNumbered, />城市夜景短片 Premiere 2</);
  assert.doesNotMatch(doneNumbered, /Premiere 2 Premiere/);
  assert.match(doneNumbered, /data-testid="fcp-export-reveal"[^>]*data-variant="primary"[^>]*>在 Finder 中显示/);
  assert.doesNotMatch(doneNumbered, /fcp-export-open-premiere/);
  assert.doesNotMatch(doneNumbered, /fcp-export-done-missing-toggle/);

  const failedHtml = rendered.renderDialog({
    target: PREMIERE_EXPORT_TASK_KIND,
    phase: 'failed',
    task: samplePremiereTask({
      status: 'failed',
      error: {code: 'DISK_FULL', values: {shortBytes: 300 * 1024 * 1024}},
    }),
  });
  assert.match(failedHtml, /导出到 Premiere Pro/);
  assert.match(failedHtml, /导出失败/);
  assert.match(failedHtml, /磁盘空间不够，还差 300 MB。/);
  assert.match(failedHtml, /换个位置…/);
  assert.match(failedHtml, /重试/);
});

test('Premiere toast, TaskCenter entries, TaskPopover items, and durable history coexist cleanly with FCP exports', async () => {
  const rendered = await ui();
  const projectId = '11111111-1111-4111-8111-111111111111';
  const fcpRow = {
    kind: FCP_EXPORT_TASK_KIND, mode: FCP_EXPORT_TASK_KIND, projectId,
    id: '22222222-2222-4222-8222-222222222221', requestId: 'req-fcp',
    title: '夜景 FCP', status: 'running', revision: 1,
    createdAt: '2026-11-27T12:00:00.000Z', updatedAt: '2026-11-27T12:00:01.000Z',
    progress: {files: 1, totalFiles: 2, bytes: 10, totalBytes: 20},
  };
  const premiereRow = {
    kind: PREMIERE_EXPORT_TASK_KIND, mode: PREMIERE_EXPORT_TASK_KIND, projectId,
    id: '22222222-2222-4222-8222-222222222222', requestId: 'req-premiere',
    title: '夜景剪辑', status: 'running', revision: 1,
    createdAt: '2026-11-27T12:01:00.000Z', updatedAt: '2026-11-27T12:01:01.000Z',
    progress: {files: 2, totalFiles: 4, bytes: 50, totalBytes: 100},
  };
  assert.equal(isFcpExportHistoryRow(fcpRow), true);
  assert.equal(isFcpExportHistoryRow(premiereRow), false);
  assert.equal(isPremiereExportHistoryRow(premiereRow), true);
  assert.equal(isPremiereExportHistoryRow(fcpRow), false);
  assert.equal(isEditorExportHistoryRow(fcpRow), true);
  assert.equal(isEditorExportHistoryRow(premiereRow), true);
  assert.equal(isEditorExportHistoryRow({mode: 'timeline'}), false);

  const restored = mergeFcpExportHistory([], projectId, [{mode: 'timeline'}, fcpRow, premiereRow]);
  assert.equal(restored.length, 2);
  assert.equal(restored[0]?.kind, PREMIERE_EXPORT_TASK_KIND);
  assert.equal(restored[0]?.exportId, premiereRow.id);
  assert.equal(restored[1]?.kind, FCP_EXPORT_TASK_KIND);
  assert.equal(restored[1]?.exportId, fcpRow.id);
  assert.equal(needsFcpTaskStatus(restored[0]!), true);

  // Pending uncertain Premiere start adopts its durable row without touching FCP tasks.
  const uncertainPremiere = samplePremiereTask({
    projectId,
    exportId: `failed:${PREMIERE_EXPORT_TASK_KIND}:${premiereRow.requestId}`,
    requestId: premiereRow.requestId,
    startUncertain: true,
    status: 'failed',
    error: {code: 'EXPORT_FAILED'},
  });
  const adopted = mergeFcpExportHistory([uncertainPremiere], projectId, [{...premiereRow, status: 'done'}]);
  assert.equal(adopted.length, 1);
  assert.equal(adopted[0]?.exportId, premiereRow.id);
  assert.equal(adopted[0]?.kind, PREMIERE_EXPORT_TASK_KIND);
  assert.equal(adopted[0]?.startUncertain, false);
  assert.equal(adopted[0]?.startInput, uncertainPremiere.startInput);
  assert.equal(adopted[0]?.missing, uncertainPremiere.missing);

  const donePremiere = applyFcpTaskUpdate(adopted[0]!, {
    status: 'done',
    progress: premiereRow.progress,
    result: {bundleName: '夜景剪辑 Premiere', displayPath: '~/Movies', bytes: 1024, missingCount: 1},
  });
  const mergedReceipt = mergeFcpStartReceipt([donePremiere], samplePremiereTask({
    exportId: premiereRow.id,
    requestId: premiereRow.requestId,
    awaitingCompletion: true,
  }));
  assert.equal(mergedReceipt.length, 1);
  assert.equal(mergedReceipt[0]?.result?.bundleName, '夜景剪辑 Premiere');

  const toastHtml = rendered.renderToast({task: donePremiere});
  assert.match(toastHtml, /data-task-kind="premiere-export"/);
  assert.match(toastHtml, /已导出到 Premiere Pro 文件夹/);
  assert.match(toastHtml, /在 Finder 中显示/);

  const entries = rendered.renderTaskCenterEntries([restored[1]!, donePremiere]);
  assert.equal(entries[0]?.key, `fcpxml-export:${fcpRow.id}`);
  assert.equal(entries[0]?.group, '导出到 Final Cut Pro');
  assert.match(entries[0]!.html, /夜景 FCP\.fcpxmld/);
  assert.equal(entries[1]?.key, `premiere-export:${premiereRow.id}`);
  assert.equal(entries[1]?.group, '导出到 Premiere Pro');
  assert.match(entries[1]!.html, /data-task-kind="premiere-export"/);
  assert.match(entries[1]!.html, /夜景剪辑 Premiere/);

  const failedPremiere = samplePremiereTask({
    exportId: 'exp_pr_fail',
    status: 'failed',
    error: {code: 'NOT_WRITABLE'},
  });
  const overview = rendered.overviewItems([restored[1]!, restored[0]!, donePremiere, failedPremiere]);
  assert.deepEqual(overview.map(item => [item.id, item.phase]), [
    [`fcpxml-export:${fcpRow.id}`, 'active'],
    [`premiere-export:${premiereRow.id}`, 'active'],
    ['premiere-export:exp_pr_fail', 'attention'],
  ]);
});

test('App.tsx and TaskCenter.tsx wire Premiere menu entries below FCP, RPC operations, bridge gating, and task ID stripping', () => {
  const app = read('apps/web/src/App.tsx');
  const taskCenter = read('apps/web/src/TaskCenter.tsx');

  // Editing export split-button menu order (24-06): video -> FCP -> Premiere -> history
  const exportMenuStart = app.indexOf('data-testid="export-dropdown-menu"');
  const exportMenu = app.slice(exportMenuStart, app.indexOf('</DropdownMenuContent>', exportMenuStart));
  assert.ok(exportMenu.indexOf('export-menu-fcp') > exportMenu.indexOf('export-menu-video'));
  assert.ok(exportMenu.indexOf('export-menu-premiere') > exportMenu.indexOf('export-menu-fcp'));
  assert.ok(exportMenu.indexOf('export-menu-history') > exportMenu.indexOf('export-menu-premiere'));
  assert.match(exportMenu, /\{premiereExportAvailable && <DropdownMenuItem data-testid="export-menu-premiere"/);

  // Project menu order (24-06b): export storyboard -> FCP -> Premiere -> new project
  const projectMenuStart = app.indexOf('<DropdownMenuContent align="start" className="workbench-project-menu">');
  const projectMenu = app.slice(projectMenuStart, app.indexOf('</DropdownMenuContent>', projectMenuStart));
  assert.ok(projectMenu.indexOf('project-menu-fcp-export') > projectMenu.indexOf('export-button'));
  assert.ok(projectMenu.indexOf('project-menu-premiere-export') > projectMenu.indexOf('project-menu-fcp-export'));
  assert.ok(projectMenu.indexOf('project-menu-premiere-export') < projectMenu.indexOf('new-project-menu'));
  assert.match(projectMenu, /\{premiereExportAvailable && <DropdownMenuItem data-testid="project-menu-premiere-export"/);

  // Bridge gating, RPC operations, and native open/installed calls
  assert.match(app, /premiereExportBridge && data\.projectFormatVersion === 5/);
  assert.match(app, /rpc\('export\.premiere\.preview'/);
  assert.match(app, /rpc\('export\.premiere\.start'/);
  assert.match(app, /rpc\('export\.premiere\.get'/);
  assert.match(app, /rpc\('export\.premiere\.cancel'/);
  assert.match(app, /premiereExportPreviewOutputSchema\.safeParse/);
  assert.match(app, /readPremiereExportBridge\(\)\?\.premiereInstalled\(\)/);
  assert.match(app, /bridge\.openInPremiere\(/);

  // TaskCenter strips premiere-export: prefix when extracting selectedId
  assert.match(taskCenter, /fcpxml-export\|premiere-export/);
});
