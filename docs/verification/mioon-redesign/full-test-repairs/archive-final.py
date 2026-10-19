from pathlib import Path
import json,hashlib,shutil,re,subprocess,datetime
r=Path('/private/tmp/mioon-full-recheck-_m5c6umh');w=Path('/Users/kouzen/.codex/worktrees/mioon-redesign/mioon');d=w/'docs/verification/mioon-redesign/full-test-repairs'
load=lambda p:json.loads(p.read_text())
save=lambda p,x:p.write_text(json.dumps(x,ensure_ascii=False,indent=2)+'\n')
a=load(r/'final-full/results.json');manifest=load(r/'final-full/manifest.json');assert len(a)==len(manifest['files'])==755
assert set(x['file'] for x in a)==set(manifest['files'])
base=load(w/'docs/verification/mioon-redesign/baseline-results.json');b={x['file']:x for x in base};by={x['file']:x for x in a}
failed=[x for x in a if x['exitCode']];passed=[x for x in a if not x['exitCode']]
summary={'files':len(a),'passedFiles':len(passed),'failedFiles':len(failed),'timeoutFiles':sum(x['timeout'] for x in a),'testTotals':{k:sum(x['tapSummary'].get(k) or 0 for x in a) for k in ['tests','pass','fail','cancelled','skipped','todo']}}
comparison={'baselineFiles':len(base),'baselinePassedFiles':sum(not x['exitCode'] for x in base),'baselineFailedFiles':sum(bool(x['exitCode']) for x in base),'currentFiles':len(a),'newFiles':[x['file'] for x in a if x['file'] not in b],'missingBaselineFiles':[f for f in b if f not in by],'baselineFailedNowPassing':[x['file'] for x in passed if b.get(x['file'],{}).get('exitCode')],'baselinePassedNowFailing':[x['file'] for x in failed if x['file'] in b and not b[x['file']]['exitCode']],'newFileFailures':[x['file'] for x in failed if x['file'] not in b],'baselineFailedStillFailing':[x['file'] for x in failed if b.get(x['file'],{}).get('exitCode')],'warning':'File-level baseline failure is not evidence of an identical root cause; failed-subtest and diagnostic comparisons are separate'}
for p in (r/'final-full').iterdir():
 if p.is_file() and p.suffix in ['.log','.json']:
  (d/'final-full').mkdir(exist_ok=True);shutil.copy2(p,d/'final-full'/p.name)
shutil.copy2(r/'logs/final-full-progress.log',d/'logs/final-full-progress.log')
save(d/'test-results.json',a);save(d/'baseline-comparison.json',comparison)
triage=load(r/'triage-discovery-business.json');biz={x['file']:x for x in triage['files']}
uiPath=r/'triage-discovery-ui.json';ui=load(uiPath) if uiPath.exists() else None
if ui:
 shutil.copy2(uiPath,d/uiPath.name)
 items=ui.get('files',[]) if isinstance(ui,dict) else ui
 uim={x['file']:x for x in items}
else:uim={}
rawBase=Path('/private/var/folders/sn/js11_0t91mg_bf1m2fr_38780000gn/T/mioon-design-baseline-ic44qxmj/logs')
baselineLogs={m.group(1):p for p in rawBase.glob('*.log') if (m:=re.fullmatch(r'\d+-(.+\.test\.mjs)\.log',p.name))}
assert len(baselineLogs)==718
remaining=[]
for x in failed:
 name=Path(x['file']).name;p=baselineLogs.get(name);oldtext=p.read_text(errors='replace') if p else ''
 oldnames=re.findall(r'^\s*not ok \d+ - (.*)$',oldtext,re.M);newnames=x['failedSubtests']
 baselineLog=None
 if p:
  (d/'baseline-failed-logs').mkdir(exist_ok=True);shutil.copy2(p,d/'baseline-failed-logs'/p.name);baselineLog={'path':'baseline-failed-logs/'+p.name,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()}
 text=(r/x['log']).read_text(errors='replace');errors=[]
 for lineNum,line in enumerate(text.splitlines(),1):
  if re.search(r'^\s*(?:error|code|failureType):|^\s*not ok \d+ - ',line):errors.append({'line':lineNum,'text':line.strip()})
 q=biz.get(x['file']);u=uim.get(x['file'])
 remaining.append({'file':x['file'],'finalResult':x,'baselineResult':b.get(x['file']),'baselineLog':baselineLog,'failedSubtestComparison':{'baseline':oldnames,'current':newnames,'addedNames':sorted(set(newnames)-set(oldnames)),'removedNames':sorted(set(oldnames)-set(newnames)),'sameNames':sorted(set(newnames)&set(oldnames))},'finalDirectEvidenceLines':errors,'discoveryBusinessReview':q,'discoveryUiReview':u,'classificationScope':'Review describes the discovery snapshot; final TAP, source identity and subtest-name deltas are explicit and authoritative. Generic media wrappers remain unconfirmed unless diagnostic evidence establishes the cause.'})
