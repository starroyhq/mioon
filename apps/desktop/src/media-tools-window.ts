import type {MediaToolsInstallPhase, MediaToolsProgress} from '../../../packages/contracts/src/workspace-info.ts';

/**
 * First-run progress for the media tools download. It runs before the local service
 * exists, so it cannot use the application page: a fixed inline document without
 * network access shows the progress, and closing the window cancels the download.
 */
export interface MediaToolsProgressText {
  readonly lang: string;
  readonly title: string;
  readonly heading: string;
  readonly phases: Readonly<Record<'downloading' | 'verifying' | 'checking' | 'installing', string>>;
  readonly cancel: string;
}
const escape = (value: string): string => value.replace(/[&<>"']/gu, character => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[character]!);
export const MEDIA_TOOLS_CANCEL_TITLE = 'mioon-media-tools-cancel';
export function megabytes(bytes: number): string {return `${(bytes / 1024 / 1024).toFixed(1)} MB`;}

export function mediaToolsProgressPage(text: MediaToolsProgressText): string {
  const phases = JSON.stringify(text.phases).replace(/</gu, '\\u003c');
  return `<!doctype html><html lang="${escape(text.lang)}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>${escape(text.title)}</title><style>
:root{color-scheme:light dark;font:13px -apple-system,BlinkMacSystemFont,'PingFang SC','Hiragino Sans',sans-serif;background:Canvas;color:CanvasText}
body{margin:0;padding:22px 24px;user-select:none;-webkit-user-select:none}h1{margin:0 0 14px;font-size:14px;font-weight:600}
progress{width:100%;height:6px;accent-color:#b53bff}.row{display:flex;justify-content:space-between;gap:12px;margin-top:8px;color:GrayText;font-variant-numeric:tabular-nums}
button{float:right;margin-top:18px;font:inherit;padding:4px 14px}
</style></head><body><h1>${escape(text.heading)}</h1><progress id="bar" max="1"></progress>
<div class="row"><span id="phase" aria-live="polite">${escape(text.phases.downloading)}</span><span id="size"></span></div>
<button id="cancel" type="button">${escape(text.cancel)}</button>
<script>const phases=${phases};const mb=b=>(b/1048576).toFixed(1)+' MB';
window.mioonProgress=p=>{const bar=document.getElementById('bar');if(p.totalBytes>0&&p.phase==='downloading')bar.value=Math.min(1,p.receivedBytes/p.totalBytes);else bar.removeAttribute('value');
document.getElementById('phase').textContent=phases[p.phase]||phases.downloading;document.getElementById('size').textContent=p.totalBytes>0?mb(p.receivedBytes)+' / '+mb(p.totalBytes):'';
document.getElementById('cancel').disabled=p.phase==='installing';};
document.getElementById('cancel').addEventListener('click',()=>{document.title=${JSON.stringify(MEDIA_TOOLS_CANCEL_TITLE)};});</script></body></html>`;
}
export function mediaToolsProgressUrl(text: MediaToolsProgressText): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(mediaToolsProgressPage(text))}`;
}
/** The fixed update call evaluated in the progress document; values are JSON-encoded numbers and a known phase. */
export function mediaToolsProgressScript(progress: MediaToolsProgress): string {
  const phase: MediaToolsInstallPhase = progress.phase;
  return `window.mioonProgress(${JSON.stringify({phase, receivedBytes: Math.max(0, Math.trunc(progress.receivedBytes)), totalBytes: Math.max(0, Math.trunc(progress.totalBytes))})})`;
}
