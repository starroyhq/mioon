import type { OutsideProjectLocation } from '../../../packages/contracts/src/media-reference.ts';
import type { ProjectPackResult, ProjectRestorePreview, ProjectVersionSummary } from '../../../packages/contracts/src/project-versions.ts';
import { message } from '../../../packages/i18n/src/index.ts';
import type { ProjectOpenFailure } from '../../../packages/contracts/src/project-file.ts';
import type { ProjectInboxItem, RecentProject } from '../../../packages/contracts/src/project-registry.ts';

/** Sample data for the project file screens (U1), in K0 contract shapes and
 * after the examples in the 12-xx previews. Fixed clock and home directory, so
 * every render gives the same text. Covers are generated SVG, no binaries. */
export const NOW = new Date('2026-10-21T14:40:00+08:00');
export const HOME = '/Users/mioon';

function svg(width: number, height: number, body: string): string {
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width * 4}" height="${height * 4}">${body}</svg>`)}`;
}
export const COVERS = {
  ui: svg(90, 160, '<defs><radialGradient id="g" cx="50%" cy="50%" r="70%"><stop offset="0" stop-color="#1d5355"/><stop offset="1" stop-color="#0b2427"/></radialGradient></defs><rect width="90" height="160" fill="url(#g)"/><ellipse cx="45" cy="80" rx="40" ry="92" fill="none" stroke="#5a8f7e" stroke-width=".6"/><ellipse cx="45" cy="80" rx="12" ry="22" fill="#e3efb1"/>'),
  city: svg(160, 90, '<defs><radialGradient id="g" cx="62%" cy="45%" r="75%"><stop offset="0" stop-color="#4a4470"/><stop offset="1" stop-color="#1f2140"/></radialGradient></defs><rect width="160" height="90" fill="url(#g)"/><circle cx="104" cy="40" r="72" fill="none" stroke="#8a6a62" stroke-width="1.6"/><circle cx="102" cy="41" r="23" fill="#eeb086"/>'),
  product: svg(90, 160, '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5a2a17"/><stop offset=".6" stop-color="#b9774a"/><stop offset="1" stop-color="#e8c295"/></linearGradient></defs><rect width="90" height="160" fill="url(#g)"/><ellipse cx="66" cy="50" rx="12" ry="26" fill="#f7e9cc"/>'),
  season: svg(160, 90, '<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#232842"/><stop offset=".55" stop-color="#3b3a52"/><stop offset="1" stop-color="#8a6a4f"/></linearGradient><radialGradient id="h" cx="70%" cy="78%" r="35%"><stop offset="0" stop-color="#c49a72" stop-opacity=".8"/><stop offset="1" stop-color="#c49a72" stop-opacity="0"/></radialGradient></defs><rect width="160" height="90" fill="url(#g)"/><rect width="160" height="90" fill="url(#h)"/>'),
  intro: svg(90, 90, '<defs><radialGradient id="g"><stop offset="0" stop-color="#e5f1bd"/><stop offset="1" stop-color="#c3db8f"/></radialGradient></defs><rect width="90" height="90" fill="url(#g)"/><ellipse cx="45" cy="42" rx="10" ry="18" fill="#22392a"/>'),
  interview: svg(160, 90, '<defs><radialGradient id="g" cx="50%" cy="50%" r="70%"><stop offset="0" stop-color="#40546f"/><stop offset="1" stop-color="#2c3c52"/></radialGradient></defs><rect width="160" height="90" fill="url(#g)"/><circle cx="80" cy="45" r="15" fill="none" stroke="#7a7f86" stroke-width="5"/><circle cx="80" cy="45" r="12" fill="#866a12"/>'),
} as const;

