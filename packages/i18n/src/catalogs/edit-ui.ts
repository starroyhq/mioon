import type {MessageCatalog} from '../types.ts';

export const editUiMessages = {
  'editUi.track.main': {'zh-Hans':'主轨','zh-Hant':'主軌',en:'Main track',ja:'メイントラック'},
  'editUi.track.mainMarker': {'zh-Hans':'{badge} · 主轨','zh-Hant':'{badge} · 主軌',en:'{badge} · Main track',ja:'{badge} · メイントラック'},
  'editUi.clip.version': {'zh-Hans':' · V{version}','zh-Hant':' · V{version}',en:' · V{version}',ja:' · V{version}'},
  'editUi.clip.locked': {'zh-Hans':' · 锁定 V{version}','zh-Hant':' · 鎖定 V{version}',en:' · Locked V{version}',ja:' · ロック V{version}'},
  'editUi.clip.placeholder': {'zh-Hans':' · 待生成（占位 {seconds} 秒）','zh-Hant':' · 待生成（佔位 {seconds} 秒）',en:' · Not generated ({seconds} s placeholder)',ja:' · 未生成（{seconds} 秒のプレースホルダー）'},
  'editUi.anchor.detached': {'zh-Hans':'未挂靠','zh-Hant':'未掛靠',en:'Not anchored',ja:'未接続'},
  'editUi.shot.title': {'zh-Hans':'镜头 {number} · {name}','zh-Hant':'鏡頭 {number} · {name}',en:'Shot {number} · {name}',ja:'ショット {number} · {name}'},
  'editUi.shot.reveal': {'zh-Hans':'在画板中查看 ↗','zh-Hant':'在畫板中查看 ↗',en:'View on board ↗',ja:'ボードで表示 ↗'},
  'editUi.version.label': {'zh-Hans':'版本','zh-Hant':'版本',en:'Version',ja:'バージョン'},
  'editUi.version.follow': {'zh-Hans':'跟随画板 · V{version}','zh-Hant':'跟隨畫板 · V{version}',en:'Follow board · V{version}',ja:'ボードに追従 · V{version}'},
  'editUi.version.locked': {'zh-Hans':'锁定 · V{version}','zh-Hant':'鎖定 · V{version}',en:'Locked · V{version}',ja:'ロック · V{version}'},
  'editUi.version.lock': {'zh-Hans':'锁定版本','zh-Hant':'鎖定版本',en:'Lock version',ja:'バージョンをロック'},
  'editUi.version.unlock': {'zh-Hans':'取消锁定版本','zh-Hant':'取消鎖定版本',en:'Unlock version',ja:'バージョンのロックを解除'},
  'editUi.copyMove.title': {'zh-Hans':'复制成新镜头再挪？','zh-Hant':'複製成新鏡頭再挪？',en:'Copy as a new shot and move?',ja:'新しいショットとして複製して移動しますか？'},
  'editUi.copyMove.cancel': {'zh-Hans':'取消','zh-Hant':'取消',en:'Cancel',ja:'キャンセル'},
  'editUi.copyMove.confirm': {'zh-Hans':'复制并挪动','zh-Hant':'複製並挪動',en:'Copy and move',ja:'複製して移動'},
  'editUi.notice.removedFromMainTrack': {'zh-Hans':'已从主轨移除 {name}','zh-Hant':'已從主軌移除 {name}',en:'Removed {name} from the main track',ja:'メイントラックから{name}を削除しました'},
  'editUi.notice.undo': {'zh-Hans':'撤销','zh-Hant':'復原',en:'Undo',ja:'元に戻す'},
  'editUi.notice.dismiss': {'zh-Hans':'关闭','zh-Hant':'關閉',en:'Close',ja:'閉じる'},
} as const satisfies MessageCatalog;
