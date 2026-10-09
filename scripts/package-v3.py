"""Create the V3 source delivery without modifying original V1/V2 artifacts."""
import pathlib, shutil, json, hashlib, zipfile, tempfile
root = pathlib.Path(__file__).resolve().parents[1]
staging = pathlib.Path(tempfile.mkdtemp(prefix='v3-package-', dir=root/'.verification'))
target = staging/'video-workbench'
target.mkdir()
ignored = shutil.ignore_patterns('node_modules', '__pycache__', 'build', 'release', 'access-token', 'server.lock', 'mcp-token', 'mcp-connection.json', '*.sqlite-wal', '*.sqlite-shm')
def copy(relative):
    source, destination = root/relative, target/relative
    if not source.exists(): raise RuntimeError('Missing V3 source input: '+relative)
    if source.is_dir(): shutil.copytree(source, destination, ignore=ignored)
    else:
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
for relative in ['package.json','pnpm-lock.yaml','pnpm-workspace.yaml','vite.config.mjs','.gitignore','.env.example','README.md','PLAN.md','STATUS.md','apps','packages','server','docs','tests','examples']:
    copy(relative)
for relative in ['scripts/doctor.mjs','scripts/demo.mjs','scripts/create-demo-bundle.mjs','scripts/create-timeline-fixtures.py','scripts/create-timeline-demo.mjs','scripts/stress-timeline.mjs','scripts/verify-v3-relocation.mjs','scripts/package-v3.py']:
    copy(relative)
for relative in ['evidence/v3','evidence/v3-before','evidence/v3-browser','evidence/v3-browser-v1','evidence/v3-ui-components','evidence/v3-desktop','evidence/v3-clean-install','evidence/v3-verification-summary.json','evidence/v2-demo','evidence/mcp-demo','evidence/demo.json']:
    copy(relative)
# Failure logs remain in the repository; final acceptance files reflect their exact latest run.
for path in target.rglob('*'):
    if path.is_file() and (path.name.startswith('failure-') or path.name=='failure.png'):
        path.unlink()
files=[]
for file in sorted(target.rglob('*')):
    if file.is_file():
        if file.name in ['access-token','server.lock','mcp-token','mcp-connection.json'] or file.name.endswith(('.sqlite-wal','.sqlite-shm')):
            raise RuntimeError('Runtime/authentication file must not ship')
        files.append({'path':str(file.relative_to(target)),'bytes':file.stat().st_size,'sha256':hashlib.sha256(file.read_bytes()).hexdigest()})
bases=[]
for name in ['video-workbench-M0-M3.zip','video-workbench-v2-multitrack.zip']:
    file=root/'deliverables'/name
    bases.append({'filename':name,'sha256':hashlib.sha256(file.read_bytes()).hexdigest(),'modifiedByV3':False})
summary=json.loads((root/'evidence/v3-verification-summary.json').read_text())
manifest={'name':'video-workbench','version':'0.3.0','edition':'Electron + pnpm monorepo + shadcn/ui Base UI','baseArtifacts':bases,'liveProviderVerified':False,'macOSNativeVerified':False,'verification':summary,'files':files}
(target/'MANIFEST.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2))
output=root/'deliverables/video-workbench-v3-electron-monorepo-source.zip'
with zipfile.ZipFile(output,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as archive:
    for file in sorted(target.rglob('*')):
        if file.is_file(): archive.write(file,pathlib.Path('video-workbench')/file.relative_to(target))
with zipfile.ZipFile(output) as archive:
    assert archive.testzip() is None
    for item in files:
        data=archive.read('video-workbench/'+item['path'])
        assert len(data)==item['bytes'] and hashlib.sha256(data).hexdigest()==item['sha256']
for source,name in [('evidence/v3-browser/deliverable-canvas.png','workbench-v3-canvas.png'),('evidence/v3-browser/deliverable-preview.png','workbench-v3-preview.png'),('evidence/v3-browser/deliverable-region-guide.png','workbench-v3-region-guide.png'),('evidence/v3-desktop/electron-workbench.png','workbench-v3-electron.png'),('docs/DESKTOP.md','workbench-v3-desktop-guide.md')]:
    shutil.copy2(root/source,root/'deliverables'/name)
result={'zip':str(output),'bytes':output.stat().st_size,'sha256':hashlib.sha256(output.read_bytes()).hexdigest(),'files':len(files)+1,'allManifestHashesVerified':True,'staging':str(target),'baseArtifacts':bases}
(root/'deliverables/v3-package-result.json').write_text(json.dumps(result,indent=2))
print(json.dumps(result,indent=2))
