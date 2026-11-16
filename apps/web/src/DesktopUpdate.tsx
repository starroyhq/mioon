import React, {createContext, useCallback, useContext, useEffect, useRef, useState} from 'react';
import type {ReactNode} from 'react';
import {Dialog} from '@mioon/ui/components/dialog';
import {WorkbenchAlert, WorkbenchButton, WorkbenchDialogContent, WorkbenchProgress, WorkbenchToast, WorkbenchToastRegion} from '@mioon/ui/components/workbench-controls';
import {AlertTriangle, ArrowUp, ArrowUpRight, CircleAlert, CircleCheck, RefreshCw, X} from '@mioon/ui/components/workbench-icons';
import {DESKTOP_UPDATE_RELEASES, desktopReleaseVersionSchema} from '../../../packages/contracts/src/desktop-update.ts';
import type {DesktopUpdateBridge, DesktopUpdateView} from '../../../packages/contracts/src/desktop-update.ts';
import {useI18n} from './i18n/I18nProvider.tsx';
import Icon from './icons.tsx';
import './desktop-update.css';

const fullNotesUrl = (version: string): string | undefined =>
  desktopReleaseVersionSchema.safeParse(version).success ? `${DESKTOP_UPDATE_RELEASES}/tag/v${version}` : undefined;
const percentLabel = (value: number): string => `${Math.floor(value)}%`;
const megabytes = (bytes: number): number => Math.round(bytes / 1_000_000);

type Control = 'check' | 'download' | 'cancel' | 'install';
type Feedback = 'checkFailed' | 'downloadFailed' | 'cancelFailed' | 'notSaved' | 'exportChanged' | 'installFailed';

function failureMessage(control: Control, error: unknown): Feedback {
  if (control === 'check') return 'checkFailed';
  if (control === 'download') return 'downloadFailed';
  if (control === 'cancel') return 'cancelFailed';
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (code === 'UPDATE_NOT_SAVED') return 'notSaved';
  if (code === 'UPDATE_EXPORT_ACTIVE') return 'exportChanged';
  return 'installFailed';
}

interface Presentation {
  readonly view: DesktopUpdateView | null;
  open(): void;
}
const UpdatePresentation = createContext<Presentation | null>(null);

function readBridge(): DesktopUpdateBridge | null {
  if (typeof window === 'undefined') return null;
  const bridge = (window as Window & {mioonDesktopUpdate?: DesktopUpdateBridge}).mioonDesktopUpdate;
  return bridge && (['read', 'subscribe', 'check', 'download', 'cancel', 'install'] as const).every(
    key => typeof bridge[key] === 'function',
  ) ? bridge : null;
}

export function DesktopUpdateLauncherVersion({fallback}: {readonly fallback?: string}) {
  const presentation = useContext(UpdatePresentation);
  const {t} = useI18n();
  const view = presentation?.view, state = view?.state;
  const version = view?.currentVersion || fallback;
  let label: string | undefined, icon: ReactNode;
  if (state?.kind === 'ready') {
    label = t('desktopUpdate.badgeReady');
    icon = <RefreshCw size={12} aria-hidden="true" />;
  } else if (state?.kind === 'downloading') {
    label = t('desktopUpdate.badgeDownloading', {progress: percentLabel(state.percent)});
    icon = <Icon name="download" size={12} />;
  } else if (state?.kind === 'available' || state?.kind === 'failed' && state.stage === 'download') {
    label = t('desktopUpdate.badgeAvailable', {version: state.offer.version});
    icon = <ArrowUp size={12} aria-hidden="true" />;
  }
  if (!version && !label) return null;
  return <span className="launcher-home-version-row">
    {version && <span className="launcher-home-version" data-testid="launcher-version">{version}</span>}
    {label && <WorkbenchButton type="button" size="compact" variant={state?.kind === 'ready' ? 'primary' : 'secondary'} title={label}
      className="desktop-update-badge" data-testid="desktop-update-badge" onClick={presentation?.open}>{icon}<span>{label}</span></WorkbenchButton>}
  </span>;
}

