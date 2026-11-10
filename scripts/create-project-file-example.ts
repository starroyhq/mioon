/** Offline source generator for the shipped ordinary-project example.
 * It uses the real project kernel and owner-change builder, never an old
 * workspace, a provider, the network, or direct project-ID SQL rewrites. */
import {createHash} from 'node:crypto';
import {copyFileSync, constants, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, utimesSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {AppError} from '../packages/contracts/src/app-error.ts';
import {projectTemplateManifestSchema} from '../packages/contracts/src/project-template-manifest.ts';
import type {ProjectTemplateManifest} from '../packages/contracts/src/project-template-manifest.ts';
import {createProjectFile} from '../packages/business/src/project-file/connection.ts';
import {copyProjectToNewFile} from '../packages/business/src/project-file/copy.ts';
import {openProjectStore} from '../packages/business/src/project-file/store.ts';
import {inspectCopiedProjectFile, syncCopiedDirectory, syncCopiedFile} from '../packages/business/src/project-file/backup.ts';
import {HISTORY_SCHEMA_VERSION, PROJECT_FILE_SCHEMA_VERSION} from '../packages/business/src/project-file/schema/databases.ts';
import {mediaMtimeMs, sampleRanges} from '../packages/business/src/media-reference/fingerprint.ts';
import type {ManagedAssetRecord} from '../packages/business/src/timeline-inputs.ts';
import {validateTimeline} from '../packages/business/src/timeline-inputs.ts';
import {createTimelineRecoveryBoundary} from '../packages/business/src/timeline-recovery.ts';
import {newTimelineRecord} from '../packages/business/src/timeline-new-record.ts';
import {ensureProjectRow} from '../apps/server/src/project-host/project-initialization.ts';

const repository = fileURLToPath(new URL('../', import.meta.url));
const templateId = 'timeline-basics', templateVersion = 1;
const fixedTime = '2026-01-01T00:00:00.000Z', fixedDate = new Date(fixedTime);
const uuid = (number: number): string => `10000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const seedProjectId = uuid(1), projectId = uuid(2), contentToken = 'a3c41000000000000000000000000001';
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
type ExampleAsset = ManagedAssetRecord & {readonly sizeBytes: number; readonly createdAt: string};
// Match parseProbeOutput and ordinary imports: unknown dimensions/duration use
// numeric zero, never null sentinels that strict render records cannot accept.
const sources = [
  {file: 'scene-a.mp4', id: uuid(21), mimeType: 'video/mp4', name: 'First light · picture', duration: 4, width: 720, height: 1280, hasVideo: true, hasAudio: false},
  {file: 'scene-b.mp4', id: uuid(22), mimeType: 'video/mp4', name: 'After hours · picture and sound', duration: 5, width: 720, height: 1280, hasVideo: true, hasAudio: true},
  {file: 'overlay-star.png', id: uuid(23), mimeType: 'image/png', name: 'Star card · transparent overlay', duration: 0, width: 360, height: 480, hasVideo: true, hasAudio: false},
  {file: 'sound-bed.wav', id: uuid(24), mimeType: 'audio/wav', name: 'Synthesised tone · independent audio', duration: 10, width: 0, height: 0, hasVideo: false, hasAudio: true},
] as const;
const failure = (): AppError => new AppError('PROJECT_FILE_EXISTS', 'Example output already exists; generate into a new directory and review it before replacing a checked-in example.', 409);

function directoryChain(directory: string, create = false): void {
  const root = path.parse(directory).root; let current = root;
  for (const part of directory.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let info = lstatSync(current, {throwIfNoEntry: false});
    if (!info && create) {mkdirSync(current, {mode: 0o700}); info = lstatSync(current);}
    if (!info) throw new TypeError('Example parent directory is missing');
    if (!info.isDirectory() || info.isSymbolicLink()) throw new TypeError('Example paths cannot traverse symlinks or non-directories');
  }
}
function identity(file: string): string | null {
  const info = lstatSync(file, {bigint: true, throwIfNoEntry: false});
  return info && !info.isSymbolicLink() ? `${info.dev}:${info.ino}` : null;
}
function files(directory: string, prefix = ''): string[] {
  return readdirSync(directory, {withFileTypes: true}).flatMap(entry => {
    if (entry.isSymbolicLink() || !entry.isDirectory() && !entry.isFile()) throw new TypeError('Only regular example resources can be published');
    const relative = prefix + entry.name;
    return entry.isDirectory() ? files(path.join(directory, entry.name), relative + '/') : [relative];
  }).sort();
}
function markdown(manifest: ProjectTemplateManifest): {readme: string; source: string} {
  const readme = `# Timeline basics · 时间线入门\n\n这是一个由原创程序化图形和音调组成的 10 秒竖屏项目。\n\n- 输出：1080 × 1920，30 fps，共 300 帧。\n- Video 1：First light 在 0–4 秒；After hours 在 5–10 秒。中间故意留出 1 秒空隙。\n- Video 2：透明星形卡片在 2–7 秒叠加，展示画中画。\n- Audio 1：音调在 0–4 秒和 5–9 秒播放；第二段从源音频第 5 秒开始。\n\n通过 Mioon 的受控模板实例化操作使用本示例（${manifest.templateId}，版本 ${manifest.version}）。它会建立新的项目身份，并复制四份素材。本目录不是用户工作区或备份，不附带本机 history、Mio 对话、任务、撤销、cache、凭据或信任记录。\n\n所有素材都以项目内相对路径引用。实例建立后，即使安装目录中的模板被移走，也可以离线重开和读取素材。应用首次打开实例时正常创建属于它的空本机记录。\n\n来源和重建方法见 SOURCE.md，项目许可见 LICENSE；逐文件大小和 SHA-256 见 manifest.json。\n`;
  const source = `# 来源、许可与重建\n\n模板 ${manifest.templateId}，版本 ${manifest.version}；项目物理结构版本 ${PROJECT_FILE_SCHEMA_VERSION}。生成时验证当前本机 history 结构 ${HISTORY_SCHEMA_VERSION}，但成品不分发 history。\n\n四份素材逐字节复制自本仓库 examples/timeline-synthetic。原创程序源是 scripts/create-timeline-fixtures.py：Pillow 绘制几何栅格图形，FFmpeg 制作运动视频并合成正弦音调。没有下载照片、用户文件、模型输出、供应商调用或联网步骤。\n\n几何图案、布局、原创标签与合成音调由本项目创作，和 LICENSE 中的项目源码一样按 Apache-2.0 分发。原始绘图脚本使用 DejaVu Sans 渲染可见文字。本示例不分发字体软件；字体自身的 Bitstream Vera/DejaVu 条款由其官方许可说明，不能将字体软件重新声明为 Apache-2.0：https://dejavu-fonts.github.io/License.html 。\n\n使用 Node 24 和仓库已安装的冻结依赖，离线重建普通项目与清单：\n\n    node scripts/create-project-file-example.ts --output=/absolute/new/timeline-basics\n\n输出目录必须不存在。先审阅新输出再替换仓库成品；生成器不会覆盖既有文件或目录。它使用真实项目内核、业务时间线校验和共用 copy builder，并固定示例 ID、内容令牌、元数据日期和引用 mtime。普通重建复用已检入素材，不需要 FFmpeg、Pillow 或已安装字体。Mioon 为每份用户实例重新观察和校验素材指纹。\n\n如需重做原始媒体，另在已具备 Pillow、FFmpeg/libx264 及脚本所列 DejaVu 字体路径的环境运行 scripts/create-timeline-fixtures.py，再重建本项目。编码器或字体版本变化可能改变媒体字节；须审阅并有意更新清单。这里不承诺跨编码器、字体、SQLite 版本或项目格式变化仍保持逐字节一致。\n`;
  return {readme, source};
}

