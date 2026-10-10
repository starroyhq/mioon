// These summaries are rendered as React text. Bound each untrusted label and
// the number shown; preserve exact counts even when a selection is very large.
function displayText(value, limit = 64) {
  const original = String(value || '未命名文件');
  const characters = Array.from(original.slice(0, limit * 4).replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, ' '));
  return characters.slice(0, limit).join('') + (original.length > limit * 4 || characters.length > limit ? '…' : '');
}
function fileList(files) {
  const shown = files.slice(0, 3).map(file => `「${displayText(file.name)}」`).join('、');
  return `${files.length} 个${shown ? `：${shown}${files.length > 3 ? `（另 ${files.length - 3} 个未列出）` : ''}` : ''}`;
}
export function importBusyFeedback(files) {
  return `上一批导入仍在处理中，当前文件结束后不再继续后续文件。本次选择未开始 ${fileList(files)}。请等待结束并核对素材列表，再单独选择仍需导入的文件。`;
}
export function importFeedback(files, done, stopped = null) {
  const confirmed = `已确认导入 ${fileList(files.slice(0, done))}。`;
  if (!stopped) return `${confirmed}未尝试 0 个。拖入画板或时间线，即可开始编排。`;
  const current = fileList(files.slice(done, done + 1));
  const outcome = stopped.kind === 'local'
    ? `本地处理失败，未提交 ${current}。${displayText(stopped.reason || '无法读取文件，请检查文件。', 160)}`
    : stopped.kind === 'rejected'
      ? `服务端已拒绝 ${current}。${displayText(stopped.reason || '服务端拒绝了本次导入。', 160)}`
      : `结果未知 ${current}。请求已发出，但未收到有效确认；素材可能已保存。请先核对素材列表再决定是否重新导入，不要整批重选。`;
  return `${confirmed}${outcome} 未尝试 ${fileList(files.slice(done + 1))}。已停止本批，不会自动重试。`;
}
// asset.import already returns this asset identity. This is a narrow check of
// its existing response, not a new receipt, replay key or recovery protocol.
export function importAcknowledged(asset, input) {
  return Boolean(asset && typeof asset === 'object' && !Array.isArray(asset)
    && typeof asset.id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(asset.id)
    && asset.projectId === input.projectId && asset.name === input.name && asset.mimeType === input.mimeType);
}
