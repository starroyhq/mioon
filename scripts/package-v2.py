"""Build a new V2 delivery without modifying any original V1 deliverable."""
import pathlib,shutil,json,hashlib,zipfile,tempfile
root=pathlib.Path(__file__).resolve().parents[1]
staging=pathlib.Path(tempfile.mkdtemp(prefix='v2-package-',dir=root/'.verification'))
target=staging/'video-workbench';target.mkdir()
def copy(relative):
    src=root/relative;dst=target/relative
    if not src.exists():raise RuntimeError('Missing deliverable input: '+relative)
    if src.is_dir():shutil.copytree(src,dst,ignore=shutil.ignore_patterns('__pycache__','access-token','server.lock','*.sqlite-wal','*.sqlite-shm'))
    else:dst.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(src,dst)
for relative in ['package.json','package-lock.json','index.html','vite.config.mjs','.gitignore','.env.example','README.md','PLAN.md','STATUS.md','src','server','docs','tests','examples','dist']:
    copy(relative)
for relative in ['scripts/doctor.mjs','scripts/demo.mjs','scripts/create-demo-bundle.mjs','scripts/create-timeline-fixtures.py','scripts/create-timeline-demo.mjs','scripts/stress-timeline.mjs','scripts/verify-v2-relocation.mjs']:
    copy(relative)
for relative in ['evidence/v2-full-tests.tap','evidence/v2-before','evidence/v2-demo','evidence/v2-browser','evidence/v2-v1-browser','evidence/v2-tests','evidence/v2-clean-install','evidence/v2-verification-summary.json','evidence/mcp-demo','evidence/demo.json','evidence/demo-ffprobe.json','evidence/runtime.json']:
    copy(relative)
# Failed exploratory screenshots are intentionally excluded from the final
# acceptance set; exact successful run logs remain. Test assertions are retained.
for file in [target/'evidence/v2-browser/failure.png',target/'evidence/v2-tests/stress/original-invocation.mjs',target/'evidence/v2-tests/media/test-run.log',target/'evidence/v2-clean-install/path.txt']:
    if file.exists():file.unlink()
files=[]
for p in sorted(target.rglob('*')):
    if p.is_file():
        if p.name in ['access-token','server.lock'] or p.name.endswith(('.sqlite-wal','.sqlite-shm')):raise RuntimeError('Forbidden runtime/auth file')
        files.append({'path':str(p.relative_to(target)),'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()})
old=root/'deliverables/video-workbench-M0-M3.zip'
summary=json.loads((root/'evidence/v2-verification-summary.json').read_text())
manifest={'name':'video-workbench','version':'0.2.0','edition':'V2 multitrack workspace','baseArtifact':{'filename':old.name,'sha256':hashlib.sha256(old.read_bytes()).hexdigest(),'modifiedByV2':False},'liveProviderVerified':False,'verification':summary,'files':files}
(target/'MANIFEST.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2))
out=root/'deliverables/video-workbench-v2-multitrack.zip'
with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
    for p in sorted(target.rglob('*')):
        if p.is_file():z.write(p,pathlib.Path('video-workbench')/p.relative_to(target))
with zipfile.ZipFile(out) as z:
    assert z.testzip() is None
    for item in files:
        data=z.read('video-workbench/'+item['path']);assert len(data)==item['bytes'] and hashlib.sha256(data).hexdigest()==item['sha256']
for source,dest in [('evidence/v2-demo/timeline-export.mp4','multitrack-synthetic-10s.mp4'),('evidence/v2-browser/deliverable-region-guide.png','workbench-v2-region-guide.png'),('evidence/v2-browser/deliverable-preview.png','workbench-v2-preview.png'),('evidence/v2-browser/deliverable-canvas.png','workbench-v2-canvas.png'),('docs/WORKSPACE-GUIDE.zh-CN.md','workbench-v2-guide.zh-CN.md')]:shutil.copy2(root/source,root/'deliverables'/dest)
result={'zip':str(out),'bytes':out.stat().st_size,'sha256':hashlib.sha256(out.read_bytes()).hexdigest(),'files':len(files)+1,'allManifestHashesVerified':True,'staging':str(target),'baseArtifactSha256':manifest['baseArtifact']['sha256']}
(root/'deliverables/v2-package-result.json').write_text(json.dumps(result,indent=2));print(json.dumps(result,indent=2))
