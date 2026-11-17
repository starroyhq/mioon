import type {MessageCatalog} from '../types.ts';

// The approved update copy currently ships in Simplified Chinese.
function simplified<const Text extends string>(text: Text) {
  return {'zh-Hans': text, 'zh-Hant': text, en: text, ja: text} as const;
}

export const desktopUpdateMessages = {
  'desktopUpdate.checkMenu': simplified('检查更新…'),
  'desktopUpdate.available': simplified('Mioon {version} 可以更新了'),
  'desktopUpdate.current': simplified('当前 {version}'),
  'desktopUpdate.releaseDate': simplified('{date}发布'),
  'desktopUpdate.packageSize': simplified('约 {size}'),
  'desktopUpdate.notes': simplified('更新内容'),
  'desktopUpdate.fullNotes': simplified('查看完整说明'),
  'desktopUpdate.later': simplified('稍后'),
  'desktopUpdate.download': simplified('下载并安装'),
  'desktopUpdate.downloading': simplified('正在下载 Mioon {version}'),
  'desktopUpdate.downloadBytes': simplified('{transferred} / {total} MB'),
  'desktopUpdate.seconds': simplified('还要约 {count} 秒'),
  'desktopUpdate.minutes': simplified('还要约 {count} 分钟'),
  'desktopUpdate.cancelDownload': simplified('取消下载'),
  'desktopUpdate.backgroundDownload': simplified('在后台下载'),
  'desktopUpdate.ready': simplified('Mioon {version} 已准备好'),
  'desktopUpdate.exportWarning': simplified('正在导出，现在重启会中断导出'),
  'desktopUpdate.installOnQuit': simplified('退出时安装'),
  'desktopUpdate.restart': simplified('立即重启'),
  'desktopUpdate.restartAnyway': simplified('仍然重启'),
  'desktopUpdate.checking': simplified('正在检查更新…'),
  'desktopUpdate.latest': simplified('已是最新版本'),
  'desktopUpdate.checkFailed': simplified('检查更新失败'),
  'desktopUpdate.checkFailedBody': simplified('连不上 GitHub'),
  'desktopUpdate.downloadFailed': simplified('下载没有完成'),
  'desktopUpdate.downloadFailedBody': simplified('网络中断或文件校验不通过'),
  'desktopUpdate.installVersionFailed': simplified('{version} 没有装上'),
  'desktopUpdate.website': simplified('去网站下载'),
  'desktopUpdate.retry': simplified('重试'),
  'desktopUpdate.ok': simplified('好'),
  'desktopUpdate.badgeAvailable': simplified('可更新 {version}'),
  'desktopUpdate.badgeDownloading': simplified('下载中 {progress}'),
  'desktopUpdate.badgeReady': simplified('重启以更新'),
  'desktopUpdate.notSaved': simplified('请先保存打开项目中的编辑，再重启安装。'),
  'desktopUpdate.saveBeforeQuit': simplified('请先保存所有窗口里的编辑，再退出安装更新。'),
  'desktopUpdate.nativeInstallFailed': simplified('更新没有装上'),
  'desktopUpdate.exportChanged': simplified('刚开始了一项导出。请确认是否仍然重启。'),
  'desktopUpdate.installFailed': simplified('暂时无法安装更新，请重试。'),
  'desktopUpdate.cancelFailed': simplified('暂时无法取消下载，请重试。'),
} satisfies MessageCatalog;
