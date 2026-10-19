import React from 'react';
import {WorkbenchButton,WorkbenchEmptyState} from '@mioon/ui/components/workbench-controls';
import {Clapperboard,Plus,Image,Sparkles,Layers} from '@mioon/ui/components/workbench-icons';
import {useI18n} from './i18n/I18nProvider.tsx';
interface Props{hasProject:boolean;onAddShot():void;onCreateProject():void;onCreateStructure?():void;structureBusy?:boolean;onImportReference?():void;onGenerateImage?():void;imageDisabled?:boolean}
export default function CanvasEmptyState({hasProject,onAddShot,onCreateProject,onCreateStructure,structureBusy=false,onImportReference,onGenerateImage,imageDisabled=false}:Props){
  const {t}=useI18n();return <div className="canvas-empty board-empty" data-testid="canvas-empty-state"><WorkbenchEmptyState className="board-empty-card" title={t(hasProject?'redesign.board.noShots':'shell.emptyTitle')} description={<span id={!hasProject?'workspace-mode-help':undefined}>{t(hasProject?'redesign.board.noShotsHint':'shell.emptyCreateHint')}</span>} icon={<Clapperboard size={24}/>} actions={<WorkbenchButton variant="primary" size="large" data-testid={!hasProject?'empty-create-project':undefined} aria-describedby={!hasProject?'workspace-mode-help':undefined} onClick={hasProject?onAddShot:onCreateProject}><Plus size={16}/>{t(hasProject?'redesign.board.addShot':'projects.createFirst')}</WorkbenchButton>}/>
    {hasProject&&<div className="board-empty-secondary">{onImportReference&&<WorkbenchButton variant="ghost" onClick={onImportReference}><Image size={13}/>{t('redesign.board.referenceDropHint')}</WorkbenchButton>}{onGenerateImage&&<WorkbenchButton variant="ghost" disabled={imageDisabled} onClick={onGenerateImage}><Sparkles size={13}/>{t('redesign.board.generateReference')}</WorkbenchButton>}{onCreateStructure&&<WorkbenchButton variant="ghost" data-testid="create-three-shots" disabled={structureBusy} onClick={onCreateStructure}><Layers size={13}/>{t('projects.createStructure')}</WorkbenchButton>}</div>}
  </div>;
}
