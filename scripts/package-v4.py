"""Package V4 source/skill/evidence locally; never publish; --app-id-patch preserves every V1–V4 artifact."""
from pathlib import Path
import hashlib
import json
import shutil
import tempfile
import zipfile
import zlib
import argparse

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--app-id-patch', action='store_true', help='Create V4.1 artifacts without replacing any V4 deliverable')
args = parser.parse_args()
version = '0.4.1' if args.app_id_patch else '0.4.0'
edition = 'v4.1' if args.app_id_patch else 'v4'

root = Path(__file__).resolve().parents[1]
delivery = root / 'deliverables'
delivery.mkdir(exist_ok=True)
staging = Path(tempfile.mkdtemp(prefix=edition+'-package-', dir=root / '.verification'))
target = staging / 'mioon'
target.mkdir()
exclude = {'node_modules', '__pycache__', 'build', 'dist', 'release', '.git', '.DS_Store', 'access-token', 'mcp-token', 'mcp-connection.json', 'desktop-token', 'server.lock', 'desktop-identity.json', '.env'}
def ignored(directory, names):
    return [name for name in names if name in exclude or name.endswith(('.sqlite-wal', '.sqlite-shm', '.pyc'))]
def copy(relative):
    source, dest = root / relative, target / relative
    dest.parent.mkdir(parents=True, exist_ok=True)
    if source.is_dir(): shutil.copytree(source, dest, ignore=ignored)
    else: shutil.copy2(source, dest)
for relative in ['package.json','pnpm-lock.yaml','pnpm-workspace.yaml','vite.config.mjs','.gitignore','.env.example','README.md','LICENSE','NOTICE','THIRD_PARTY_NOTICES.md','CONTRIBUTING.md','SECURITY.md','PLAN.md','STATUS.md','apps','packages','server','docs','tests','skills','examples']:
    copy(relative)
# Runnable helpers, no historical launch wrappers tied to a development path.
for name in ['doctor.mjs','demo.mjs','create-demo-bundle.mjs','create-timeline-fixtures.py','create-timeline-demo.mjs','stress-timeline.mjs','verify-v4-relocation.mjs','package-v4.py']:
    copy('scripts/' + name)
# These tiny immutable sample indexes are real inputs to browser regression tests.
for relative in ['evidence/demo.json','evidence/mcp-demo/demo-project.json','evidence/v2-demo/demo-project.json']:
    copy(relative)
(target / 'DELIVERY-README.md').write_text('''# Mioon V4 source

This source archive is self-contained: all ten pnpm workspaces, lockfile, tests, reusable skill and three complete synthetic example projects. Install Node24+, pnpm11.25.0 and FFmpeg/ffprobe; then run `pnpm install --frozen-lockfile`, `pnpm build` and `pnpm start` (Web) or `pnpm desktop:build && pnpm desktop` (Electron development runtime).

`pnpm exec mioon --help` is the real CLI. See docs/CLI.md, docs/MCP.md and skills/mioon/SKILL.md. No global agent configuration is changed automatically.

The optional V4 evidence ZIP has screenshots, logs and offline verification reports; it is not required to build or use the source. Extract it beside this source archive to merge mioon/evidence. Historical V1–V3 ZIPs and the 0.3.0 Linux binary were not changed and are not embedded here. This is source version0.4.0, not a new prebuilt installer. macOS native validation is pending.

All five real-provider adapters are implemented and offline tested. No live generation, provider upload, paid test, deployment or publication was performed. Mock output is permanently labeled simulated motion. Separate provider/model/media/count/budget authorization and secure backend configuration are required before real generation.
''')
if args.app_id_patch:
    (target / 'DELIVERY-README.md').write_text('''# Mioon V4.1 app identity patch

Source version 0.4.1. Production application ID: `app.starroy.mioon`; development: `app.starroy.mioon.dev`. Both channels use isolated data/connection roots. Source builds default to development; packaged development keeps `.dev`. Launch-time environment variables cannot change the compiled channel. CLI and npm workspace names are now mioon and @mioon/*; environment variables use MIOON_*. Previous names have no compatibility aliases.

Install Node24+, pnpm11.25.0 and FFmpeg/ffprobe; then run `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm desktop:build` and `pnpm desktop`. For explicit production staging use `pnpm desktop:build:production`; Linux package commands are `pnpm desktop:package:linux` / `pnpm desktop:package:linux:dev`.

Old `video-workbench` data is preserved, not moved or auto-imported. Close both applications, back up the old workspace, then use the documented copy-only migration helper into a nonexistent new workspace. Update CLI/MCP to the exact channel-specific descriptor path. Read docs/DESKTOP.md before migration.

All ten pnpm workspaces, lockfile, tests, updated portable Skill and three complete synthetic example projects are included. The optional V4.1 evidence ZIP contains only this patch's results. No credentials or live user data are included. Historical V1–V4 artifacts and the 0.3.0 binary remain unchanged; no new prebuilt installer is delivered in this source archive. Linux unpacked builds were locally tested; macOS and Windows native validation/signing remain pending.

See docs/ACCEPTANCE-V4.1.md for exact checks and limitations. No live provider call, payment, account access, deployment or publication was performed.
''')

