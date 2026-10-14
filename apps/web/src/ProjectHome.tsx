import React, { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Button } from '@mioon/ui/components/button';
import { Input } from '@mioon/ui/components/input';
import { Label } from '@mioon/ui/components/label';
import { Textarea } from '@mioon/ui/components/textarea';

export interface ProjectHomeProject {
  id: string;
  name: string;
  description?: string;
  updatedAt: string;
}

export interface ProjectHomeCreateState {
  readonly dirty: boolean;
  readonly busy: boolean;
  readonly version: number;
}

export interface ProjectHomeProps {
  projects: readonly ProjectHomeProject[];
  phase: 'home' | 'opening' | 'error';
  openingName?: string;
  error?: string;
  notice?: string;
  busy: boolean;
  listBusy: boolean;
  listError?: string;
  page: 'projects' | 'settings';
  onPage: (page: 'projects' | 'settings') => void;
  onOpen: (id: string) => void;
  onRetry: () => void;
  onRefresh: () => void;
  onCreate: (name: string, description: string) => Promise<boolean>;
  settings: ReactNode;
  status?: ReactNode;
  createDisabledReason?: string;
  onCreateStateChange?: (state: ProjectHomeCreateState) => void;
  canMutateEntry?: () => boolean;
  createIntentVersion?: number;
}