export const PROJECT_IDS = {
  ui: '6c0b7f0e-2a1d-4c3b-9e8f-1a2b3c4d5e01', city: '6c0b7f0e-2a1d-4c3b-9e8f-1a2b3c4d5e02', product: '6c0b7f0e-2a1d-4c3b-9e8f-1a2b3c4d5e03',
  season: '6c0b7f0e-2a1d-4c3b-9e8f-1a2b3c4d5e04', intro: '6c0b7f0e-2a1d-4c3b-9e8f-1a2b3c4d5e05', interview: '6c0b7f0e-2a1d-4c3b-9e8f-1a2b3c4d5e06',
  client: '6c0b7f0e-2a1d-4c3b-9e8f-1a2b3c4d5e07',
} as const;
type Key = keyof typeof COVERS;
export const PROJECT_FILES: Readonly<Record<Key, string>> = {
  ui: `${HOME}/Movies/Mioon/UI 走查项目/UI 走查项目.mioon`,
  city: `${HOME}/Movies/Mioon/城市夜景短片/城市夜景短片.mioon`,
  product: '/Volumes/素材盘/产品演示/产品演示 · 竖屏.mioon',
  season: `${HOME}/Movies/Mioon/季节变换延时/季节变换延时.mioon`,
  intro: `${HOME}/Desktop/片头动画测试/片头动画测试.mioon`,
  interview: '/Volumes/外接硬盘/访谈剪辑样片/访谈剪辑样片.mioon',
};
const sizes = { portrait: [1080, 1920, 'portrait_1080'], landscape: [1920, 1080, 'landscape_1080'], square: [1080, 1080, 'square_1080'] } as const;
function recent(key: Key, name: string, format: keyof typeof sizes, seconds: number, lastOpenedAt: string, updatedAt: string, index: number): RecentProject {
  const [width, height, presetId] = sizes[format];
  return {
    projectId: PROJECT_IDS[key], projectFile: PROJECT_FILES[key], fileIdentity: { dev: '16777232', ino: String(48_120_000 + index) }, name, lastOpenedAt,
    summary: { description: '', revision: 12 + index, createdAt: '2026-09-01T02:00:00.000Z', updatedAt, fps: 30, width, height, presetId, shotCount: 4 + index, durationFrames: seconds * 30,
      cover: { assetId: `a0c0ffee-0000-4000-8000-00000000000${index}`, mimeType: 'image/png' } },
  };
}
/** The six cards of 12-01, in "recently opened" order. */
export const RECENT_PROJECTS: readonly RecentProject[] = [
  recent('ui', 'UI 走查项目', 'portrait', 42, '2026-10-21T06:32:00.000Z', '2026-10-21T06:30:00.000Z', 1),
  recent('city', '城市夜景短片', 'landscape', 84, '2026-10-20T13:08:00.000Z', '2026-10-20T13:05:00.000Z', 2),
  recent('product', '产品演示 · 竖屏', 'portrait', 30, '2026-10-14T02:15:00.000Z', '2026-10-14T02:10:00.000Z', 3),
  recent('season', '季节变换延时', 'landscape', 125, '2026-10-09T03:20:00.000Z', '2026-10-09T03:18:00.000Z', 4),
  recent('intro', '片头动画测试', 'square', 12, '2026-09-28T07:45:00.000Z', '2026-09-28T07:40:00.000Z', 5),
  recent('interview', '访谈剪辑样片', 'landscape', 196, '2026-09-12T02:00:00.000Z', '2026-09-12T01:58:00.000Z', 6),
];
export const COVER_URLS: Readonly<Record<string, string>> = Object.fromEntries((Object.keys(COVERS) as Key[]).map(key => [PROJECT_IDS[key], COVERS[key]]));

/** Two generated results waiting for the missing project. */
export const INBOX_ITEMS: readonly ProjectInboxItem[] = [1, 2].map(index => ({
  id: `b0c0ffee-0000-4000-8000-00000000000${index}`, projectId: PROJECT_IDS.interview, taskKind: 'job', taskId: `c0c0ffee-0000-4000-8000-00000000000${index}`,
  receivedAt: `2026-10-21T0${index}:10:00.000Z`, stagedMedia: [{ fileName: `result-${index}.mp4`, mimeType: 'video/mp4', sizeBytes: 18_400_000 * index, sha256: String(index).repeat(64) }],
}));

/** Media thumbnails for the 12-04 cards: a gradient and an optional disc. */
function thumb(from: string, to: string, disc?: { readonly x: number; readonly y: number; readonly r: number; readonly fill: string }): string {
  return svg(160, 90, `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><rect width="160" height="90" fill="url(#g)"/>${disc ? `<circle cx="${disc.x}" cy="${disc.y}" r="${disc.r}" fill="${disc.fill}"/>` : ''}`);
}
export const MEDIA_THUMBS = {
  a: thumb('#15383d', '#0d2226', { x: 80, y: 45, r: 20, fill: '#d9ecb4' }),
  c: thumb('#2a2f52', '#b8735a'),
  d: thumb('#9fc6e8', '#6d9fd0', { x: 80, y: 42, r: 18, fill: '#f6c424' }),
  f: thumb('#43302e', '#c9875f', { x: 108, y: 34, r: 22, fill: '#f3dcc0' }),
  e: thumb('#5d7590', '#2f3f52'),
  b: thumb('#2c2a4f', '#1c1c36', { x: 92, y: 45, r: 22, fill: '#eeb086' }),
  g: thumb('#3b3d2a', '#1d1f15', { x: 60, y: 50, r: 16, fill: '#c7d39a' }),
  h: thumb('#4a2e3f', '#22151d', { x: 100, y: 40, r: 14, fill: '#e59fb5' }),
} as const;

