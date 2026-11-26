import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {
  FCP_APPROXIMATION_ITEM_CODES,
  FCP_EXPORT_ERROR_CODES,
  FCP_EXPORT_OPERATIONS,
  FCP_EXPORT_STATUSES,
  FCP_EXPORT_TASK_KIND,
  FCP_ITEM_CODES,
  FCP_MISSING_ITEM_CODES,
  fcpExportCancelInputSchema,
  fcpExportCancelOutputSchema,
  fcpExportGetInputSchema,
  fcpExportGetOutputSchema,
  fcpExportPreviewInputSchema,
  fcpExportPreviewOutputSchema,
  fcpExportStartInputSchema,
  fcpExportStartOutputSchema,
} from '../packages/contracts/src/fcp-export.ts';
import type {FcpClipRef, FcpExportPreviewOutput, FcpItem} from '../packages/contracts/src/fcp-export.ts';
import {
  FCP_EXPORT_NATIVE_CHANNEL,
  FCP_EXPORT_NATIVE_GLOBAL,
  fcpExportNativeChosenDestinationSchema,
  fcpExportNativeErrorSchema,
  fcpExportNativeIdentitySchema,
} from '../packages/contracts/src/fcp-export-native.ts';
import {rpcPathFor} from '../packages/contracts/src/project-addressing.ts';
import {LOCALES, renderMessage} from '../packages/i18n/src/index.ts';
import {isFcpExportChosenDestination, readFcpExportBridge} from '../apps/web/src/fcp-export-bridge.ts';
import {
  applyFcpTaskUpdate,
  fcpBundleFileName,
  fcpErrorMessage,
  fcpItemAffectedText,
  fcpItemLabelMessage,
  fcpItemTooltipText,
  fcpProgressPercent,
  fcpTaskStatusMessage,
  formatFcpBytes,
  formatFcpDuration,
  formatFcpFps,
} from '../apps/web/src/fcp-export-state.ts';
import type {FcpExportTaskRecord} from '../apps/web/src/fcp-export-state.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (file: string) => readFileSync(join(root, file), 'utf8');

const clip = (id: string, name: string, trackLabel?: string): FcpClipRef =>
  trackLabel ? {id, name, trackLabel} : {id, name};