def sha(data): return hashlib.sha256(data).hexdigest()
def archive_files(folder):
    files={}
    for file in sorted(folder.rglob('*')):
        if file.is_symlink(): raise RuntimeError('Unexpected source symlink: '+str(file))
        if file.is_file():
            if file.name in exclude or file.name.endswith(('.sqlite-wal','.sqlite-shm')): raise RuntimeError('Unsafe runtime file: '+str(file))
            files[str(file.relative_to(folder))]=file.read_bytes()
    return files

def archive(label, files, filename, prefix, metadata):
    entries=[{'path':name,'bytes':len(data),'sha256':sha(data)} for name,data in sorted(files.items())]
    files={**files,'MANIFEST.json':json.dumps({'version':version,'edition':label,'liveProviderVerified':False,'macOSNativeVerified':False,**metadata,'files':entries},ensure_ascii=False,indent=2).encode()}
    output=delivery/filename
    with zipfile.ZipFile(output,'w',zipfile.ZIP_DEFLATED,compresslevel=9) as zipped:
        for name,data in sorted(files.items()):zipped.writestr(prefix+name,data)
    if output.stat().st_size>15_000_000:raise RuntimeError(f'{filename} exceeds attachment limit')
    with zipfile.ZipFile(output) as zipped:
        assert zipped.testzip() is None
        for item in entries:
            data=zipped.read(prefix+item['path'])
            assert len(data)==item['bytes'] and sha(data)==item['sha256']
    return {'kind':label,'path':str(output),'bytes':output.stat().st_size,'sha256':sha(output.read_bytes()),'manifestVerified':True,'fileCount':len(files)}

bases=[]
for name in ['video-workbench-M0-M3.zip','video-workbench-v2-multitrack.zip','video-workbench-v3-source-lean.zip','video-workbench-v3-evidence.zip'] + (['video-workbench-v4-source.zip','video-workbench-skill.zip','video-workbench-v4-evidence-1.zip','video-workbench-0.3.0-linux-x64.tar.gz'] if args.app_id_patch else []):
    file=delivery/name
    if file.is_file():bases.append({'filename':name,'sha256':sha(file.read_bytes()),'modifiedBy'+edition.upper():False})
summary=json.loads((root/('evidence/v4.1-app-id/summary.json' if args.app_id_patch else 'evidence/v4-verification-summary.json')).read_text())
source=archive('runnable-source',archive_files(target),f'mioon-{edition}-source.zip','mioon/',{'baseArtifacts':bases,'verification':summary})
skill=archive('portable-agent-skill',archive_files(root/'skills/mioon'),('mioon-v4.1-skill.zip' if args.app_id_patch else 'mioon-skill.zip'),'mioon/',{'installation':'Copy this folder manually to your agent skill discovery location only when authorized.'})
evidence={}
for name in (['v4.1-app-id'] if args.app_id_patch else ['v4','v4-browser-provider','v4-browser-timeline','v4-browser-original','v4-browser-components','v4-desktop','v4-clean-install','v4-independent-skill','v4-verification-summary.json']):
    source_path=root/'evidence'/name
    if not source_path.exists():continue
    files=[source_path] if source_path.is_file() else sorted(source_path.rglob('*'))
    for file in files:
        if file.is_file() and file.name not in exclude and not file.name.endswith(('.sqlite','.sqlite-wal','.sqlite-shm')) and not file.name.startswith('failure'):
            evidence[str(file.relative_to(root))]=file.read_bytes()
evidence['EVIDENCE-README.txt']=(f'{edition.upper()} optional verification evidence. Merge beside mioon source if desired. Offline adapters and local mock workflow only; no live provider output is claimed. Historical evidence is not repeated.\n').encode()
# Split only evidence files into complete independent small ZIPs, never a fragmented installer.
parts=[];current={};estimate=0
for name,data in sorted(evidence.items()):
    compressed=len(zlib.compress(data,9))+len(name.encode())+256
    if current and estimate+compressed>14_500_000:parts.append(current);current={};estimate=0
    if compressed>14_500_000:raise RuntimeError('Oversized evidence file: '+name)
    current[name]=data;estimate+=compressed
if current:parts.append(current)
outputs=[source,skill]+[archive('verification-evidence',part,f'mioon-{edition}-evidence-{i+1}.zip','mioon/',{'part':i+1,'parts':len(parts)}) for i,part in enumerate(parts)]
result={'version':version,'staging':str(target),'artifacts':outputs,'baseArtifacts':bases}
(delivery/f'{edition}-package-result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(result,ensure_ascii=False,indent=2))
