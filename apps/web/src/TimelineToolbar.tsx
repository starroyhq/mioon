import React from 'react';
import type {ReactNode} from 'react';
import {MousePointer2, Magnet, Plus, ChevronDown, LocateFixed, Minus, ChevronUp} from '@mioon/ui/components/workbench-icons';
import {Button} from '@mioon/ui/components/button';
import {Input} from '@mioon/ui/components/input';
import {Slider} from '@mioon/ui/components/slider';
import {DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator} from '@mioon/ui/components/dropdown-menu';
import {useI18n} from './i18n/I18nProvider.tsx';
import {displayTimelineFrame} from './timeline-removal.ts';
interface Props {
  playhead: number; fps: number; timecodeFormat: 'timecode'|'seconds'; onSeek: (frame: number) => void;
  collapsed: boolean; onCollapse: () => void; snapping: boolean; onSnap: () => void; snapHint: string;
  pixelsPerSecond: number; onZoom: (value: number) => void; history: ReactNode; split: ReactNode; waveform: ReactNode;
  trackDisabled: boolean; onTrackAdd: (kind: 'video'|'audio') => void; seedDisabled: boolean; onSeed?: () => void;
  renderDisabled: boolean; rendering: boolean; onRender: () => void; selectionActions?: ReactNode;
}
export default function TimelineToolbar(props: Props) {
  const {t} = useI18n();
  return <div className="timeline-toolbar edit-timeline-toolbar" data-text-selectable={false}>
    <div className="edit-timeline-tools"><Button variant="ghost" size="icon-sm" aria-label={t('edit.tool.select')} aria-pressed className="edit-selection-tool"><MousePointer2 size={15} /></Button>{props.split}<Button variant="ghost" size="icon-sm" data-testid="timeline-snapping" className={`timeline-snap-toggle ${props.snapping ? 'active' : ''}`} aria-label={t(props.snapping ? 'timeline.view.snapOn' : 'timeline.view.snapOff')} aria-pressed={props.snapping} title={props.snapHint} onClick={props.onSnap}><Magnet size={15} /></Button>{props.waveform}</div>
    <label className="edit-playhead-input"><LocateFixed size={13} /><output>{displayTimelineFrame(props.playhead,props.fps,props.timecodeFormat)}</output><Input aria-label={t('timeline.view.playheadFrame')} data-testid="timeline-playhead" type="number" min={0} max={18000} step={1} value={props.playhead} onChange={event => props.onSeek(Math.max(0,Math.min(18000,Math.round(Number(event.target.value)||0))))} /></label>
    <div className="edit-timeline-actions">{props.history}{props.selectionActions}<DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="sm" />} aria-label={t('edit.track.add')}><Plus size={14} /><span>{t('edit.track.add')}</span><ChevronDown size={11} /></DropdownMenuTrigger><DropdownMenuContent className="edit-track-menu" align="end"><DropdownMenuItem disabled={props.trackDisabled} data-testid="add-video-track" onClick={() => props.onTrackAdd('video')}>{t('timeline.view.videoTrack')}</DropdownMenuItem><DropdownMenuItem disabled={props.trackDisabled} data-testid="add-audio-track" onClick={() => props.onTrackAdd('audio')}>{t('timeline.view.audioTrack')}</DropdownMenuItem>{props.onSeed && <><DropdownMenuSeparator /><DropdownMenuItem disabled={props.seedDisabled} data-testid="seed-timeline" onClick={props.onSeed}>{t('timeline.view.seed')}</DropdownMenuItem></>}<DropdownMenuSeparator /><DropdownMenuItem data-testid="timeline-render-preview" disabled={props.renderDisabled} onClick={props.onRender}>{t(props.rendering?'timeline.view.rendering':'timeline.view.renderPreview')}</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
      <div className="timeline-zoom"><Minus size={13} /><Slider className="timeline-zoom-slider" aria-label={t('timeline.view.zoom')} min={28} max={220} step={1} value={[props.pixelsPerSecond]} onValueChange={value => props.onZoom(Array.isArray(value)?value[0]??76:value)} /><span>{Math.round(props.pixelsPerSecond/76*100)}%</span></div>
      <Button variant="ghost" size="icon-sm" data-testid="toggle-timeline" aria-label={t(props.collapsed?'timeline.view.expand':'timeline.view.collapse')} title={t(props.collapsed?'timeline.view.expand':'timeline.view.collapse')} onClick={props.onCollapse}><ChevronUp size={14} style={{transform:props.collapsed?'rotate(180deg)':undefined}} /></Button>
    </div>
  </div>;
}