save(d/'remaining-failures.json',remaining)
originalNames=['cli-v4','export-settings-media','integration','local-drafts-transports','mcp','reference-recovery-transports','timeline-image-transports','timeline-mcp','timeline-media','timeline-recovery-transports']
targets=[by['tests/'+n+'.test.mjs'] for n in originalNames]
targetSummary={'files':10,'passedFiles':sum(not x['exitCode'] for x in targets),'failedFiles':sum(bool(x['exitCode']) for x in targets),'testTotals':{k:sum(x['tapSummary'].get(k) or 0 for x in targets) for k in ['tests','pass','fail','cancelled','skipped','todo']},'results':targets}
save(d/'original-ten-results.json',targetSummary)
frozen=load(r/'final-source-hashes.json');mismatch=[]
for x in frozen:
 for label,where in [('worktree',w),('verify',r/'verify')]:
  p=where/x['file'];actual=hashlib.sha256(p.read_bytes()).hexdigest() if p.is_file() else None
  if actual!=x['sha256']:mismatch.append({'location':label,'file':x['file'],'expected':x['sha256'],'actual':actual})
sourceMap={x['file']:x['sha256'] for x in frozen};executionMismatch=[x['file'] for x in a if x['sourceSha256']!=sourceMap.get(x['file'])]
launchMap={x['file']:x['sha256'] for x in load(r/'final-source-hashes-at-launch.json')}
launchChanges=[f for f,h in sourceMap.items() if h!=launchMap.get(f)]
assert launchChanges==['tests/workspace-restore-local-execution.test.mjs']
audit=load(r/'pre-final-audit.json');audit.update({'frozenSourceFiles':len(frozen),'frozenSourceMismatches':mismatch,'executedTestSourceMismatches':executionMismatch,'all755FilesPresentExactlyOnce':len(a)==len(set(x['file'] for x in a))==755,'allLogHashesMatch':all(hashlib.sha256((d/x['log']).read_bytes()).hexdigest()==x['sha256'] for x in a),'lateStandaloneTestSync':load(r/'late-test-only-sync.json'),'productionAndSharedHelpersUnchangedDuringFinalRun':all(f.startswith('tests/') and '/helpers/' not in f for f in launchChanges),'sourceChangesAfterLaunch':launchChanges})
assert not mismatch and not executionMismatch and audit['allLogHashesMatch']
save(d/'audit.json',audit)
v={'task':'remaining ten failures and complete verification','timestampUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'platform':'Darwin arm64','nodeVersion':'v26.9.0','pnpmVersion':'11.25.0','ffmpegVersion':'9.0.2','final':summary,'originalTen':targetSummary,'commands':load(r/'commands-final-frozen.json'),'baselineComparison':comparison,'allTestsPassed':not failed,'officialMacFullPassed':False,'linuxReleaseGateRun':False,'browserOrNativeVisualAcceptanceRepeated':False,'productionFilesChanged':7,'sourceAndTestFilesChanged':62,'dependenciesChanged':False,'commitOrPush':False,'realProviderCalls':False}
save(d/'verification.json',v)
heading='# 剩余十个失败文件的修复与完整复验\n\n'
heading+=f"原10个文件中 **{targetSummary['passedFiles']}个通过、{targetSummary['failedFiles']}个仍受真实媒体环境限制**，合计{targetSummary['testTotals']['tests']}项：{targetSummary['testTotals']['pass']}通过、{targetSummary['testTotals']['fail']}失败。\n\n"
heading+=f"最终完整逐文件复验 **{summary['files']}个文件，{summary['passedFiles']}通过、{summary['failedFiles']}失败、{summary['timeoutFiles']}超时**；共{summary['testTotals']['tests']}项，{summary['testTotals']['pass']}通过、{summary['testTotals']['fail']}失败、{summary['testTotals']['skipped']}跳过、{summary['testTotals']['cancelled']}取消。完整套件尚未全绿，见[最终结果](test-results.json)及[剩余失败](remaining-failures.json)。\n\n"
heading+=f"旧基线718文件中135失败；本轮有{len(comparison['baselineFailedNowPassing'])}个旧失败文件通过、{len(comparison['baselineFailedStillFailing'])}个仍失败，{len(comparison['baselinePassedNowFailing'])}个原通过文件现失败；新增{len(comparison['newFiles'])}文件中{len(comparison['newFileFailures'])}失败。[文件与子项对照](baseline-comparison.json)和剩余失败报告分开记录，文件原先失败不表示本次错误根因相同。\n\n"
if comparison['baselinePassedNowFailing']==['tests/subject-video-provider.test.mjs']:
 heading+='唯一原通过现失败的文件为`subject-video-provider.test.mjs`：保留真实Mock成功断言，按已就绪/未取消任务的唯一失败分支推断为缺drawtext；该TAP未直接打印错误码，实测能力诊断另存，不把推断写成直接观测。\n\n'
heading+='类型检查、development构建及portable **97/97**通过；正式macOS full入口退出2并报告NATIVE_TEST_LANE_BLOCKED，未记为通过。\n\n'
heading+='## 原十文件\n\n| 文件 | 最终子项 | 结果 |\n| --- | --- | --- |\n'
for x in targets:
 s=x['tapSummary'];label='通过' if not x['exitCode'] else '媒体环境受阻；保留失败断言'
 heading+=f"| `{Path(x['file']).name}` | {s['pass']}/{s['tests']} | {label} |\n"
heading+='\n[原十文件完整结果](original-ten-results.json)含每项失败名、最终源码与TAP hash。六个失败文件的具体首因及级联说明见[环境记录](ENVIRONMENT.md)，未增加skip或伪造渲染成功。\n\n'
heading+=(r/'report-body.md').read_text()
heading+='\n旧26草稿备份回归覆盖缺失目标但保留源媒体，不能外推为活跃26时间线的完整备份验收。恢复摘要实际覆盖25/41/49代表版本，未逐个重跑全部历史schema。\n'
(d/'README.md').write_text(heading)
md='# 最终剩余失败索引\n\n详细子项、错误位置、旧基线差异与探索轮只读审查见[JSON](remaining-failures.json)。通用媒体包装错误保持待确认；旧夹具/冻结目录证据不等同已修复。\n\n| 文件 | 通过/总数 | 基线文件结果 | 最终日志 |\n| --- | --- | --- | --- |\n'
for x in failed:
 s=x['tapSummary'];old=b.get(x['file']);state='失败' if old and old['exitCode'] else ('通过' if old else '无旧文件')
 md+=f"| `{Path(x['file']).name}` | {s['pass']}/{s['tests']} | {state} | [TAP]({x['log']}) |\n"
(d/'remaining-failures.md').write_text(md)
print(json.dumps({'summary':summary,'baselineComparison':{k:v for k,v in comparison.items() if not isinstance(v,list)} ,'newlyFailing':comparison['baselinePassedNowFailing'],'fixedOldFiles':len(comparison['baselineFailedNowPassing']),'originalTen':{k:v for k,v in targetSummary.items() if k!='results'},'auditOk':not mismatch and not executionMismatch},ensure_ascii=False,indent=2))
