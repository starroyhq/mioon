"""Headless acceptance for the format-5 render/export UI against the real app.

The page is the production web shell talking to the real project service. By
default the script builds a fresh format-5 project through the public RPC write
entries: it synthesizes two 2-second 1080x1920 30fps clips with ffmpeg (one test
pattern with a 440 Hz tone, one silent blue), imports them, inserts them on the
main track, sets the reviewed gain, separates the first clip's sound, and adds a
0-60 frame subtitle. No local project or data directory is required.

It then follows the user export flow (check -> settings -> confirmation -> start),
waits for the real worker export, downloads the output through the authenticated
media route and probes it against the committed `consistency.json` structure.
Screenshots are written only under the caller-provided --screens directory.
An existing equivalent project can be selected with --project-id / --project-name;
--expected-mp4 optionally requires byte equality with a reviewed export.
"""
import argparse
import base64
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import traceback
import urllib.error
import urllib.request
import uuid
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
SUBTITLE_TEXT = '导出字幕检查'


class Rpc:
    def __init__(self, base: str, token: str):
        self.base = base.rstrip('/')
        self.token = token

    def call(self, operation: str, input_value: dict, project_id: str | None = None) -> dict:
        route = f'{self.base}/api/projects/{project_id}/rpc' if project_id else f'{self.base}/api/rpc'
        body = json.dumps({'operation': operation, 'input': input_value}).encode()
        request = urllib.request.Request(route, data=body, method='POST',
                                         headers={'content-type': 'application/json',
                                                  'authorization': f'Bearer {self.token}'})
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                value = json.loads(response.read())
        except urllib.error.HTTPError as error:
            raise AssertionError(f'{operation} failed with HTTP {error.code}: {error.read().decode()}') from error
        if not value.get('ok'):
            raise AssertionError(f'{operation} failed: {value.get("error")}')
        return value['data']

    def download(self, path: str) -> bytes:
        request = urllib.request.Request(self.base + path,
                                         headers={'authorization': f'Bearer {self.token}'})
        with urllib.request.urlopen(request, timeout=120) as response:
            return response.read()


def run(command: list[str], *, timeout: int = 180) -> subprocess.CompletedProcess:
    return subprocess.run(command, capture_output=True, text=True, timeout=timeout, check=False)


