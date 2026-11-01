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

export const OPEN_FAILURES = {
  missing: { code: 'PROJECT_MISSING', projectFile: PROJECT_FILES.interview, projectId: PROJECT_IDS.interview },
  locked: { code: 'PROJECT_LOCKED', projectFile: PROJECT_FILES.city, projectId: PROJECT_IDS.city },
  newer: { code: 'PROJECT_FORMAT_NEWER', projectFile: `${HOME}/Downloads/客户样片/客户样片.mioon`, projectId: PROJECT_IDS.client, database: 'project', formatVersion: 2, supportedFormatVersion: 1 },
  newerHistory: { code: 'PROJECT_FORMAT_NEWER', projectFile: `${HOME}/Downloads/客户样片/客户样片.mioon`, projectId: PROJECT_IDS.client, database: 'history', formatVersion: 2, supportedFormatVersion: 1 },
  corrupt: { code: 'PROJECT_INVALID', projectFile: PROJECT_FILES.season, projectId: PROJECT_IDS.season, reason: 'corrupt' },
  readOnly: { code: 'PROJECT_INVALID', projectFile: PROJECT_FILES.product, projectId: PROJECT_IDS.product, reason: 'read-only' },
} as const satisfies Record<string, ProjectOpenFailure>;
