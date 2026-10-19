import concurrent.futures,hashlib,json,os,pathlib,re,shutil,signal,subprocess,sys,tempfile,threading,time
root=pathlib.Path('/private/tmp/mioon-full-recheck-_m5c6umh');repo=root/'focus'
group=sys.argv[1];out=root/group;out.mkdir(exist_ok=True)
files=sys.argv[2:] or sorted(str(p.relative_to(repo)) for p in (repo/'tests').glob('*.test.mjs'))
files=[f if f.startswith('tests/') else 'tests/'+f for f in files]
workers=4 if group=='full' else 1
base=json.loads(subprocess.check_output(['node','--input-type=module','-e',"import {toolingEnvironment} from './scripts/lib/local-tooling.mjs';process.stdout.write(JSON.stringify(toolingEnvironment(process.env,{mediaPaths:true})))"],cwd=repo,text=True))
results=[];lock=threading.Lock();startedAll=time.monotonic()
(out/'manifest.json').write_text(json.dumps({'files':files,'concurrency':workers,'timeoutSeconds':900,'separateProcesses':True,'source':'real directory enumeration; no exclusions','nodeFlags':['--test','--test-reporter=tap']},indent=2)+'\n')
def run(item):
 index,file=item;started=time.monotonic();tmp=pathlib.Path(tempfile.mkdtemp(prefix='test-',dir=out)).resolve();env=dict(base,TMPDIR=str(tmp))
 logpath=out/(f'{index:03d}-'+pathlib.Path(file).name+'.log');timedout=False
 with logpath.open('w') as log:
  child=subprocess.Popen(['node','--test','--test-reporter=tap',file],cwd=repo,env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
  try:code=child.wait(timeout=900)
  except subprocess.TimeoutExpired:
   timedout=True;os.killpg(child.pid,signal.SIGTERM)
   try:child.wait(timeout=5)
   except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);child.wait()
   code=124
 content=logpath.read_text(errors='replace');summary={}
 for key in ['tests','suites','pass','fail','cancelled','skipped','todo']:
  matches=re.findall(r'^# '+key+r' (\d+)\s*$',content,re.M)
  summary[key]=int(matches[-1]) if matches else None
 record={'file':file,'exitCode':code,'timeout':timedout,'seconds':round(time.monotonic()-started,2),'tapSummary':summary,'log':str(logpath.relative_to(root)),'sha256':hashlib.sha256(logpath.read_bytes()).hexdigest(),'sourceSha256':hashlib.sha256((repo/file).read_bytes()).hexdigest(),'failedSubtests':re.findall(r'^\s*not ok \d+ - (.*)$',content,re.M)}
 shutil.rmtree(tmp)
 with lock:
  results.append(record);ordered=sorted(results,key=lambda r:r['file']);(out/'results.json').write_text(json.dumps(ordered,indent=2)+'\n')
  progress={'completedFiles':len(results),'totalFiles':len(files),'passedFiles':sum(r['exitCode']==0 for r in results),'failedFiles':sum(r['exitCode']!=0 for r in results),'timeoutFiles':sum(r['timeout'] for r in results),'seconds':round(time.monotonic()-startedAll,2),'last':file}
  (out/'progress.json').write_text(json.dumps(progress,indent=2)+'\n');print(json.dumps(progress),flush=True)
 return record
with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:list(pool.map(run,enumerate(files,1)))
sys.exit(1 if any(r['exitCode'] for r in results) else 0)
