"""Package reproducible source, synthetic samples and selected acceptance evidence."""
import pathlib, shutil, json, hashlib, zipfile
root=pathlib.Path(__file__).resolve().parents[1];target=root/'deliverables/staging/video-workbench';target.mkdir(parents=True,exist_ok=True)
def copy(relative):
    src=root/relative;dst=target/relative
    if src.is_dir():shutil.copytree(src,dst,dirs_exist_ok=True,ignore=shutil.ignore_patterns('__pycache__','access-token','server.lock','*.sqlite-wal','*.sqlite-shm'))
    else:dst.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(src,dst)
for item in ['package.json','package-lock.json','index.html','vite.config.mjs','.gitignore','.env.example','README.md','PLAN.md','STATUS.md','server','src','docs','tests','examples','dist'] :copy(item)
for item in ['scripts/doctor.mjs','scripts/demo.mjs']:copy(item)
for item in ['evidence/final-tests.tap','evidence/final-build.log','evidence/runtime.json','evidence/demo.json','evidence/demo-ffprobe.json','evidence/demo-generation.log','evidence/clean-install','evidence/integration/acceptance.json','evidence/integration/export-probe.json','evidence/integration/three-shot-portrait.mp4','evidence/mcp-demo','evidence/source','evidence/verification-summary.json']:copy(item)
for name in ['steps.json','browser-errors.json','project-state.json','A1-empty-workbench.png','A3-mcp-project-in-ui.png','A6-version-comparison.png','A7-unknown-submission.png','A8-export-ready.png','A10-media-canvas.png','M3-story-demo.png','browser-export-portrait.mp4']:copy('evidence/browser/'+name)
copy('evidence/browser-run.log')
files=[]
for p in sorted(target.rglob('*')):
    if p.is_file() and p.name!='MANIFEST.json':
        if p.name in ['access-token','server.lock'] or p.name.endswith(('.sqlite-wal','.sqlite-shm')):raise RuntimeError('Unexpected runtime/auth file')
        files.append({'path':str(p.relative_to(target)),'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()})
manifest={'name':'video-workbench','version':'0.1.0','liveProviderVerified':False,'acceptance':{'A1':'PASS','A2':'PASS','A3':'PASS','A4':'PASS','A5':'PASS','A6':'PASS','A7':'PASS','A8':'PASS','A9':'BLOCKED / 待真实验证','A10':'PASS'},'files':files}
(target/'MANIFEST.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2))
output=root/'deliverables/video-workbench-M0-M3.zip'
with zipfile.ZipFile(output,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
    for p in sorted(target.rglob('*')):
        if p.is_file():z.write(p,pathlib.Path('video-workbench')/p.relative_to(target))
shutil.copy2(root/'evidence/browser/A10-media-canvas.png',root/'deliverables/workbench-preview.png')
print(json.dumps({'zip':str(output),'bytes':output.stat().st_size,'sha256':hashlib.sha256(output.read_bytes()).hexdigest(),'files':len(files)+1},indent=2))