/** 12-05: scene-c.mp4 was located by hand, which found scene-f.mp4; scene-d.mp4 changed in place. */
export const RELINK_ROWS = [
  { assetId: 'd0c0ffee-0000-4000-8000-00000000000c', name: 'scene-c.mp4', mediaKind: 'video', from: '/Volumes/素材盘/拍摄/0912/scene-c.mp4', to: '/Volumes/素材盘-备份/拍摄/0912/scene-c.mp4', outcome: 'picked' },
  { assetId: 'd0c0ffee-0000-4000-8000-00000000000f', name: 'scene-f.mp4', mediaKind: 'video', from: '/Volumes/素材盘/拍摄/0912/scene-f.mp4', to: '/Volumes/素材盘-备份/拍摄/0912/scene-f.mp4', outcome: 'auto' },
  { assetId: 'd0c0ffee-0000-4000-8000-00000000000d', name: 'scene-d.mp4', mediaKind: 'video', from: `${HOME}/Movies/Mioon/UI 走查项目/素材/scene-d.mp4`, to: `${HOME}/Movies/Mioon/UI 走查项目/素材/scene-d.mp4`, outcome: 'changed' },
] as const;
export const RELINK_MISSING_ROW = { assetId: 'd0c0ffee-0000-4000-8000-000000000010', name: 'voice-over.wav', mediaKind: 'audio', from: '/Volumes/素材盘/录音/voice-over.wav', to: null, outcome: 'missing' } as const;

/** 12-06: three folders outside 访谈剪辑样片's project folder, one of them not on this computer. */
export const OUTSIDE_LOCATIONS: readonly OutsideProjectLocation[] = [
  { directory: '/Volumes/素材盘/访谈/0912', volume: '素材盘', assetCount: 12, available: true },
  { directory: `${HOME}/Music/配乐`, volume: null, assetCount: 3, available: true },
  { directory: '/Users/lin/Desktop/temp', volume: null, assetCount: 1, available: false },
];

/** 12-08: the versions of UI 走查项目, newest first, as in the preview. */
function version(index: number, trigger: ProjectVersionSummary['trigger'], createdAt: string, name: string | null = null): ProjectVersionSummary {
  const id = `e0c0ffee-0000-4000-8000-0000000000${String(index).padStart(2, '0')}`;
  return { id, projectId: PROJECT_IDS.ui, trigger, name, mioRunId: trigger === 'mio-turn' ? `f0c0ffee-0000-4000-8000-0000000000${String(index).padStart(2, '0')}` : null, contentSequence: 400 - index * 20, createdAt };
}
export const VERSIONS = [
  { summary: version(1, 'mio-turn', '2026-10-21T06:20:00.000Z'), mioTurn: 3, conversationTitle: '把雨夜段落剪紧一点' },
  { summary: version(2, 'manual', '2026-10-21T05:05:00.000Z', '定稿前') },
  { summary: version(3, 'mio-turn', '2026-10-21T03:40:00.000Z'), mioTurn: 2, conversationTitle: '把雨夜段落剪紧一点' },
  { summary: version(4, 'daily-open', '2026-10-21T01:12:00.000Z') },
  { summary: version(5, 'manual', '2026-10-20T10:30:00.000Z', '初剪完成') },
  { summary: version(6, 'mio-turn', '2026-10-20T08:02:00.000Z'), mioTurn: 1, conversationTitle: '粗剪' },
] as const;
/** The other triggers, on earlier days. */
export const OLDER_VERSIONS = [
  { summary: version(7, 'restore', '2026-10-20T02:00:00.000Z') },
  { summary: version(8, 'bulk-change', '2026-10-14T07:30:00.000Z') },
  { summary: version(9, 'daily-open', '2026-10-14T01:05:00.000Z') },
  { summary: version(10, 'manual', '2026-10-12T09:00:00.000Z') },
  { summary: version(11, 'mio-turn', '2025-12-30T09:00:00.000Z') },
] as const;
/** 12-08: Mio round 3 compared with current. */
export const COMPARISON = [
  { area: 'timeline', details: [message('projectFile.versions.diff.clipsTrimmed', { count: 5 }), message('projectFile.versions.diff.clipsRemoved', { count: 1 })] },
  { area: 'shots', details: [message('projectFile.versions.diff.shotsDescription', { count: 2 })] },
  { area: 'subtitles', details: [message('projectFile.versions.diff.subtitlesAdded', { count: 3 })] },
] as const;
/** 12-09: what restoring Mio round 3 takes back. */
export const RESTORE_PREVIEW: ProjectRestorePreview = {
  version: VERSIONS[0].summary,
  manualChanges: [
    { kind: 'timeline_clip', id: 'clip-scene-b', name: 'scene-b.mp4', fields: [{ property: 'durationFrames', before: 210, after: 180 }] },
    { kind: 'timeline_subtitle', id: 'subtitle-2', name: '镜头缓慢推进', fields: [{ property: 'subtitleText', before: '镜头推进', after: '镜头缓慢推进' }] },
  ],
  manualChangeCount: 2, supersededMioChanges: 3,
};
export const RESTORE_PREVIEW_MORE: ProjectRestorePreview = {
  ...RESTORE_PREVIEW,
  manualChanges: [...RESTORE_PREVIEW.manualChanges, { kind: 'shot', id: 'shot-4', name: '雨夜街道', fields: [{ property: 'description', before: '街道', after: '雨后的城市街道' }, { property: 'durationSeconds', before: 4, after: 6 }] }],
  manualChangeCount: 7,
};