export function DesktopUpdateRoot({blocked, children}: {readonly blocked: boolean; readonly children: ReactNode}) {
  const {t} = useI18n();
  const [bridge] = useState(readBridge);
  const [view, setView] = useState<DesktopUpdateView | null>(null);
  const [open, setOpen] = useState(false);
  const [readyNotice, setReadyNotice] = useState<number | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const flights = useRef(new Set<Control>());
  const [pending, setPending] = useState<ReadonlySet<Control>>(() => new Set());
  const seen = useRef({revision: -1, notice: 0});
  const opened = useRef(false), lifetime = useRef(0);
  const changeOpen = useCallback((next: boolean) => {
    opened.current = next;
    setOpen(next);
    if (next) {
      setReadyNotice(null);
      setFeedback(null);
    }
  }, []);
  const accept = useCallback((next: DesktopUpdateView) => {
    if (next.revision < seen.current.revision) return;
    seen.current.revision = next.revision;
    setView(next);
    if (!next.notice || next.notice.id <= seen.current.notice) return;
    seen.current.notice = next.notice.id;
    if (next.notice.kind === 'launch' && next.state.kind === 'available' || next.notice.kind === 'manual' && next.state.kind !== 'disabled') {
      changeOpen(true);
    } else if (next.notice.kind === 'ready' && next.state.kind === 'ready' && !opened.current) {
      setReadyNotice(next.notice.id);
    }
  }, [changeOpen]);
  useEffect(() => {
    if (!bridge) return;
    const owner = ++lifetime.current;
    const receive = (next: DesktopUpdateView) => {if (lifetime.current === owner) accept(next);};
    const release = bridge.subscribe(receive);
    void bridge.read().then(receive, () => {});
    return () => {lifetime.current++; release();};
  }, [accept, bridge]);
  useEffect(() => {
    if (readyNotice === null || blocked) return;
    const clear = setTimeout(() => setReadyNotice(null), 7000);
    return () => clearTimeout(clear);
  }, [blocked, readyNotice]);

  async function run(control: Control, request: () => Promise<DesktopUpdateView>, completed?: (next: DesktopUpdateView) => void) {
    if (blocked || flights.current.has(control)) return;
    const owner = lifetime.current;
    flights.current.add(control);
    setPending(new Set(flights.current));
    setFeedback(null);
    try {
      const next = await request();
      if (lifetime.current === owner && next.revision >= seen.current.revision) {
        accept(next);
        completed?.(next);
      }
    } catch (error) {
      if (lifetime.current === owner && opened.current) setFeedback(failureMessage(control, error));
    } finally {
      flights.current.delete(control);
      if (lifetime.current === owner) setPending(new Set(flights.current));
    }
  }
  const show = () => {if (!blocked) changeOpen(true);};
  const install = (mode: 'now' | 'on-quit') => {
    if (!bridge || view?.state.kind !== 'ready') return;
    const {version} = view.state.offer;
    void run('install', () => bridge.install(version, mode, mode === 'now' && view.activity.exports), next => {
      if (mode === 'on-quit' && next.state.kind === 'ready' && next.state.offer.version === version && next.state.installOnQuit) changeOpen(false);
    });
  };
  const state = view?.state;
  const visible = !blocked && state?.kind !== 'disabled';
  return <UpdatePresentation.Provider value={{view, open: show}}>
    {children}
    {visible && bridge && view && open && <DesktopUpdateDialog view={view} feedback={feedback} pending={pending}
      dismiss={reason => {if (state?.kind === 'ready' && reason === 'escape-key') install('on-quit'); else changeOpen(false);}}
      check={() => {void run('check', () => bridge.check());}}
      download={version => {void run('download', () => bridge.download(version));}}
      cancel={() => {void run('cancel', () => bridge.cancel());}}
      install={install} />}
    {visible && state?.kind === 'ready' && readyNotice !== null && <WorkbenchToastRegion label={t('desktopUpdate.badgeReady')}>
      <WorkbenchToast data-testid="desktop-update-ready-toast" className="desktop-update-toast">
        <CircleCheck size={17} aria-hidden="true" /><span>{t('desktopUpdate.ready', {version: state.offer.version})}</span>
        <WorkbenchButton size="compact" onClick={show}>{t('desktopUpdate.badgeReady')}</WorkbenchButton>
        <WorkbenchButton size="compact" variant="icon" aria-label={t('common.close')} onClick={() => setReadyNotice(null)}><X size={14} aria-hidden="true" /></WorkbenchButton>
      </WorkbenchToast>
    </WorkbenchToastRegion>}
  </UpdatePresentation.Provider>;
}

interface DialogProps {
  readonly view: DesktopUpdateView;
  readonly feedback: Feedback | null;
  readonly pending: ReadonlySet<Control>;
  dismiss(reason?: string): void;
  check(): void;
  download(version: string): void;
  cancel(): void;
  install(mode: 'now' | 'on-quit'): void;
}

