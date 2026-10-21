#!/usr/bin/env python3
"""Run an explicitly local mock-only workflow against an already running service."""
import argparse
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import uuid
import zlib

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--repo', required=True, type=Path, help='Authorized Mioon checkout')
parser.add_argument('--work-dir', required=True, type=Path, help='New private directory for state, synthetic image and result')
parser.add_argument('--image', type=Path, help='Optional explicitly approved local PNG/JPEG/WebP instead of synthetic image')
args = parser.parse_args()
repo = args.repo.resolve()
cli = repo / 'apps/cli/src/index.ts'
if not cli.is_file():
    parser.error('--repo must contain apps/cli/src/index.ts')
work = args.work_dir.resolve()
work.mkdir(mode=0o700, parents=True, exist_ok=False)
state_path = work / 'requests.json'
records = []

def save():
    state_path.write_text(json.dumps(records, ensure_ascii=False, indent=2) + '\n')
    state_path.chmod(0o600)

def run(operation, data=None, extra=()):
    record = {'operation': operation, 'input': data or {}, 'outcome': 'pending'}
    records.append(record)
    save()  # Original mutation input survives a lost CLI/backend response.
    command = ['node', str(cli), *operation.split('.'), '--input', json.dumps(data or {}), *map(str, extra)]
    result = subprocess.run(command, cwd=repo, text=True, stdout=subprocess.PIPE, stderr=sys.stderr)
    try:
        envelope = json.loads(result.stdout)
    except json.JSONDecodeError:
        record['outcome'] = 'unreadable_response'
        save()
        raise RuntimeError('No usable response. Inspect saved original request; do not blindly restart.')
    record['response'] = envelope
    record['exitCode'] = result.returncode
    record['outcome'] = 'ok' if result.returncode == 0 and envelope.get('ok') else 'stopped'
    save()
    if record['outcome'] != 'ok':
        raise RuntimeError(f"{operation} stopped; inspect {state_path} and follow the recovery reference.")
    return envelope['data']

try:
    providers = run('capabilities')
    mock = next((provider for provider in providers if provider['id'] == 'mock' and provider.get('enabled')), None)
    if not mock:
        raise RuntimeError('Local mock provider is unavailable. No live provider will be substituted.')
    if args.image:
        image = args.image.resolve(strict=True)
    else:
        image = work / 'synthetic-reference.png'
        width, height = 360, 640
        raw = b''.join(b'\x00' + bytes((40 + y % 80, 110, 185)) * width for y in range(height))
        def chunk(kind, payload):
            return struct.pack('!I', len(payload)) + kind + payload + struct.pack('!I', zlib.crc32(kind + payload) & 0xffffffff)
        image.write_bytes(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!2I5B', width, height, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))
    project = run('project.create', {'name': 'Agent mock video study'})
    asset = run('asset.import', {'projectId': project['id']}, ['--file', image])
    shot = run('shot.create', {'projectId': project['id'], 'requestId': str(uuid.uuid4()), 'title': 'Synthetic motion study', 'prompt': 'Original geometric colors gently moving', 'referenceAssetIds': [asset['id']], 'aspectRatio': '9:16', 'duration': 2})
    run('node.create', {'projectId': project['id'], 'requestId': str(uuid.uuid4()), 'type': 'image', 'assetId': asset['id'], 'label': 'Original synthetic reference', 'position': {'x': 40, 'y': 420}})
    job = run('generation.submit', {'shotId': shot['id'], 'expectedRevision': shot['revision'], 'requestId': str(uuid.uuid4()), 'providerId': 'mock', 'model': mock['models'][0]})
    finished = run('job.watch', {'jobId': job['id']}, ['--timeout-ms', '60000', '--interval-ms', '500'])
    project_state = run('project.get', {'projectId': project['id']})
    current = next(item for item in project_state['shots'] if item['id'] == shot['id'])
    run('version.select', {'shotId': current['id'], 'versionId': finished['versionId'], 'expectedRevision': current['revision'], 'requestId': str(uuid.uuid4())})
    timeline = run('timeline.get', {'projectId': project['id']})
    run('timeline.seed', {'projectId': project['id'], 'expectedRevision': timeline['revision'], 'requestId': str(uuid.uuid4())})
    timeline = run('timeline.get', {'projectId': project['id']})
    export = run('timeline.render', {'projectId': project['id'], 'expectedRevision': timeline['revision'], 'requestId': str(uuid.uuid4()), 'purpose': 'export'})
    output = run('export.watch', {'exportId': export['id']}, ['--timeout-ms', '120000', '--interval-ms', '500'])
    saved = run('export.download', {'exportId': output['id']}, ['--output', work / 'mock-result.mp4'])
    if not (work / 'mock-result.mp4').is_file() or (work / 'mock-result.mp4').stat().st_size == 0:
        raise RuntimeError('No result file was saved.')
    print(json.dumps({'ok': True, 'provider': 'mock', 'isRealAIOutput': False, 'projectId': project['id'], 'shotId': shot['id'], 'jobId': job['id'], 'exportId': output['id'], 'output': str(work / 'mock-result.mp4'), 'stateFile': str(state_path), 'download': saved}, ensure_ascii=False))
except Exception as error:
    print(str(error), file=sys.stderr)
    sys.exit(1)
