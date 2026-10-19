import React from 'react';
import {LoaderCircle} from '@mioon/ui/components/workbench-icons';
import {useI18n} from './i18n/I18nProvider.tsx';
import {previewProgress} from './preview-playback.ts';
export default function PreviewRenderProgress({revision,previous,progress}:{revision:number;previous:boolean;progress:unknown}) {
  const {t,formatNumber}=useI18n(),percent=previewProgress(progress);
  return <div className="preview-notice edit-preview-progress" data-testid="timeline-render-progress"><LoaderCircle size={14} className="animate-spin"/><div><span>{t('timeline.preview.rendering',{revision,previous:previous?t('timeline.preview.previous'):''})}</span><progress max={100} value={percent??undefined} aria-label={t('timeline.view.rendering')}/></div>{percent!==null&&<output>{formatNumber(percent)}%</output>}</div>;
}