export function DesktopUpdateDialog({view, feedback, pending, dismiss, check, download, cancel, install}: DialogProps) {
  const {t, formatDate} = useI18n();
  const safeFocus = useRef<HTMLButtonElement>(null);
  const {state, activity} = view;
  let title: string;
  let description: string | undefined;
  let icon: ReactNode, body: ReactNode, buttons: ReactNode;
  const website = <WorkbenchButton nativeButton={false} render={<a href={`${DESKTOP_UPDATE_RELEASES}/latest`} target="_blank" rel="noreferrer" />} data-testid="desktop-update-website">{t('desktopUpdate.website')}</WorkbenchButton>;

  switch (state.kind) {
    case 'available': {
      const {offer} = state, url = fullNotesUrl(offer.version);
      const date = offer.releaseDate && Number.isFinite(Date.parse(offer.releaseDate)) ? formatDate(offer.releaseDate, {month: 'long', day: 'numeric'}) : undefined;
      const size = offer.sizeBytes === undefined ? undefined : `${megabytes(offer.sizeBytes)} MB`;
      title = t('desktopUpdate.available', {version: offer.version});
      description = [t('desktopUpdate.current', {version: view.currentVersion}), date && t('desktopUpdate.releaseDate', {date}),
        size && t('desktopUpdate.packageSize', {size})].filter(Boolean).join(' · ');
      icon = <Icon name="download" size={19} />;
      body = <div className="desktop-update-details">
        <strong>{t('desktopUpdate.notes')}</strong>
        {offer.notes.length > 0 && <ul>{offer.notes.slice(0, 3).map((note, index) => <li key={index}>{note}</li>)}</ul>}
        {url && <a href={url} target="_blank" rel="noreferrer" data-testid="desktop-update-full-notes">{t('desktopUpdate.fullNotes')} <ArrowUpRight size={13} aria-hidden="true" /></a>}
      </div>;
      buttons = <><WorkbenchButton ref={safeFocus} onClick={() => dismiss()}>{t('desktopUpdate.later')}</WorkbenchButton>
        <WorkbenchButton variant="primary" loading={pending.has('download')} onClick={() => download(offer.version)}>{t('desktopUpdate.download')}</WorkbenchButton></>;
      break;
    }
    case 'downloading': {
      const {offer, percent, secondsRemaining, transferredBytes, totalBytes} = state;
      title = t('desktopUpdate.downloading', {version: offer.version});
      icon = <Icon name="download" size={19} />;
      const progress = percentLabel(percent);
      const amount = transferredBytes !== undefined && totalBytes !== undefined
        ? t('desktopUpdate.downloadBytes', {transferred: megabytes(transferredBytes), total: megabytes(totalBytes)}) : undefined;
      const remaining = secondsRemaining === null ? null : secondsRemaining < 60
        ? t('desktopUpdate.seconds', {count: Math.ceil(secondsRemaining)}) : t('desktopUpdate.minutes', {count: Math.ceil(secondsRemaining / 60)});
      body = <><WorkbenchProgress value={percent} label={title} /><div className="desktop-update-progress-details">
        <span>{amount ? `${amount} · ${progress}` : progress}</span>{remaining && <span>{remaining}</span>}</div></>;
      buttons = <><WorkbenchButton loading={pending.has('cancel')} onClick={cancel}>{t('desktopUpdate.cancelDownload')}</WorkbenchButton>
        <WorkbenchButton ref={safeFocus} onClick={() => dismiss()}>{t('desktopUpdate.backgroundDownload')}</WorkbenchButton></>;
      break;
    }
    case 'ready':
      title = t('desktopUpdate.ready', {version: state.offer.version});
      icon = <RefreshCw size={20} aria-hidden="true" />;
      body = activity.exports && <div className="desktop-update-details desktop-update-activity">
        <p><AlertTriangle size={16} aria-hidden="true" />{t('desktopUpdate.exportWarning')}</p>
      </div>;
      buttons = <><WorkbenchButton ref={safeFocus} disabled={pending.has('install')} onClick={() => install('on-quit')}>{t('desktopUpdate.installOnQuit')}</WorkbenchButton>
        <WorkbenchButton variant="primary" disabled={pending.has('install')} onClick={() => install('now')}>
          {t(activity.exports ? 'desktopUpdate.restartAnyway' : 'desktopUpdate.restart')}
        </WorkbenchButton></>;
      break;
    case 'failed':
      title = t(state.stage === 'check' ? 'desktopUpdate.checkFailed' : 'desktopUpdate.downloadFailed');
      description = t(state.stage === 'check' ? 'desktopUpdate.checkFailedBody' : 'desktopUpdate.downloadFailedBody');
      icon = <CircleAlert size={18} aria-hidden="true" />;
      buttons = <>{website}<WorkbenchButton ref={safeFocus} variant="primary" loading={pending.has(state.stage)}
        onClick={() => state.stage === 'check' ? check() : download(state.offer.version)}>{t('desktopUpdate.retry')}</WorkbenchButton></>;
      break;
    case 'checking':
      title = t('desktopUpdate.checking');
      icon = <RefreshCw size={18} aria-hidden="true" />;
      break;
    case 'idle':
      title = t('desktopUpdate.latest');
      icon = <CircleCheck size={18} aria-hidden="true" />;
      buttons = <WorkbenchButton ref={safeFocus} variant="primary" onClick={() => dismiss()}>{t('desktopUpdate.ok')}</WorkbenchButton>;
      break;
    case 'disabled':
      return null;
  }

  return <Dialog open onOpenChange={(next, details) => {
    if (next) return;
    if (details.reason === 'escape-key') details.event.stopPropagation();
    if (!pending.has('install')) dismiss(details.reason);
  }}>
    <WorkbenchDialogContent showCloseButton={false} initialFocus={safeFocus} className="desktop-update-dialog" data-update-state={state.kind}
      title={<><span className="desktop-update-dialog-icon">{icon}</span>{title}</>} description={description}
      footer={buttons} data-testid="desktop-update-dialog">
      {body}{feedback && state.kind !== 'failed' && <WorkbenchAlert tone="danger">{t(`desktopUpdate.${feedback}`)}</WorkbenchAlert>}
    </WorkbenchDialogContent>
  </Dialog>;
}