interface BuiltFcpUi {
  renderDialog(props: Record<string, unknown>, locale?: string): string;
  renderToast(props: Record<string, unknown>, locale?: string): string;
  renderTaskCenterEntry(task: FcpExportTaskRecord, locale?: string): {
    key: string;
    label: string;
    status: string;
    active: boolean;
    warning: boolean;
    group: string;
    html: string;
  };
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

let built: BuiltFcpUi | null = null;
async function ui(): Promise<BuiltFcpUi> {
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

    export const renderTaskCenterEntry = (task, locale = 'zh-Hans') => {
      const helpers = makeT(locale);
      const [entry] = fcpExportTaskCenterEntries([task], {
        ...helpers,
        onOpen: noop,
        onCancel: noop,
        onReveal: noop,
        onRetry: noop,
      });
      return {
        key: entry.key,
        label: entry.label,
        status: entry.status,
        active: entry.active,
        warning: entry.warning,
        group: entry.group,
        html: renderToStaticMarkup(entry.detail),
      };
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
  built = mod.exports as BuiltFcpUi;
  return built;
}

const samplePreview: FcpExportPreviewOutput = {
  timeline: {width: 1080, height: 1920, fps: 30, durationFrames: 720, clipCount: 8},
  defaultName: '城市夜景短片',
  projectDestination: {displayPath: '~/影片/城市夜景短片/导出'},
  mediaFiles: 6,
  mediaBytes: Math.round(1.2 * 1024 * 1024 * 1024),
  missing: [
    {code: 'LUT', clips: [clip('c1', 'scene-a'), clip('c3', 'scene-c')]},
    {code: 'PLACEHOLDER', clips: [clip('c4', '镜头 04')]},
  ],
  approximations: [
    {
      code: 'TRANSITION',
      clips: [clip('t1', 'scene-a'), clip('t2', 'scene-b'), clip('t3', 'scene-c')],
      values: {from: '推进', to: '叠化'},
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
      code: 'SUBTITLE_STYLE',
      clips: Array.from({length: 12}, (_, index) => clip(`sub-${index + 1}`, `字幕 ${index + 1}`)),
    },
    {
      code: 'ANCHOR',
      clips: [clip('o1', 'overlay-1', 'V2'), clip('o2', 'overlay-2', 'V2'), clip('o3', 'overlay-3', 'V2')],
    },
    {
      code: 'MUTE',
      clips: [clip('c1', 'scene-a')],
    },
  ],
};

function sampleTask(overrides: Partial<FcpExportTaskRecord> = {}): FcpExportTaskRecord {
  return {
    exportId: 'exp_fcp_01',
    projectId: 'proj_0123456789abcdef',
    kind: FCP_EXPORT_TASK_KIND,
    name: '城市夜景短片',
    copyMedia: true,
    destination: {kind: 'project'},
    displayPath: '~/影片/城市夜景短片/导出',
    status: 'running',
    progress: {
      files: 3,
      totalFiles: 6,
      bytes: 420 * 1024 * 1024,
      totalBytes: Math.round(1.2 * 1024 * 1024 * 1024),
    },
    missing: samplePreview.missing,
    approximations: samplePreview.approximations,
    createdAt: '2026-11-26T12:00:00.000Z',
    ...overrides,
  };
}

test('FCP export contracts validate all 4 RPC operations, task kind, native bridge schemas, and project RPC addressing', () => {
  assert.deepEqual(FCP_EXPORT_OPERATIONS, [
    'export.fcpxml.preview',
    'export.fcpxml.start',
    'export.fcpxml.get',
    'export.fcpxml.cancel',
  ]);
  assert.equal(FCP_EXPORT_TASK_KIND, 'fcpxml-export');
  assert.equal(FCP_EXPORT_NATIVE_GLOBAL, '__mioonFcpExport');
  assert.equal(FCP_EXPORT_NATIVE_CHANNEL, 'mioon:fcp-export');
  assert.equal(FCP_ITEM_CODES.length, 12);
  assert.equal(FCP_MISSING_ITEM_CODES.length, 4);
  assert.equal(FCP_APPROXIMATION_ITEM_CODES.length, 8);
  assert.deepEqual(FCP_EXPORT_STATUSES, ['running', 'done', 'failed', 'cancelled']);
  assert.deepEqual(FCP_EXPORT_ERROR_CODES, ['DISK_FULL', 'NOT_WRITABLE', 'MEDIA_UNREADABLE', 'EXPORT_FAILED']);

  const canonicalProjectId = '11111111-1111-4111-8111-111111111111';
  for (const op of FCP_EXPORT_OPERATIONS) {
    assert.equal(rpcPathFor(op, {projectId: canonicalProjectId}), `/api/projects/${canonicalProjectId}/rpc`);
  }

  assert.equal(fcpExportPreviewInputSchema.parse({projectId: canonicalProjectId, copyMedia: true}).copyMedia, true);
  assert.equal(fcpExportPreviewOutputSchema.parse(samplePreview).defaultName, '城市夜景短片');

  assert.throws(() => fcpExportPreviewOutputSchema.parse({
    ...samplePreview,
    missing: [{code: 'MUTE', clips: [clip('c1', 'scene-a')]}],
  }), 'approximation code must not be allowed in missing');
  assert.throws(() => fcpExportPreviewOutputSchema.parse({
    ...samplePreview,
    approximations: [{code: 'LUT', clips: [clip('c1', 'scene-a')]}],
  }), 'missing code must not be allowed in approximations');

  assert.equal(fcpExportStartInputSchema.parse({
    projectId: canonicalProjectId,
    requestId: 'req_1',
    name: '城市夜景短片',
    copyMedia: true,
    destination: {kind: 'project'},
  }).destination.kind, 'project');
  assert.equal(fcpExportStartInputSchema.parse({
    projectId: canonicalProjectId,
    requestId: 'req_2',
    name: '城市夜景短片',
    copyMedia: false,
    destination: {kind: 'chosen', token: 'tok_abc'},
  }).destination.kind, 'chosen');
  assert.throws(() => fcpExportStartInputSchema.parse({
    projectId: canonicalProjectId,
    requestId: 'req_3',
    name: '',
    copyMedia: true,
    destination: {kind: 'project'},
  }));
  assert.equal(fcpExportStartOutputSchema.parse({exportId: 'exp_1'}).exportId, 'exp_1');

  assert.equal(fcpExportGetInputSchema.parse({projectId: canonicalProjectId, exportId: 'exp_1'}).exportId, 'exp_1');
  assert.equal(fcpExportGetOutputSchema.parse({
    status: 'done',
    progress: {files: 6, totalFiles: 6, bytes: 1200, totalBytes: 1200},
    result: {bundleName: '城市夜景短片.fcpxmld', displayPath: '~/影片/城市夜景短片/导出', bytes: 1200, missingCount: 2},
  }).result?.missingCount, 2);
  assert.equal(fcpExportGetOutputSchema.parse({
    status: 'failed',
    progress: {files: 2, totalFiles: 6, bytes: 300, totalBytes: 1200},
    error: {code: 'DISK_FULL', values: {shortBytes: 300 * 1024 * 1024}},
  }).error?.code, 'DISK_FULL');

  assert.equal(fcpExportCancelInputSchema.parse({projectId: canonicalProjectId, exportId: 'exp_1'}).exportId, 'exp_1');
  assert.equal(fcpExportCancelOutputSchema.parse({status: 'cancelled'}).status, 'cancelled');
  assert.equal(fcpExportNativeChosenDestinationSchema.parse({token: 'tok_1', displayPath: '~/Desktop'}).token, 'tok_1');
  assert.equal(fcpExportNativeIdentitySchema.parse({projectId: canonicalProjectId, exportId: 'exp_1'}).exportId, 'exp_1');
  assert.equal(fcpExportNativeErrorSchema.parse({code: 'CANCELLED', status: 400}).code, 'CANCELLED');
});

test('desktop bridge reader hides FCP export when bridge is absent or malformed and accepts complete bridge', () => {
  assert.equal(readFcpExportBridge({}), null);
  assert.equal(readFcpExportBridge({[FCP_EXPORT_NATIVE_GLOBAL]: null}), null);
  assert.equal(readFcpExportBridge({[FCP_EXPORT_NATIVE_GLOBAL]: {chooseDestination: () => null}}), null);

  const valid = {
    chooseDestination: async () => ({token: 't1', displayPath: '~/Desktop'}),
    reveal: async () => true,
    openInFinalCut: async () => true,
    finalCutInstalled: async () => true,
  };
  assert.equal(readFcpExportBridge({[FCP_EXPORT_NATIVE_GLOBAL]: valid}), valid);
  assert.equal(isFcpExportChosenDestination({token: 't1', displayPath: '~/Desktop'}), true);
  assert.equal(isFcpExportChosenDestination(null), false);
  assert.equal(isFcpExportChosenDestination({token: '', displayPath: '~/Desktop'}), false);
});

test('formatting helpers and all 12 FcpItemCodes + 4 error codes render plain-language text in all 4 locales', () => {
  assert.equal(formatFcpBytes(0), '0 B');
  assert.equal(formatFcpBytes(512), '512 B');
  assert.equal(formatFcpBytes(420 * 1024 * 1024), '420 MB');
  assert.equal(formatFcpBytes(Math.round(1.2 * 1024 * 1024 * 1024)), '1.2 GB');
  assert.equal(formatFcpDuration(720, 30), '00:00:24');
  assert.equal(formatFcpDuration(3661 * 30, 30), '01:01:01');
  assert.equal(formatFcpFps(30), '30');
  assert.equal(formatFcpFps(29.97), '29.97');
  assert.equal(fcpBundleFileName('城市夜景短片'), '城市夜景短片.fcpxmld');
  assert.equal(fcpBundleFileName('城市夜景短片.fcpxmld'), '城市夜景短片.fcpxmld');
  assert.equal(fcpProgressPercent({files: 3, totalFiles: 6, bytes: 420, totalBytes: 1200}), 35);
  assert.equal(fcpProgressPercent({files: 3, totalFiles: 6, bytes: 0, totalBytes: 0}), 50);

  const items: FcpItem[] = [
    {code: 'LUT', clips: [clip('c1', 'scene-a'), clip('c3', 'scene-c')]},
    {code: 'PLACEHOLDER', clips: [clip('c4', '镜头 04')]},
    {code: 'MEDIA_MISSING', clips: [clip('c5', 'missing.mp4')]},
    {code: 'UNSUPPORTED_MEDIA', clips: [clip('c6', 'raw.hevc')]},
    {code: 'TRANSITION', clips: [clip('t1', 'a'), clip('t2', 'b'), clip('t3', 'c')], values: {from: '推进', to: '叠化'}},
    {code: 'VOLUME_KEYFRAMES', clips: [clip('a1', 'bgm-1', 'A1'), clip('a2', 'bgm-2', 'A1')]},
    {code: 'FADES', clips: [clip('f1', 'scene-b')]},
    {code: 'SUBTITLE_STYLE', clips: [clip('s1', '字幕 1'), clip('s2', '字幕 2')]},
    {code: 'ANCHOR', clips: [clip('o1', 'overlay-1', 'V2'), clip('o2', 'overlay-2', 'V2'), clip('o3', 'overlay-3', 'V2')]},
    {code: 'MUTE', clips: [clip('m1', 'scene-a')]},
    {code: 'SEPARATE_SOUND', clips: [clip('sep1', 'scene-d', 'A2')]},
    {code: 'TRANSFORM', clips: [clip('tr1', 'scene-e')]},
  ];
  assert.deepEqual(items.map(item => item.code).sort(), [...FCP_ITEM_CODES].sort());

  for (const locale of LOCALES) {
    for (const item of items) {
      const label = renderMessage(locale, fcpItemLabelMessage(item));
      assert.ok(label.length > 0 && !label.includes('fcpExport.') && !label.includes('{'), `${locale}:${item.code} => ${label}`);
      const affected = fcpItemAffectedText(item, locale);
      assert.ok(affected.length > 0 && !affected.includes('fcpExport.') && !affected.includes('{'), `${locale}:${item.code} affected => ${affected}`);
    }
    for (const error of [
      {code: 'DISK_FULL' as const, values: {shortBytes: 300 * 1024 * 1024}},
      {code: 'DISK_FULL' as const},
      {code: 'NOT_WRITABLE' as const},
      {code: 'MEDIA_UNREADABLE' as const, values: {file: 'scene-b.mp4'}},
      {code: 'MEDIA_UNREADABLE' as const},
      {code: 'EXPORT_FAILED' as const},
    ]) {
      const text = renderMessage(locale, fcpErrorMessage(error));
      assert.ok(text.length > 0 && !text.includes('fcpExport.') && !text.includes('{'), `${locale}:${error.code} => ${text}`);
    }
    for (const status of FCP_EXPORT_STATUSES) {
      const text = renderMessage(locale, fcpTaskStatusMessage(status));
      assert.ok(text.length > 0 && !text.includes('fcpExport.'), `${locale}:${status}`);
    }
  }

  // Exact Chinese plain-language checks matching 24-02, 24-04b, 24-05.
  assert.equal(renderMessage('zh-Hans', fcpItemLabelMessage(items[0]!)), 'LUT 调色');
  assert.equal(fcpItemAffectedText(items[0]!, 'zh-Hans'), 'scene-a、scene-c');
  assert.equal(renderMessage('zh-Hans', fcpItemLabelMessage(items[1]!)), '未生成的镜头');
  assert.equal(fcpItemAffectedText(items[1]!, 'zh-Hans'), '镜头 04 · 导出成空隙');
  assert.equal(renderMessage('zh-Hans', fcpItemLabelMessage(items[2]!)), '找不到的素材');
  assert.equal(renderMessage('zh-Hans', fcpItemLabelMessage(items[4]!)), '推进 → 叠化');
  assert.equal(fcpItemAffectedText(items[4]!, 'zh-Hans'), '3 处');
  assert.equal(renderMessage('zh-Hans', fcpItemLabelMessage(items[5]!)), '音量包络 → 关键帧');
  assert.equal(fcpItemAffectedText(items[5]!, 'zh-Hans'), 'A1 · 2 个片段');
  assert.equal(renderMessage('zh-Hans', fcpItemLabelMessage(items[7]!)), '字幕 → 字幕角色，样式不带');
  assert.equal(fcpItemAffectedText(items[7]!, 'zh-Hans'), '2 条');
  assert.equal(renderMessage('zh-Hans', fcpItemLabelMessage(items[8]!)), '挂靠 → 连接片段');
  assert.equal(fcpItemAffectedText(items[8]!, 'zh-Hans'), 'V2 · 3 个片段');
  assert.equal(renderMessage('zh-Hans', fcpItemLabelMessage(items[9]!)), '静音 → -96 dB');
  assert.equal(fcpItemAffectedText(items[9]!, 'zh-Hans'), '1 个片段');
  assert.equal(fcpItemTooltipText(items[0]!, 'zh-Hans'), 'scene-a、scene-c');
  assert.equal(
    renderMessage('zh-Hans', fcpErrorMessage({code: 'DISK_FULL', values: {shortBytes: 300 * 1024 * 1024}})),
    '磁盘空间不够，还差 300 MB。',
  );
  assert.equal(renderMessage('zh-Hans', fcpErrorMessage({code: 'NOT_WRITABLE'})), '这个位置没有写入权限。');
  assert.equal(
    renderMessage('zh-Hans', fcpErrorMessage({code: 'MEDIA_UNREADABLE', values: {file: 'scene-b.mp4'}})),
    '素材 scene-b.mp4 读不出来。',
  );
  assert.equal(renderMessage('zh-Hans', fcpErrorMessage({code: 'EXPORT_FAILED'})), '导出没有完成。');

  const updated = applyFcpTaskUpdate(sampleTask(), {
    status: 'done',
    progress: {files: 6, totalFiles: 6, bytes: samplePreview.mediaBytes, totalBytes: samplePreview.mediaBytes},
    result: {bundleName: '城市夜景短片.fcpxmld', displayPath: '~/影片/城市夜景短片/导出', bytes: samplePreview.mediaBytes, missingCount: 2},
  });
  assert.equal(updated.status, 'done');
  assert.equal(updated.result?.bundleName, '城市夜景短片.fcpxmld');
});

test('FcpExportDialog setup phase renders 24-02 layout, hides empty groups, and updates size when copyMedia changes', async () => {
  const rendered = await ui();
  const html = rendered.renderDialog({
    phase: 'setup',
    preview: samplePreview,
    name: samplePreview.defaultName,
    copyMedia: true,
    displayPath: samplePreview.projectDestination.displayPath,
  });
  assert.match(html, /导出到 Final Cut Pro/);
  assert.match(html, /1080×1920 · 30 fps · 00:00:24 · 8 个片段/);
  assert.match(html, /~\/影片\/城市夜景短片\/导出/);
  assert.match(html, /选择…/);
  assert.match(html, /\.fcpxmld/);
  assert.match(html, /复制素材到导出包/);
  assert.match(html, /1\.2 GB/);
  // Missing expanded by default, approximations collapsed by default
  assert.match(html, /data-testid="fcp-export-missing-group"/);
  assert.match(html, /data-testid="fcp-export-missing-list"/);
  assert.match(html, /LUT 调色/);
  assert.match(html, /scene-a、scene-c/);
  assert.match(html, /未生成的镜头/);
  assert.match(html, /镜头 04 · 导出成空隙/);
  assert.match(html, /data-testid="fcp-export-approximations-group"/);
  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /data-testid="fcp-export-approximations-list"/);

  // Empty groups must not render at all; unchecked copyMedia displays recalculated size
  const emptyGroupsHtml = rendered.renderDialog({
    phase: 'setup',
    preview: {...samplePreview, mediaFiles: 0, mediaBytes: 0, missing: [], approximations: []},
    name: samplePreview.defaultName,
    copyMedia: false,
    displayPath: samplePreview.projectDestination.displayPath,
  });
  assert.doesNotMatch(emptyGroupsHtml, /fcp-export-missing-group/);
  assert.doesNotMatch(emptyGroupsHtml, /fcp-export-approximations-group/);
  assert.match(emptyGroupsHtml, /data-testid="fcp-export-media-size"[^>]*>0 B</);
});

test('FcpExportDialog running, done (with/without Final Cut Pro), and failed phases match 24-03, 24-04, 24-04b', async () => {
  const rendered = await ui();
  const runningHtml = rendered.renderDialog({
    phase: 'running',
    task: sampleTask(),
    name: '城市夜景短片',
  });
  assert.match(runningHtml, /城市夜景短片\.fcpxmld/);
  assert.match(runningHtml, /正在复制素材 3 \/ 6/);
  assert.match(runningHtml, /420 MB \/ 1\.2 GB/);
  assert.match(runningHtml, /取消导出/);

  const doneTask = sampleTask({
    status: 'done',
    result: {
      bundleName: '城市夜景短片.fcpxmld',
      displayPath: '~/影片/城市夜景短片/导出',
      bytes: samplePreview.mediaBytes,
      missingCount: 2,
    },
  });
  const doneWithFcp = rendered.renderDialog({phase: 'done', task: doneTask, finalCutInstalled: true});
  assert.match(doneWithFcp, /城市夜景短片\.fcpxmld/);
  assert.match(doneWithFcp, /1\.2 GB · ~\/影片\/城市夜景短片\/导出/);
  assert.match(doneWithFcp, /2 项没带过去/);
  assert.match(doneWithFcp, /data-testid="fcp-export-reveal"[^>]*>在 Finder 中显示/);
  assert.match(doneWithFcp, /data-testid="fcp-export-open-fcp"[^>]*>用 Final Cut Pro 打开/);

  const doneWithoutFcp = rendered.renderDialog({phase: 'done', task: doneTask, finalCutInstalled: false});
  assert.match(doneWithoutFcp, /data-testid="fcp-export-reveal"[^>]*data-variant="primary"/);
  assert.doesNotMatch(doneWithoutFcp, /fcp-export-open-fcp/);

  const doneZeroMissing = rendered.renderDialog({
    phase: 'done',
    task: sampleTask({
      status: 'done',
      result: {bundleName: 'clean.fcpxmld', displayPath: '~/Movies', bytes: 1024, missingCount: 0},
    }),
    finalCutInstalled: true,
  });
  assert.doesNotMatch(doneZeroMissing, /fcp-export-done-missing-toggle/);

  const failedHtml = rendered.renderDialog({
    phase: 'failed',
    task: sampleTask({status: 'failed', error: {code: 'DISK_FULL', values: {shortBytes: 300 * 1024 * 1024}}}),
  });
  assert.match(failedHtml, /导出失败/);
  assert.match(failedHtml, /磁盘空间不够，还差 300 MB。/);
  assert.match(failedHtml, /换个位置…/);
  assert.match(failedHtml, /重试/);
});

test('background completion toast and Task Center / TaskPopover entries render fcpxml-export tasks accurately', async () => {
  const rendered = await ui();
  const running = sampleTask();
  const done = sampleTask({
    exportId: 'exp_fcp_02',
    status: 'done',
    result: {bundleName: '城市夜景短片.fcpxmld', displayPath: '~/影片/城市夜景短片/导出', bytes: 1024 * 1024, missingCount: 0},
  });
  const failed = sampleTask({
    exportId: 'exp_fcp_03',
    status: 'failed',
    error: {code: 'NOT_WRITABLE'},
  });

  assert.equal(rendered.renderToast({task: null}), '');
  assert.equal(rendered.renderToast({task: running}), '');
  const toastHtml = rendered.renderToast({task: done});
  assert.match(toastHtml, /已导出到 Final Cut Pro 包/);
  assert.match(toastHtml, /在 Finder 中显示/);

  const runningEntry = rendered.renderTaskCenterEntry(running);
  assert.equal(runningEntry.key, 'fcpxml-export:exp_fcp_01');
  assert.equal(runningEntry.label, '城市夜景短片');
  assert.equal(runningEntry.active, true);
  assert.equal(runningEntry.warning, false);
  assert.match(runningEntry.html, /data-task-kind="fcpxml-export"/);
  assert.match(runningEntry.html, /正在复制素材 3 \/ 6/);

  const failedEntry = rendered.renderTaskCenterEntry(failed);
  assert.equal(failedEntry.warning, true);
  assert.equal(failedEntry.active, false);
  assert.match(failedEntry.html, /这个位置没有写入权限。/);

  const overview = rendered.overviewItems([running, done, failed]);
  assert.deepEqual(overview.map(item => [item.id, item.phase]), [
    ['fcpxml-export:exp_fcp_01', 'active'],
    ['fcpxml-export:exp_fcp_03', 'attention'],
  ]);
  assert.equal(overview[0]?.progress, 34);
});

test('App.tsx wires editing split export button, project menu bridge gating, background polling, and TaskCenter', () => {
  const app = read('apps/web/src/App.tsx');
  assert.match(app, /data-testid="export-split-button"/);
  assert.match(app, /data-testid="export-menu-trigger"/);
  assert.match(app, /data-testid="export-menu-video"/);
  assert.match(app, /\{fcpExportBridge && <DropdownMenuItem data-testid="export-menu-fcp"/);
  assert.match(app, /data-testid="export-menu-history"/);

  const menuStart = app.indexOf('<DropdownMenuContent align="start" className="workbench-project-menu">');
  const menu = app.slice(menuStart, app.indexOf('</DropdownMenuContent>', menuStart));
  assert.ok(menu.indexOf('export-button') > 0);
  assert.ok(menu.indexOf('project-menu-fcp-export') > menu.indexOf('export-button'));
  assert.ok(menu.indexOf('project-menu-fcp-export') < menu.indexOf('new-project-menu'));
  assert.match(menu, /\{fcpExportBridge && <DropdownMenuItem data-testid="project-menu-fcp-export"/);

  // Closing the dialog only hides it; cancelling requires the explicit cancel button.
  assert.match(app, /onOpenChange=\{open => \{ if \(!open\) setFcpOpen\(false\); \}\}/);
  assert.match(app, /rpc\('export\.fcpxml\.preview'/);
  assert.match(app, /rpc\('export\.fcpxml\.start'/);
  assert.match(app, /rpc\('export\.fcpxml\.get'/);
  assert.match(app, /rpc\('export\.fcpxml\.cancel'/);
  assert.match(app, /window\.setInterval\(pollAll, 1000\)/);
  assert.match(app, /fcpExports=\{fcpExportTaskCenterEntries\(/);
});
