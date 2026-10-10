import React, { useState } from 'react';
import { Button } from '@mioon/ui/components/button';
import { Input } from '@mioon/ui/components/input';
import { Label } from '@mioon/ui/components/label';
import { ScrollArea } from '@mioon/ui/components/scroll-area';
import { WorkbenchSelect } from './WorkspaceControls.jsx';
import { assetUrl } from './api.js';
import { subjectKinds, subjectKindLabel, subjectImage, filterSubjects, activeSubjectBindings } from './subject-state.js';
import { useSubjectInteraction } from './use-subjects.js';
import './subjects.css';

export function SubjectImage({ version, assets, label = '' }) {
  const asset = assets.find(item => item.id === version?.assetId && item.projectId === version.projectId);
  const [failed, setFailed] = useState(null);
  if (!version || !asset || failed === version.assetId) return <span className="subject-image-missing" role="status">{version ? '原图片未加载或已缺失' : '版本尚未加载'}</span>;
  return <img className="subject-image" src={assetUrl(asset)} alt={label || asset.name} loading="lazy" onError={() => setFailed(version.assetId)} />;
}
export function SubjectNotice({ state, onShowTasks, admit = action => action() }) {
  return <>{state?.mutationError && <p className="subject-warning" role="alert">{state.mutationError}</p>}{state?.uncertain && <div className="subject-warning" role="status"><p>有主体修改待确认，原请求保留在任务中心。</p><Button variant="ghost" size="sm" onClick={() => admit(() => onShowTasks?.())}>查看原请求</Button></div>}</>;
}
export function SubjectPager({ entry, onPage, disabled, label = '主体' }) {
  return <div className="subject-pagination" aria-label={`${label}分页`}><Button variant="ghost" size="sm" disabled={disabled || !entry?.history?.length} onClick={() => onPage('previous')}>上一页</Button><span>第 {(entry?.history?.length || 0) + 1} 页 · 本页 {entry?.items.length || 0}</span><Button variant="ghost" size="sm" disabled={disabled || !entry?.nextCursor} onClick={() => onPage('next')}>下一页</Button></div>;
}
function ImageChoice({ id, value, assets, disabled, onChange }) {
  const missing = Boolean(value && !assets.some(asset => asset.id === value));
  return <><WorkbenchSelect id={id} data-testid={id} value={value} disabled={disabled} onChange={event => onChange(event.target.value)}><option value="">选择一张已导入图片</option>{missing && <option value={value} disabled>已选图片未加载或已缺失</option>}{assets.map(asset => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</WorkbenchSelect>{missing && <p className="subject-warning" role="status">已选图片不可用，请明确选择另一张图片。</p>}</>;
}

export default function SubjectLibrary({ subjects, assets = [], shots = [], blocked = false, onShowTasks, onInspectShot }) {
  const state = subjects?.state, controller = subjects?.controller;
  const [filters, setFilters] = useState({ scope: null, kind: 'all', search: '' });
  const [creation, setCreation] = useState({ scope: null, open: false });
  const local = filters.scope === state?.scope ? filters : { kind: 'all', search: '' };
  const selected = state?.subjects[state.selectedSubjectId], draft = state?.createDraft;
  const interaction = useSubjectInteraction(state?.scope, controller, `${state?.selectedSubjectId}:${draft?.serial}:${state?.versionDrafts[state?.selectedSubjectId]?.assetId || ''}:${state?.versionDrafts[state?.selectedSubjectId]?.expectedRevision || ''}`);
  const admit = interaction.admit, scope = state?.scope;
  const disabled = !interaction.visible || !scope || blocked || Boolean(state?.saving || state?.uncertain);
  const images = assets.filter(asset => subjectImage(asset, state?.projectId));
  const visible = filterSubjects(state?.list.items || [], local), versions = selected && state.versions[selected.id], uses = selected && state.uses[selected.id];
  const versionDraft = selected && state.versionDrafts[selected.id];
  const createOpen = creation.scope === scope && creation.open || Boolean(draft?.name || draft?.assetId || draft?.kind !== 'character' && draft?.kind);
  const changeFilter = patch => admit(() => setFilters({ scope, ...local, ...patch }));
  const reset = () => admit(() => { setFilters({ scope, kind: 'all', search: '' }); void controller.subjectPage('first', scope); });
  const staleVersionDraft = Boolean(versionDraft?.assetId && versionDraft.expectedRevision !== selected?.revision);
  return <section className="subject-library" data-testid="subject-library" aria-label="本地主体库">
    <div className="subject-library-toolbar"><Button variant="outline" size="sm" disabled={disabled} data-testid="subject-new" onClick={() => admit(() => setCreation({ scope, open: !createOpen }))}>新建主体</Button><Button variant="ghost" size="sm" disabled={!interaction.visible || !scope || Boolean(state?.saving) || state?.list.phase === 'loading'} onClick={() => admit(() => controller.read())}>刷新</Button><Button variant="ghost" size="sm" disabled={!interaction.visible || !scope} onClick={reset}>全部 / 重置</Button></div>
    <p className="subject-local-note">本地策划关联，尚不作为生成输入</p>
    <div className="subject-search"><Input aria-label="搜索本页主体" placeholder="搜索本页主体…" value={local.search} disabled={!interaction.visible} onChange={event => changeFilter({ search: event.target.value })} /><WorkbenchSelect aria-label="主体类型筛选" value={local.kind} disabled={!interaction.visible} onChange={event => changeFilter({ kind: event.target.value })}><option value="all">全部类型</option>{subjectKinds.map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}</WorkbenchSelect></div>
    <SubjectPager entry={state?.list} disabled={!interaction.visible || !scope || state?.list.phase === 'loading'} onPage={direction => admit(() => controller.subjectPage(direction, scope))} />
    <ScrollArea className="subject-scroll-area"><div className="subject-library-scroll">
      <SubjectNotice state={state} onShowTasks={onShowTasks} admit={admit} />
      {createOpen && draft && <section className="subject-form" aria-label="新建主体"><h3>从一张图片建立主体</h3><Label htmlFor="subject-name">名称</Label><Input id="subject-name" data-testid="subject-name" value={draft.name} maxLength={120} disabled={disabled} onChange={event => admit(() => controller.updateCreate({ name: event.target.value }, scope))} /><Label htmlFor="subject-kind">类型</Label><WorkbenchSelect id="subject-kind" value={draft.kind} disabled={disabled} onChange={event => admit(() => controller.updateCreate({ kind: event.target.value }, scope))}>{subjectKinds.map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}</WorkbenchSelect><Label htmlFor="subject-create-image">第一版图片</Label><ImageChoice id="subject-create-image" value={draft.assetId} assets={images} disabled={disabled} onChange={assetId => admit(() => controller.updateCreate({ assetId }, scope))} />{draft.assetId && <SubjectImage version={{ assetId: draft.assetId, projectId: state.projectId }} assets={assets} label="新主体已选图片" />}{!images.length && <p className="subject-empty">请先在素材页导入 PNG、JPEG 或 WebP 图片。</p>}<p className="subject-helper">名称和类型创建后保留。后续换图会追加版本。</p><div className="subject-actions"><Button size="sm" data-testid="subject-create" disabled={disabled || !draft.name.trim() || !images.some(asset => asset.id === draft.assetId)} onClick={() => admit(() => controller.create(scope))}>{state.saving === 'subject.create' ? '正在创建…' : '创建 V1'}</Button><Button variant="ghost" size="sm" disabled={Boolean(state.saving) || !interaction.visible} onClick={() => admit(() => { controller.resetCreate(scope); setCreation({ scope, open: false }); })}>放弃草稿</Button></div></section>}
      {state?.list.phase === 'loading' && <p role="status">正在读取主体，本页状态待核对…</p>}
      {state?.list.phase === 'error' && <p className="subject-warning" role="alert">{state.list.error} 上次读取的项目仅供查看。</p>}
      {state?.list.phase === 'ready' && !visible.length && <p className="subject-empty">{state.list.items.length ? '本页没有匹配的主体。可重置筛选或翻页。' : '还没有主体。用已导入的图片建立角色、产品、场景或风格。'}</p>}
      <div className="subject-cards">{visible.map(subject => <Button variant="ghost" key={subject.id} className={`subject-card ${selected?.id === subject.id ? 'selected' : ''}`} data-testid={`subject-card-${subject.id}`} aria-pressed={selected?.id === subject.id} disabled={!interaction.visible || state.list.phase !== 'ready'} onClick={() => admit(() => controller.selectSubject(subject.id, scope))}><SubjectImage version={subject.headVersion} assets={assets} label={subject.name} /><span><strong>{subject.name}</strong><small>{subjectKindLabel(subject.kind)} · V{subject.headVersion.number}</small></span></Button>)}</div>
      {selected && <section className="subject-detail" aria-label={`${selected.name} 的主体版本`}><header><div><h3>{selected.name}</h3><p>{subjectKindLabel(selected.kind)} · 当前 V{selected.headVersion.number}</p></div></header>{!visible.some(item => item.id === selected.id) && <p className="subject-helper">当前主体不在本页筛选中，详情与草稿仍保留。</p>}
        <div className="subject-form"><Label htmlFor="subject-version-image">追加图片版本</Label><ImageChoice id="subject-version-image" value={versionDraft?.assetId || ''} assets={images} disabled={disabled || state?.list.phase !== 'ready'} onChange={assetId => admit(() => controller.updateVersion(selected.id, assetId, scope))} />{versionDraft?.assetId && <SubjectImage version={{ assetId: versionDraft.assetId, projectId: state.projectId }} assets={assets} label="追加版本已选图片" />}{staleVersionDraft && <p className="subject-warning" role="alert">主体已更新。草稿图片仍保留，请重新确认图片后追加。</p>}<div className="subject-actions"><Button size="sm" data-testid="subject-add-version" disabled={disabled || state.list.phase !== 'ready' || staleVersionDraft || !images.some(asset => asset.id === versionDraft?.assetId)} onClick={() => admit(() => controller.addVersion(selected.id, scope))}>追加新版本</Button>{versionDraft?.assetId && <Button variant="ghost" size="sm" disabled={disabled} onClick={() => admit(() => controller.updateVersion(selected.id, '', scope))}>放弃换图</Button>}</div><p className="subject-helper">旧版本与镜头固定关联会保留。使用中的镜头需要逐个确认新版本。</p></div>
        <h4>图片版本</h4>{versions?.phase === 'loading' && <p role="status">正在读取版本…</p>}{versions?.phase === 'error' && <p role="alert" className="subject-warning">{versions.error}</p>}<div className="subject-version-grid">{(versions?.items || []).map(version => <div key={version.id} className="subject-version"><SubjectImage version={version} assets={assets} label={`${selected.name} V${version.number}`} /><strong>V{version.number}{version.id === selected.headVersionId ? ' · 当前' : ''}</strong><span>{version.width} × {version.height}</span></div>)}</div><SubjectPager label="主体版本" entry={versions} disabled={!interaction.visible || versions?.phase !== 'ready'} onPage={direction => admit(() => controller.versionPage(selected.id, direction, scope))} />
        <h4>使用此主体的镜头</h4>{uses?.phase === 'loading' && <p role="status">正在读取镜头关联…</p>}{uses?.phase === 'error' && <p role="alert" className="subject-warning">{uses.error}</p>}{uses?.phase === 'ready' && !activeSubjectBindings(uses).length && <p className="subject-helper">已读取的关联中没有使用镜头。</p>}{activeSubjectBindings(uses).map(binding => { const shot = shots.find(item => item.id === binding.shotId); return <div className="subject-use" key={binding.id}><span>{shot?.title || '镜头未加载'}{binding.needsReview ? ' · 待复核' : ' · 已固定版本'}</span><Button variant="ghost" size="sm" disabled={!interaction.visible || !shot || !onInspectShot} onClick={() => admit(() => onInspectShot?.(binding.shotId))}>查看镜头</Button></div>; })}{uses?.nextCursor && <Button variant="ghost" size="sm" disabled={!interaction.visible || uses.phase !== 'ready'} onClick={() => admit(() => controller.readUses(selected.id, scope, true))}>读取更多关联</Button>}
      </section>}
    </div></ScrollArea>
  </section>;
}