function ProjectSymbol({ size = 20 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3V7Z" />
    <path d="M8 12h8M8 15h5" />
  </svg>;
}

function ProjectTime({ value }: { value: string }) {
  const date = new Date(value);
  return <span className="project-home-date"><span>更新时间</span>{Number.isFinite(date.getTime())
    ? <time dateTime={value}>{date.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</time>
    : <span>时间未知</span>}</span>;
}

/** Presentation only. The parent owns project reads, creation, navigation scope,
 * and whether a successful creation may still be accepted by this page. */
export default function ProjectHome({ projects, phase, openingName, error, notice, busy, listBusy, listError,
  page, onPage, onOpen, onRetry, onRefresh, onCreate, settings, status, createDisabledReason = '', onCreateStateChange, canMutateEntry, createIntentVersion = 0 }: ProjectHomeProps) {
  const prefix = useId();
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const submissionPending = useRef(false);
  const current = useRef({ page, phase, busy, listBusy, createOpen, createDisabledReason });
  current.current = { page, phase, busy, listBusy, createOpen, createDisabledReason };
  const createMetadata = useRef({ name: '', description: '', busy: false, version: 0, callback: onCreateStateChange });
  const publishCreate = (patch: Partial<{ name: string; description: string; busy: boolean }> = {}) => {
    Object.assign(createMetadata.current, patch);
    const state = createMetadata.current;
    onCreateStateChange?.(Object.freeze({ dirty: Boolean(state.name || state.description), busy: state.busy, version: ++state.version }));
  };
  if (createMetadata.current.version === 0 || createMetadata.current.callback !== onCreateStateChange) {
    createMetadata.current.callback = onCreateStateChange;
    publishCreate({ name, description, busy: submissionPending.current });
  }
  const locked = busy || submitting || phase === 'opening';
  const empty = !projects.length && !listBusy && !listError;
  const canAct = () => canMutateEntry?.() !== false && current.current.page === 'projects' && !current.current.busy && !submissionPending.current && current.current.phase !== 'opening';

  useEffect(() => { if (createIntentVersion > 0 && canMutateEntry?.() !== false) setCreateOpen(true); }, [createIntentVersion]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canAct() || !current.current.createOpen || current.current.createDisabledReason) return;
    const trimmedName = name.trim(), trimmedDescription = description.trim();
    if (!trimmedName) { setFormError('请填写项目名称。'); return; }
    if (trimmedName.length > 150 || trimmedDescription.length > 2000) {
      setFormError('项目名称最多 150 个字符，创作方向最多 2000 个字符。');
      return;
    }
    // This local latch closes the gap before the parent's busy prop rerenders.
    submissionPending.current = true;
    publishCreate({ busy: true });
    setSubmitting(true);
    setFormError('');
    try {
      const accepted = await onCreate(trimmedName, trimmedDescription);
      if (accepted === true) { publishCreate({ name: '', description: '' }); setName(''); setDescription(''); setCreateOpen(false); }
      else setFormError('输入已保留。请先刷新项目列表核对，再决定是否重新创建。');
    } catch {
      setFormError('新建结果未确认，输入已保留。请先刷新项目列表核对，避免重复创建。');
    } finally {
      submissionPending.current = false;
      publishCreate({ busy: false });
      setSubmitting(false);
    }
  }

  return <div className="project-home" data-testid="project-home" data-phase={phase} data-page={page}>
    <header className="project-home-header">
      <div className="project-home-brand" aria-label="mioon"><span className="project-home-brand-mark"><ProjectSymbol size={20} /></span><span>mioon.</span></div>
      <span className="project-home-header-label">项目首页</span>
      {status && <div className="project-home-status">{status}</div>}
    </header>
    <div className="project-home-layout">
      <nav className="project-home-nav" aria-label="项目入口">
        <Button type="button" variant="ghost" data-testid="project-home-page-projects" aria-current={page === 'projects' ? 'page' : undefined}
          onClick={() => { if (page !== 'projects') onPage('projects'); }}>项目列表</Button>
        <Button type="button" variant="ghost" data-testid="project-home-page-settings" disabled={phase === 'opening'} aria-current={page === 'settings' ? 'page' : undefined}
          onClick={() => { if (current.current.phase !== 'opening' && page !== 'settings') onPage('settings'); }}>连接设置</Button>
      </nav>
      <main className="project-home-main" aria-labelledby={`${prefix}-heading`}>
        {notice && <div className="project-home-notice" role="status">{notice}</div>}
        {phase === 'opening' && <section className="project-home-feedback" data-phase="opening" role="status" aria-live="polite" aria-busy="true">
          <div><strong>正在打开{openingName ? `「${openingName}」` : '项目'}…</strong><p>正在读取项目和视图设置。</p></div>
        </section>}
        {phase === 'error' && <section className="project-home-feedback" data-phase="error" role="alert">
          <div><strong>{openingName ? `无法打开「${openingName}」` : '项目未能打开'}</strong><p>{error || '请重试，或从项目列表选择其他项目。'}</p></div>
          {page === 'projects' && <Button type="button" variant="outline" data-testid="project-home-retry" disabled={busy || submitting}
            onClick={() => { if (canAct() && current.current.phase === 'error') onRetry(); }}>重试打开</Button>}
        </section>}
        {page === 'settings' ? <section className="project-home-settings" data-testid="project-home-settings">
          <header className="project-home-heading"><div><div className="project-home-eyebrow">当前工作区</div><h1 id={`${prefix}-heading`}>连接设置</h1><p>管理当前工作区的全局连接配置。</p></div></header>
          <div className="project-home-settings-body">{settings}</div>
        </section> : <>
          <header className="project-home-heading">
            <div><div className="project-home-eyebrow">当前工作区</div><h1 id={`${prefix}-heading`}>项目列表</h1><p>选择一个项目继续创作，或开始一个新故事。</p></div>
            <Button type="button" data-testid="project-home-create-toggle" disabled={locked || Boolean(createDisabledReason)} aria-expanded={createOpen} aria-controls={`${prefix}-create`}
              onClick={() => { if (canAct() && !current.current.createDisabledReason) { publishCreate(); setCreateOpen(value => !value); } }}>{empty ? '创建第一个项目' : '新建项目'}</Button>
          </header>
          {createDisabledReason && <p className="project-home-notice" role="status" data-testid="project-home-create-disabled">{createDisabledReason}</p>}
          {createOpen && <form id={`${prefix}-create`} className="project-home-create" data-testid="project-home-create-form" onSubmit={create} aria-labelledby={`${prefix}-create-heading`} aria-busy={busy || submitting}>
            <h2 id={`${prefix}-create-heading`}>开始一个新故事</h2>
            <p className="project-home-create-intro">为这次创作命名，创建成功后进入项目。</p>
            <div className="project-home-field"><Label htmlFor={`${prefix}-name`}>项目名称</Label>
              <Input id={`${prefix}-name`} data-testid="project-home-name" value={name} maxLength={150} required autoFocus disabled={locked || Boolean(createDisabledReason)}
                placeholder="例如：山野之间 · 秋日短片" aria-invalid={Boolean(formError) && !name.trim()} aria-describedby={formError ? `${prefix}-form-error` : undefined}
                onChange={event => { if (canAct() && !current.current.createDisabledReason) { publishCreate({ name: event.target.value }); setName(event.target.value); setFormError(''); } }} />
            </div>
            <div className="project-home-field"><Label htmlFor={`${prefix}-description`}>创作方向 <span>可选</span></Label>
              <Textarea id={`${prefix}-description`} data-testid="project-home-description" value={description} rows={3} maxLength={2000} disabled={locked || Boolean(createDisabledReason)}
                placeholder="关于这个故事，你最想表达什么？" onChange={event => { if (canAct() && !current.current.createDisabledReason) { publishCreate({ description: event.target.value }); setDescription(event.target.value); setFormError(''); } }} />
            </div>
            {formError && <p id={`${prefix}-form-error`} className="project-home-form-error" role="alert">{formError}</p>}
            <div className="project-home-form-actions">
              <Button type="button" variant="ghost" data-testid="project-home-create-cancel" disabled={locked} onClick={() => { if (canAct()) setCreateOpen(false); }}>取消</Button>
              <Button type="submit" data-testid="project-home-create-submit" disabled={locked || Boolean(createDisabledReason) || !name.trim()}>{busy || submitting ? '正在创建…' : '创建并打开'}</Button>
            </div>
          </form>}
          <section aria-labelledby={`${prefix}-list-heading`} aria-busy={listBusy}>
            <div className="project-home-list-header"><h2 id={`${prefix}-list-heading`}>{projects.length ? `${projects.length} 个项目 · 按更新时间排列` : '工作区项目'}</h2>
              <Button type="button" variant="ghost" data-testid="project-home-refresh" disabled={listBusy || busy || submitting}
                onClick={() => { if (current.current.page === 'projects' && !current.current.listBusy && !current.current.busy && !submissionPending.current) onRefresh(); }}>{listBusy ? '正在刷新…' : '刷新项目列表'}</Button>
            </div>
            {listError && <p className="project-home-list-error" role="alert">{listError}</p>}
            {listBusy && !projects.length && <p className="project-home-list-loading" role="status">正在读取项目列表…</p>}
            {empty && <div className="project-home-empty" data-testid="project-home-empty">
              <span className="project-home-empty-symbol"><ProjectSymbol size={28} /></span><h2>还没有项目</h2><p>从一个新故事开始。创建项目后，就可以组织镜头、添加素材和剪辑成片。</p>
            </div>}
            {projects.length > 0 && <ul className="project-home-list" data-testid="project-home-list">
              {projects.map(project => <li key={project.id}><article className="project-home-card">
                <span className="project-home-card-symbol"><ProjectSymbol /></span><h3>{project.name}</h3>
                {project.description && <p className="project-home-description">{project.description}</p>}
                <div className="project-home-card-footer"><ProjectTime value={project.updatedAt} /><Button type="button" variant="outline" data-testid={`project-home-open-${project.id}`} aria-label={`打开 ${project.name}`} disabled={locked}
                  onClick={() => { if (canAct()) onOpen(project.id); }}>打开项目</Button></div>
              </article></li>)}
            </ul>}
          </section>
          <p className="project-home-footnote">这里显示当前已连接工作区中的项目。</p>
        </>}
      </main>
    </div>
  </div>;
}
