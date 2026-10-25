import React, { useEffect } from 'react';
import { WorkbenchButton } from '@mioon/ui/components/workbench-controls';
import { message as msg } from '../../../packages/i18n/src/index.ts';
import { useI18n } from './i18n/I18nProvider.tsx';
import BoardInspectorGroup from './BoardInspectorGroup.tsx';
import { sceneSegments } from './scene-cuts.ts';
import { sceneSourceIssue, sceneTaskActive, sceneTaskPercent } from './scene-detection.ts';
import type { SceneDetectionController, SceneDetectionState, SceneSourceAsset } from './scene-detection.ts';
import './scene-detection.css';

/** The inspector's 镜头拆解 section for one video: not detected, detecting, or its segments. */
export default function AssetSceneSummary({ asset, state, controller, onOpen }: { asset: SceneSourceAsset; state: SceneDetectionState; controller: SceneDetectionController; onOpen: () => void }) {
  const { t, renderMessage } = useI18n();
  const supported = !sceneSourceIssue(asset), owned = Boolean(state.projectId && asset.projectId === state.projectId);
  useEffect(() => { if (supported && owned && state.visible && !state.results[asset.id]) void controller.loadResult(asset.id); }, [controller, supported, owned, state.visible, asset.id, asset.sha256]);
  if (!supported || !owned) return null;
  const task = state.tasks.find(item => item.sourceAssetId === asset.id && sceneTaskActive(item)), view = state.results[asset.id], response = view?.response ?? null;
  const result = response?.result ?? null;
  const minutes = result ? Math.floor((Date.now() - Date.parse(result.createdAt)) / 60_000) : 0;
  const ago = !Number.isFinite(minutes) || minutes < 1 ? msg('scene.time.justNow') : minutes < 60 ? msg('scene.time.minutes', { count: minutes }) : msg('scene.time.hours', { count: Math.floor(minutes / 60) });
  // A result that cannot be read (for example a copy without scene records) leaves the section out.
  if (!task && !result && view?.phase === 'error') return null;
  const kind = task ? 'running' : result && !response?.current ? 'stale' : result ? 'result' : view?.phase === 'ready' ? 'none' : 'loading';
  const text = task ? task.state === 'queued' ? t('scene.summary.queued') : t('scene.summary.running', { percent: sceneTaskPercent(task) })
    : kind === 'stale' ? t('scene.summary.stale')
    : result ? `${t('scene.summary.result', { count: sceneSegments(result.cuts.map(cut => cut.frame), result.frameCount).length })} · ${renderMessage(msg(result.origin === 'manual' ? 'scene.params.savedAt' : 'scene.params.detectedAt', { time: renderMessage(ago) }))}`
    : kind === 'none' ? t('scene.summary.none') : t('scene.summary.loading');
  return <BoardInspectorGroup title={t('scene.summary.title')}>
    <div className="asset-scene-summary" data-testid="asset-scene-summary" data-state={kind}><span role="status">{text}</span>
      {(task || result) && <WorkbenchButton variant="ghost" size="compact" data-testid="asset-scene-open" onClick={onOpen}>{t(task ? 'scene.summary.open' : 'scene.summary.view')}</WorkbenchButton>}</div>
  </BoardInspectorGroup>;
}