def probe(ffprobe: str, file: Path) -> dict:
    result = run([ffprobe, '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(file)])
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def rms(ffmpeg: str, file: Path, start: float, duration: float) -> float | None:
    result = run([ffmpeg, '-hide_banner', '-nostats', '-ss', str(start), '-t', str(duration), '-i', str(file),
                  '-af', 'volumedetect', '-f', 'null', '-'])
    match = re.search(r'mean_volume:\s*(-?[\d.]+) dB', result.stderr)
    return None if not match else 10 ** (float(match.group(1)) / 20)


def expected_frames(directory: Path | None) -> dict[str, str]:
    if directory is None or not directory.is_dir():
        return {}
    return {name: hashlib.sha256((directory / name).read_bytes()).hexdigest()
            for name in ('frame-00_5s.png', 'frame-01_5s.png', 'frame-02_5s.png')
            if (directory / name).is_file()}


def synthesize(ffmpeg: str, directory: Path) -> tuple[Path, Path]:
    first, second = directory / 'with-audio.mp4', directory / 'silent.mp4'
    result = run([ffmpeg, '-hide_banner', '-v', 'error', '-y',
                  '-f', 'lavfi', '-i', 'testsrc2=size=1080x1920:rate=30:duration=2',
                  '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2',
                  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k',
                  '-shortest', '-movflags', '+faststart', str(first)])
    assert result.returncode == 0, result.stderr
    result = run([ffmpeg, '-hide_banner', '-v', 'error', '-y',
                  '-f', 'lavfi', '-i', 'color=c=blue:size=1080x1920:rate=30:duration=2',
                  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', str(second)])
    assert result.returncode == 0, result.stderr
    return first, second


def build_project(rpc: Rpc, consistency: dict, ffmpeg: str, name: str) -> tuple[str, dict]:
    project = rpc.call('project.create', {'name': name})['id']
    project_state = rpc.call('project.get', {'projectId': project}, project)
    assert project_state.get('projectFormatVersion') == 5, (
        'acceptance needs a format-5-enabled application build; project.create returned '
        f"format {project_state.get('projectFormatVersion')!r}")
    with tempfile.TemporaryDirectory(prefix='format5-render-export-') as temp:
        first, second = synthesize(ffmpeg, Path(temp))
        asset_ids = {}
        for path, name_value in ((first, 'with-audio.mp4'), (second, 'silent.mp4')):
            data = path.read_bytes()
            asset = rpc.call('asset.import', {'projectId': project, 'name': name_value,
                'mimeType': 'video/mp4', 'dataBase64': base64.b64encode(data).decode()}, project)
            asset_ids[name_value] = asset['id']
        # Uploaded assets start with a sampled fingerprint; the production
        # import path prepares the full hash before it puts them on a timeline.
        rpc.call('asset.media.prepare', {'projectId': project, 'purpose': 'timeline',
            'assets': [{'assetId': asset_id, 'referenceRevision': 1} for asset_id in asset_ids.values()]}, project)
        for name_value, start in (('with-audio.mp4', 0), ('silent.mp4', 60)):
            preview = rpc.call('sequence.preview', {'projectId': project,
                'requestId': f'insert-{uuid.uuid4()}', 'intents': [{'side': 'timeline',
                    'operation': {'kind': 'track', 'edit': {'kind': 'insert-asset', 'assetId': asset_ids[name_value],
                                  'trackId': None, 'startFrame': start}}}]}, project)
            applied = rpc.call('sequence.commit', {'projectId': project, 'envelope': preview['envelope'],
                'expectedPlanDigest': preview['planDigest']}, project)
            assert applied.get('status') == 'applied', applied
    project_state = rpc.call('project.get', {'projectId': project}, project)
    timeline = project_state['timeline']
    source = next(clip for clip in timeline['clips']
                  if clip.get('assetId') == asset_ids['with-audio.mp4'])
    gain = consistency['export']['audioChecked']['appliedClipGain']
    preview = rpc.call('sequence.preview', {'projectId': project, 'requestId': f'gain-{uuid.uuid4()}',
        'propertiesIntent': {'side': 'timeline', 'operation': {'kind': 'clip-properties',
            'edits': [{'clipId': source['id'], 'patch': {'gain': gain}}]}}}, project)
    assert rpc.call('sequence.commit', {'projectId': project, 'envelope': preview['envelope'],
        'expectedPlanDigest': preview['planDigest']}, project).get('status') == 'applied'
    preview = rpc.call('sequence.preview', {'projectId': project, 'requestId': f'sound-{uuid.uuid4()}',
        'soundIntent': {'side': 'timeline', 'operation': {'kind': 'separate-sound',
            'clipId': source['id']}}}, project)
    assert rpc.call('sequence.commit', {'projectId': project, 'envelope': preview['envelope'],
        'expectedPlanDigest': preview['planDigest']}, project).get('status') == 'applied'
    cue_id = str(uuid.uuid4())
    preview = rpc.call('sequence.preview', {'projectId': project, 'requestId': f'subtitle-{uuid.uuid4()}',
        'subtitlesIntent': {'side': 'timeline', 'operation': {'kind': 'subtitles',
            'edits': [{'kind': 'add', 'cue': {'id': cue_id, 'text': SUBTITLE_TEXT,
                                               'startFrame': 0, 'durationFrames': 60}}]}}}, project)
    assert rpc.call('sequence.commit', {'projectId': project, 'envelope': preview['envelope'],
        'expectedPlanDigest': preview['planDigest']}, project).get('status') == 'applied'
    return project, rpc.call('project.get', {'projectId': project}, project)


def structure_checks(state: dict, consistency: dict) -> None:
    timeline = state['timeline']
    assert timeline['durationFrames'] == consistency['timeline']['durationFrames'], timeline['durationFrames']
    assert timeline['fps'] == consistency['timeline']['fps'], timeline['fps']
    clips = timeline['clips']
    assert len(clips) == consistency['timeline']['clips'], len(clips)
    assert len([clip for clip in clips if clip.get('soundOnly') is True]) == consistency['timeline']['audioClips']
    assert len([clip for clip in clips if clip.get('soundOnly') is not True]) == consistency['timeline']['videoClips']
    muted = [clip for clip in clips if clip.get('muted') is True]
    assert len(muted) == 1 and muted[0].get('soundOnly') is not True, muted
    sound = next(clip for clip in clips if clip.get('soundOnly') is True)
    gain = consistency['export']['audioChecked']['appliedClipGain']
    assert abs(float(sound['gain']) - gain) < 1e-12, sound['gain']
    assert abs(float(muted[0]['gain']) - gain) < 1e-12, muted[0]['gain']
    cues = timeline.get('subtitles', {}).get('cues', [])
    assert len(cues) == consistency['timeline']['subtitleCues'], cues
    assert cues[0]['startFrame'] == 0 and cues[0]['durationFrames'] == 60, cues[0]
    assert cues[0]['text'] == SUBTITLE_TEXT, cues[0]


def main() -> int:  # noqa: C901 - one linear acceptance script
    parser = argparse.ArgumentParser()
    parser.add_argument('--url', required=True)
    parser.add_argument('--token')
    parser.add_argument('--token-file')
    parser.add_argument('--project-id')
    parser.add_argument('--project-name')
    parser.add_argument('--consistency', default=str(HERE / 'consistency.json'))
    parser.add_argument('--expected-mp4')
    parser.add_argument('--expected-frames')
    parser.add_argument('--screens')
    parser.add_argument('--browser')
    parser.add_argument('--ffmpeg', default=os.environ.get('MIOON_FFMPEG_PATH') or shutil.which('ffmpeg'))
    parser.add_argument('--ffprobe', default=os.environ.get('MIOON_FFPROBE_PATH') or shutil.which('ffprobe'))
    options = parser.parse_args()
    base = options.url.rstrip('/')
    token = options.token or (Path(options.token_file).read_text().strip() if options.token_file else None)
    assert token, 'Pass --token or --token-file'
    assert options.ffmpeg and options.ffprobe, 'ffmpeg and ffprobe are required'
    consistency = json.loads(Path(options.consistency).read_text())
    executable = options.browser or shutil.which('chromium') or shutil.which('google-chrome')
    mac = Path('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    if not executable and mac.exists():
        executable = str(mac)
    assert executable, 'A Chromium executable is required'
    screens = Path(options.screens) if options.screens else None
    if screens:
        screens.mkdir(parents=True, exist_ok=True)
    expected_mp4 = Path(options.expected_mp4) if options.expected_mp4 else None
    result = {'checks': [], 'screens': {}}

    def log(name: str, **details) -> None:
        result['checks'].append({'name': name, 'passed': True, **details})
        print(f'ok - {name}', flush=True)

    def capture(page, name: str) -> None:
        if screens:
            page.screenshot(path=str(screens / name), full_page=True)
            result['screens'][name] = str(screens / name)

    rpc = Rpc(base, token)
    if options.project_id or options.project_name:
        projects = rpc.call('project.list', {})
        project = next((item for item in projects if item['id'] == options.project_id), None)
        if project is None and options.project_name:
            project = next((item for item in projects if item['name'] == options.project_name), None)
        assert project is not None, f'project not found: {options.project_id or options.project_name}'
        project_id = project['id']
        state = rpc.call('project.get', {'projectId': project_id}, project_id)
        assert state.get('projectFormatVersion') == 5, state.get('projectFormatVersion')
        log('using the requested format-5 project', projectId=project_id)
    else:
        project_id, state = build_project(rpc, consistency, options.ffmpeg,
            f'format5 render export acceptance {uuid.uuid4().hex[:8]}')
        log('fresh format-5 project built through the real write entries', projectId=project_id)
    structure_checks(state, consistency)
    log('project has two main-track clips, one separated sound with the reviewed gain, one muted source and a 0-60 subtitle')
    before_exports = {item['id'] for item in state.get('exports', [])}

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=executable, headless=True, chromium_sandbox=True)
        context = browser.new_context(viewport={'width': 1440, 'height': 900}, locale='zh-Hans')
        page = context.new_page()
        errors: list[str] = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        try:
            page.goto(options.url)
            page.wait_for_timeout(700)
            if page.get_by_test_id('access-token').count():
                page.get_by_test_id('access-token').fill(token)
                page.get_by_test_id('login-submit').click()
            page.get_by_test_id('project-home').wait_for(timeout=30000)
            page.get_by_test_id(f'pf-card-open-{project_id}').click()
            page.get_by_test_id('workspace-editing').wait_for(timeout=30000)
            page.get_by_test_id('workspace-editing').click()
            page.wait_for_timeout(1200)
            log('the real app opens the built format-5 project')
            capture(page, '1-project-editing.png')

            page.get_by_test_id('export-timeline').click()
            page.get_by_test_id('timeline-export-dialog').wait_for(timeout=15000)
            page.get_by_test_id('preflight-check').click()
            page.wait_for_function(
                "() => { const text=(document.querySelector('[data-testid=timeline-export-dialog]')?.innerText ?? '');"
                " return /检查通过|检查不通过|素材|编码/.test(text) && !document.querySelector('[data-testid=preflight-check]')?.disabled; }",
                timeout=60000)
            log('export capability/preflight check returns a concrete result')
            capture(page, '2-export-checked.png')
            page.get_by_test_id('export-workflow-next').click()
            page.wait_for_timeout(500)
            page.get_by_test_id('export-workflow-next').click()
            page.wait_for_timeout(500)
            capture(page, '3-export-confirmation.png')

            page.get_by_test_id('preflight-export').click()
            started = time.time()
            export = None
            while time.time() - started < 120:
                current = rpc.call('project.get', {'projectId': project_id}, project_id)
                candidates = [item for item in current.get('exports', [])
                              if item['id'] not in before_exports and item.get('purpose') == 'export']
                if candidates:
                    export = max(candidates, key=lambda item: item.get('createdAt', ''))
                    if export.get('status') in ('succeeded', 'failed'):
                        break
                page.wait_for_timeout(500)
            assert export is not None, 'the UI did not create an export record'
            assert export.get('status') == 'succeeded', export
            assert isinstance(export.get('assetId'), str) and export['assetId'], export
            log('the production UI starts export through local delivery and the worker succeeds',
                exportId=export['id'], assetId=export['assetId'])
            capture(page, '4-export-submitted.png')

            current = rpc.call('project.get', {'projectId': project_id}, project_id)
            structure_checks(current, consistency)
            asset = next(item for item in current.get('assets', []) if item.get('id') == export['assetId'])
            media_path = asset.get('url') or f'/api/projects/{project_id}/media/{export["assetId"]}'
            output = rpc.download(media_path)
            with tempfile.NamedTemporaryFile(suffix='.mp4', delete=False) as handle:
                handle.write(output)
                output_path = Path(handle.name)
            try:
                info = probe(options.ffprobe, output_path)
                video = next(stream for stream in info['streams'] if stream['codec_type'] == 'video')
                audio = next(stream for stream in info['streams'] if stream['codec_type'] == 'audio')
                expected = consistency['export']
                assert abs(float(info['format']['duration']) - expected['durationSeconds']) < 0.001
                assert video['codec_name'] == expected['video']['codec']
                assert video['width'] == expected['video']['width'] and video['height'] == expected['video']['height']
                assert video['r_frame_rate'] == f"{expected['video']['fps']}/1"
                assert int(video['nb_frames']) == expected['video']['frames']
                assert audio['codec_name'] == expected['audio']['codec']
                assert int(audio['sample_rate']) == expected['audio']['sampleRate']
                assert int(audio['channels']) == expected['audio']['channels']
                first_rms = rms(options.ffmpeg, output_path, 0, 2)
                second_rms = rms(options.ffmpeg, output_path, 2, 2)
                assert first_rms is not None and first_rms > 0.02, first_rms
                assert second_rms is None or second_rms < 0.001, second_rms
                log('the UI export matches the reviewed D consistency structure',
                    duration=float(info['format']['duration']), frames=int(video['nb_frames']),
                    decodedFirstRms=first_rms, secondRms=second_rms, exportId=export['id'])

                if expected_mp4 is not None:
                    expected_hash = hashlib.sha256(expected_mp4.read_bytes()).hexdigest()
                    actual_hash = hashlib.sha256(output).hexdigest()
                    assert actual_hash == expected_hash, (actual_hash, expected_hash)
                    log('the UI export is byte-identical to the reviewed export', sha256=actual_hash)
                frames = expected_frames(Path(options.expected_frames) if options.expected_frames else None)
                if frames:
                    for name, digest in frames.items():
                        seconds = {'frame-00_5s.png': '0.5', 'frame-01_5s.png': '1.5', 'frame-02_5s.png': '2.5'}[name]
                        frame = screens / f'export-{name}'
                        run([options.ffmpeg, '-v', 'error', '-y', '-ss', seconds, '-i', str(output_path),
                             '-frames:v', '1', str(frame)])
                        assert hashlib.sha256(frame.read_bytes()).hexdigest() == digest, name
                    log('reviewed frame extracts match the UI export', frames=len(frames))
                result['export'] = {'id': export['id'], 'assetId': export['assetId'], 'sha256': hashlib.sha256(output).hexdigest(),
                                    'duration': float(info['format']['duration']), 'frames': int(video['nb_frames'])}
            finally:
                output_path.unlink(missing_ok=True)
            assert not errors, errors
            result.update({'ok': True, 'browserVersion': browser.version})
        except Exception as error:
            if screens:
                try:
                    page.screenshot(path=str(screens / 'failure.png'), full_page=True)
                    (screens / 'failure.html').write_text(page.content())
                    result['screens']['failure.png'] = str(screens / 'failure.png')
                except Exception:  # noqa: BLE001 - keep the original failure
                    pass
            result.update({'ok': False, 'error': str(error), 'pageErrors': errors})
            traceback.print_exc()
            raise
        finally:
            if screens:
                (screens / 'report.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
            context.close()
            browser.close()
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        traceback.print_exc()
        sys.exit(1)