/** 12-10 and 12-11: packing UI 走查项目 onto the desktop; two media files are missing. */
export const PACK_FOLDER = `${HOME}/Desktop/UI 走查项目（打包）`;
export const PACK_MANIFEST = {
  destination: PACK_FOLDER, projectFile: { name: 'UI 走查项目.mioon', sizeBytes: 2_100_000 }, assets: { count: 21, sizeBytes: 4_100_000_000, outsideCount: 6 }, rulesFile: true, missing: 2,
} as const;
export const PACK_RESULT: ProjectPackResult = {
  directory: PACK_FOLDER, projectFile: `${PACK_FOLDER}/UI 走查项目.mioon`, rulesFileCopied: true, copiedAssets: 21, copiedBytes: 4_100_000_000,
  missingAssetIds: ['d0c0ffee-0000-4000-8000-00000000000c', 'd0c0ffee-0000-4000-8000-00000000000f'],
};

/** 12-12: the AGENTS.md of UI 走查项目. */
export const RULES_PATH = `${HOME}/Movies/Mioon/UI 走查项目/AGENTS.md`;
export const RULES_TEXT = [
  '画幅与时长', '9:16 竖屏，1080×1920，30fps。每集 90 秒，约 12 个镜头。', '',
  '风格', '冷色雨夜，街面积水和玻璃上有霓虹反光。手持感镜头，轻微晃动，少用固定机位。主光来自路灯和招牌，整体偏冷，人物肤色保留暖调。', '',
  '角色', '林夏：28 岁，短发，灰色风衣，左手戴银色手表，说话简短。', '周屿：30 岁，黑色卫衣，总是右手持伞，习惯站在林夏左侧。', '',
  '禁忌', '不出现真实品牌标识。招牌、屏幕和包装上的文字一律用虚构名称。', '',
  '做事方式', '生成前先给我看提示词，确认后再提交。字幕每行不超过 16 个字。',
].join('\n');
/** 12-14: Mio adds two lines under 做事方式. */
export const RULES_CHANGE = { section: '做事方式', lines: [{ kind: 'add', text: '生成前先给我看提示词，确认后再提交。' }, { kind: 'add', text: '字幕每行不超过 16 个字。' }] } as const;
export const RULES_CHANGE_MIXED = { section: '风格', lines: [{ kind: 'remove', text: '手持感镜头，轻微晃动，少用固定机位。' }, { kind: 'add', text: '多用固定机位，转场前停留半秒。' }] } as const;

export const OPEN_FAILURES = {
  missing: { code: 'PROJECT_MISSING', projectFile: PROJECT_FILES.interview, projectId: PROJECT_IDS.interview },
  locked: { code: 'PROJECT_LOCKED', projectFile: PROJECT_FILES.city, projectId: PROJECT_IDS.city },
  newer: { code: 'PROJECT_FORMAT_NEWER', projectFile: `${HOME}/Downloads/客户样片/客户样片.mioon`, projectId: PROJECT_IDS.client, database: 'project', formatVersion: 2, supportedFormatVersion: 1 },
  newerHistory: { code: 'PROJECT_FORMAT_NEWER', projectFile: `${HOME}/Downloads/客户样片/客户样片.mioon`, projectId: PROJECT_IDS.client, database: 'history', formatVersion: 2, supportedFormatVersion: 1 },
  corrupt: { code: 'PROJECT_INVALID', projectFile: PROJECT_FILES.season, projectId: PROJECT_IDS.season, reason: 'corrupt' },
  readOnly: { code: 'PROJECT_INVALID', projectFile: PROJECT_FILES.product, projectId: PROJECT_IDS.product, reason: 'read-only' },
} as const satisfies Record<string, ProjectOpenFailure>;