export async function generateProjectFileExample(outputDir: string): Promise<ProjectTemplateManifest> {
  if (!path.isAbsolute(outputDir) || path.normalize(outputDir) !== outputDir) throw new TypeError('Choose a normalized absolute new example directory');
  if (lstatSync(outputDir, {throwIfNoEntry: false})) throw failure();
  const parent = path.dirname(outputDir);
  directoryChain(parent, true);
  const stage = mkdtempSync(path.join(parent, '.project-example-'));
  const work = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-example-records-'));
  let ownedTarget: string | null = null, published = false;
  try {
    const mediaDirectory = path.join(stage, 'media'); mkdirSync(mediaDirectory);
    const assets = new Map<string, ExampleAsset>();
    for (const item of sources) {
      const source = path.join(repository, 'examples/timeline-synthetic', item.file), destination = path.join(mediaDirectory, item.file);
      directoryChain(path.dirname(source));
      const info = lstatSync(source);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new TypeError('Expected an original single-link media file');
      copyFileSync(source, destination, constants.COPYFILE_EXCL); utimesSync(destination, fixedDate, fixedDate);
      const bytes = readFileSync(destination), digest = sha256(bytes), sampled = createHash('sha256');
      for (const range of sampleRanges(bytes.length)) sampled.update(bytes.subarray(range.start, range.start + range.length));
      assets.set(item.id, {id: item.id, projectId: seedProjectId, name: item.name, mimeType: item.mimeType,
        duration: item.duration, width: item.width, height: item.height, hasVideo: item.hasVideo, hasAudio: item.hasAudio,
        sha256: digest, referenceRevision: 1, reference: {pathForm: 'relative', path: 'media/' + item.file, volume: null,
          sizeBytes: bytes.length, mtimeMs: mediaMtimeMs(lstatSync(destination, {bigint: true})), sampledSha256: sampled.digest('hex'), fullSha256: digest},
        sizeBytes: bytes.length, createdAt: fixedTime});
    }
    const seedFile = path.join(stage, '.seed.mioon'); createProjectFile(seedFile, {projectId: seedProjectId});
    const store = openProjectStore({projectFile: seedFile, locate: () => ({localDir: path.join(work, 'local'), cacheDir: path.join(work, 'cache'), tempDir: path.join(work, 'tmp')})});
    try {
      if (store.db.prepare('SELECT version FROM main.schema_version').get()!.version !== HISTORY_SCHEMA_VERSION) throw new Error('The generator did not open the current history schema');
      ensureProjectRow(store, {name: 'Timeline basics', description: 'An original ten-second study of cuts, a gap, picture-in-picture and independent audio.', now: () => fixedDate});
      const timeline = newTimelineRecord(seedProjectId, {fps: 30, width: 1080, height: 1920}, () => fixedTime);
      timeline.id = uuid(10); timeline.tracks.forEach((track, index) => {track.id = uuid(11 + index);});
      const full = {x: 0, y: 0, width: 1080, height: 1920};
      const base = (id: number, track: number, asset: number, name: string, startFrame: number, durationFrames: number, sourceInFrame: number, gain: number) =>
        ({id: uuid(id), trackId: uuid(track), assetId: uuid(asset), name, startFrame, durationFrames, sourceInFrame, gain, rect: {...full}});
      timeline.clips = [
        base(31, 11, 21, 'First light · silent picture', 0, 120, 0, 1),
        base(32, 11, 22, 'After hours · embedded tone', 150, 150, 0, 0.6),
        {...base(33, 12, 23, 'Star card · picture in picture', 60, 150, 0, 1), rect: {x: 600, y: 240, width: 360, height: 480}},
        base(34, 13, 24, 'Independent tone A', 0, 120, 0, 0.5),
        base(35, 13, 24, 'Independent tone B · trimmed source', 150, 120, 150, 0.5),
      ]; timeline.durationFrames = 300;
      validateTimeline(timeline, assets);
      store.tx(() => {
        for (const asset of assets.values()) store.put('assets', asset);
        createTimelineRecoveryBoundary(store.db, {projectId: seedProjectId, requestId: uuid(90)}).validate(timeline);
        store.put('timelines', timeline);
      });
      await copyProjectToNewFile(store, {projectFile: path.join(stage, 'timeline-basics.mioon'), sourceProjectDir: stage,
        targetProjectDir: stage, projectId, contentToken, clearProcessRevisions: true});
    } finally {store.close();}
    rmSync(seedFile);
    const projectFile = path.join(stage, 'timeline-basics.mioon'), inspected = inspectCopiedProjectFile(projectFile);
    if (inspected.projectId !== projectId || inspected.contentToken !== contentToken || inspected.formatVersion !== PROJECT_FILE_SCHEMA_VERSION) throw new Error('Generated project failed its current-format identity check');
    const entry = (relative: string) => {const bytes = readFileSync(path.join(stage, ...relative.split('/'))); return {path: relative, sizeBytes: bytes.length, sha256: sha256(bytes)};};
    const manifest = projectTemplateManifestSchema.parse({templateId, version: templateVersion, projectFile: entry('timeline-basics.mioon'), assets: sources.map(item => entry('media/' + item.file))});
    const documentation = markdown(manifest);
    writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', {flag: 'wx'});
    writeFileSync(path.join(stage, 'README.md'), documentation.readme, {flag: 'wx'});
    writeFileSync(path.join(stage, 'SOURCE.md'), documentation.source, {flag: 'wx'});
    copyFileSync(path.join(repository, 'LICENSE'), path.join(stage, 'LICENSE'), constants.COPYFILE_EXCL);
    const complete = files(stage);
    if (complete.length !== 9 || complete.reduce((sum, name) => sum + lstatSync(path.join(stage, name)).size, 0) > 5 * 1024 * 1024) throw new Error('Example resources must contain nine files and remain at most 5 MiB');
    for (const name of complete) syncCopiedFile(path.join(stage, name)); syncCopiedDirectory(mediaDirectory); syncCopiedDirectory(stage);
    try {mkdirSync(outputDir, {mode: 0o700});} catch (error) {if ((error as {code?: unknown}).code === 'EEXIST') throw failure(); throw error;}
    ownedTarget = identity(outputDir);
    if (!ownedTarget || identity(outputDir) !== ownedTarget || readdirSync(outputDir).length !== 0) throw failure();
    renameSync(stage, outputDir); published = true; syncCopiedDirectory(parent);
    return manifest;
  } finally {
    rmSync(work, {recursive: true, force: true});
    if (!published) {
      rmSync(stage, {recursive: true, force: true});
      if (ownedTarget && identity(outputDir) === ownedTarget) {try {rmdirSync(outputDir);} catch { /* Never remove another owner's content. */ }}
    }
  }
}

async function main(args: readonly string[]): Promise<void> {
  if (args.length > 1 || args.length === 1 && !args[0].startsWith('--output=')) throw new TypeError('Usage: node scripts/create-project-file-example.ts [--output=/absolute/new/directory]');
  const output = args.length ? args[0].slice('--output='.length) : path.join(repository, 'examples/project-file-v1/timeline-basics');
  const manifest = await generateProjectFileExample(output);
  console.log(JSON.stringify({directory: output, templateId: manifest.templateId, version: manifest.version, files: manifest.assets.length + 5,
    mediaAndProjectBytes: manifest.projectFile.sizeBytes + manifest.assets.reduce((sum, asset) => sum + asset.sizeBytes, 0)}, null, 2));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
