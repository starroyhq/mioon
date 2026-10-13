import React from 'react';
import { Button } from '@mioon/ui/components/button';
export default function EditorWindowOpening({ error, onRetry, onProjects }: { readonly error: string; readonly onRetry: () => void; readonly onProjects: () => void }) {
  return <main className="boot-page" data-testid="editor-window-opening" role={error ? 'alert' : 'status'}>
    <h1>{error ? '暂时无法打开此项目' : '正在打开项目…'}</h1>
    <p>{error || '正在核对项目数据和已保存视图。'}</p>
    {error && <Button variant="outline" onClick={onRetry}>重试打开此项目</Button>}
    <Button variant="ghost" onClick={onProjects}>显示项目首页</Button>
    <p>项目首页在独立窗口中；显示首页不会关闭此窗口或取消已接受的任务。</p>
  </main>;
}
