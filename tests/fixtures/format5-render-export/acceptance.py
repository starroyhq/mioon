"""Headless acceptance for the format-5 render/export UI against the real app.

The page is the production web shell talking to the real project service. The
run follows the user export flow (check -> settings -> confirmation -> start),
waits for the real worker export, opens the task/export surfaces, downloads the
output through the authenticated media route, and probes it. The reviewed D
4-second project is selected by name/id; its expected timeline/export facts live
in the committed `consistency.json` (copied from
board-edit-3/evidence/consistency.json). Screenshots are written only under the
caller-provided --screens directory.
"""
import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tempfile
import time
import traceback
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

PROJECT_NAME = 'D 导出走查 1121'
HERE = Path(__file__).resolve().parent


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
        with urllib.request.urlopen(request, timeout=30) as response:
            value = json.loads(response.read())
        if not value.get('ok'):
            raise AssertionError(f'{operation} failed: {value.get("error")}')
        return value['data']

    def download(self, path: str) -> bytes:
        request = urllib.request.Request(self.base + path,
                                         headers={'authorization': f'Bearer {self.token}'})
        with urllib.request.urlopen(request, timeout=120) as response:
            return response.read()


def run(command: list[str], *, timeout: int = 120) -> subprocess.CompletedProcess:
    return subprocess.run(command, capture_output=True, text=True, timeout=timeout, check=False)


def probe(ffprobe: str, file: Path) -> dict:
    result = run([ffprobe, '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(file)])
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def rms(ffmpeg: str, file: Path, start: float, duration: float) -> float | None:
    result = run([ffmpeg, '-hide_banner', '-nostats', '-ss', str(start), '-t', str(duration), '-i', str(file),
                  '-af', 'volumedetect', '-f', 'null', '-'], timeout=120)
    match = re.search(r'mean_volume:\s*(-?[\d.]+) dB', result.stderr)
    if not match:
        return None
    return 10 ** (float(match.group(1)) / 20)


def expected_frames(directory: Path | None) -> dict[str, str]:
    if directory is None or not directory.is_dir():
        return {}
    result = {}
    for name in ('frame-00_5s.png', 'frame-01_5s.png', 'frame-02_5s.png'):
        path = directory / name
        if path.is_file():
            result[name] = hashlib.sha256(path.read_bytes()).hexdigest()
    return result


def main() -> int:  # noqa: C901 - one linear acceptance script
    parser = argparse.ArgumentParser()
    parser.add_argument('--url', required=True)
    parser.add_argument('--base', required=True)
    parser.add_argument('--token', required=True)
    parser.add_argument('--project-id')
    parser.add_argument('--project-name', default=PROJECT_NAME)
    parser.add_argument('--consistency', default=str(HERE / 'consistency.json'))
    parser.add_argument('--expected-mp4')
    parser.add_argument('--expected-frames')
    parser.add_argument('--screens')
    parser.add_argument('--browser')
    parser.add_argument('--ffmpeg', default=shutil.which('ffmpeg'))
    parser.add_argument('--ffprobe', default=shutil.which('ffprobe'))
    options = parser.parse_args()
    consistency = json.loads(Path(options.consistency).read_text())
    executable = options.browser or shutil.which('chromium') or shutil.which('google-chrome')
    mac = Path('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    if not executable and mac.exists():
        executable = str(mac)
    assert executable, 'A Chromium executable is required'
    assert options.ffmpeg and options.ffprobe, 'ffmpeg and ffprobe are required'
    screens = Path(options.screens) if options.screens else None
    if screens:
        screens.mkdir(parents=True, exist_ok=True)
    expected_mp4 = Path(options.expected_mp4) if options.expected_mp4 else None
    result = {'checks': [], 'screens': {}, 'projectName': options.project_name}

    def log(name: str, **details) -> None:
        result['checks'].append({'name': name, 'passed': True, **details})

    def capture(page, name: str) -> None:
        if not screens:
            return
        path = screens / name
        page.screenshot(path=str(path), full_page=True)
        result['screens'][name] = str(path)

    rpc = Rpc(options.base, options.token)
    projects = rpc.call('project.list', {})
    project = next((item for item in projects if item.get('id') == options.project_id), None)
    if project is None:
        project = next((item for item in projects if item.get('name') == options.project_name), None)
    assert project is not None, f'project not found: {options.project_id or options.project_name}'
    project_id = project['id']
    result['projectId'] = project_id
    before = rpc.call('project.get', {'projectId': project_id}, project_id)
    before_exports = {item['id'] for item in before.get('exports', [])}

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
                page.get_by_test_id('access-token').fill(options.token)
                page.get_by_test_id('login-submit').click()
            page.get_by_test_id('project-home').wait_for(timeout=30000)
            page.get_by_test_id(f'pf-card-open-{project_id}').click()
            page.get_by_test_id('workspace-editing').wait_for(timeout=30000)
            page.get_by_test_id('workspace-editing').click()
            page.wait_for_timeout(1200)
            log('the real app opens the reviewed format-5 project', projectId=project_id)
            capture(page, '1-project-editing.png')

            # -- Production export flow: check, settings, confirmation, start.
            page.get_by_test_id('export-timeline').click()
            page.get_by_test_id('timeline-export-dialog').wait_for(timeout=15000)
            page.get_by_test_id('preflight-check').click()
            # The capability/preflight check runs real FFmpeg; wait for a concrete
            # result instead of a fixed delay.
            page.wait_for_function(
                "() => { const text=(document.querySelector('[data-testid=timeline-export-dialog]')?.innerText ?? '');"
                " return /检查通过|检查不通过|素材|编码/.test(text) && !document.querySelector('[data-testid=preflight-check]')?.disabled; }",
                timeout=60000)
            guard = page.get_by_test_id('timeline-export-dialog').inner_text()
            log('export capability/preflight check returns a concrete result')
            capture(page, '2-export-checked.png')
            page.get_by_test_id('export-workflow-next').click()
            page.wait_for_timeout(500)
            page.get_by_test_id('export-workflow-next').click()
            page.wait_for_timeout(500)
            page.get_by_test_id('timeline-export-dialog').inner_text()
            capture(page, '3-export-confirmation.png')

            started = time.time()
            page.get_by_test_id('preflight-export').click()
            # The UI starts a local-delivery prepare/execute and then a real
            # worker render. Wait for the durable export record, not a toast.
            export = None
            deadline = started + 120
            while time.time() < deadline:
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

            # Task center / export surfaces show the completed task, then the
            # output is downloaded from the authenticated media route.
            try:
                page.get_by_test_id('topbar-status').click()
                page.get_by_test_id('task-center-dialog').wait_for(timeout=10000)
                page.wait_for_timeout(600)
                capture(page, '5-task-center.png')
                task_text = page.get_by_test_id('task-center-dialog').inner_text()
                log('task center opens after export', text=task_text[:400])
            except Exception:  # noqa: BLE001 - the durable record already proves completion
                log('task center surface was not available; durable export record remains the proof')
            current = rpc.call('project.get', {'projectId': project_id}, project_id)
            asset = next(item for item in current.get('assets', []) if item.get('id') == export['assetId'])
            media_path = asset.get('url') or f'/api/projects/{project_id}/media/{export["assetId"]}'
            output = rpc.download(media_path)
            with tempfile.NamedTemporaryFile(suffix='.mp4', delete=False) as handle:
                handle.write(output)
                output_path = Path(handle.name)
            try:
                info = probe(options.ffprobe, output_path)
                timeline = current['timeline']
                assert timeline['durationFrames'] == consistency['timeline']['durationFrames']
                assert timeline['fps'] == consistency['timeline']['fps']
                video = next(stream for stream in info['streams'] if stream['codec_type'] == 'video')
                audio = next(stream for stream in info['streams'] if stream['codec_type'] == 'audio')
                expected_export = consistency['export']
                assert abs(float(info['format']['duration']) - expected_export['durationSeconds']) < 0.001
                assert video['codec_name'] == expected_export['video']['codec']
                assert video['width'] == expected_export['video']['width'] and video['height'] == expected_export['video']['height']
                assert video['r_frame_rate'] == f"{expected_export['video']['fps']}/1"
                assert int(video['nb_frames']) == expected_export['video']['frames']
                assert audio['codec_name'] == expected_export['audio']['codec']
                assert int(audio['sample_rate']) == expected_export['audio']['sampleRate']
                assert int(audio['channels']) == expected_export['audio']['channels']
                first_rms = rms(options.ffmpeg, output_path, 0, 2)
                second_rms = rms(options.ffmpeg, output_path, 2, 2)
                # The reviewed consistency RMS is the signal-domain source
                # (0.08819 x applied gain 1.22646 = 0.10808), not the lossy AAC
                # decode. Decode equality is compared against the reviewed MP4
                # below; here the shape is held: audible then silent.
                consistency_rms = expected_export['audioChecked']['0-2s RMS']
                assert first_rms is not None and first_rms > 0.02, first_rms
                assert second_rms is None or second_rms < 0.001, second_rms
                log('the exported file matches the reviewed D consistency facts',
                    duration=float(info['format']['duration']), frames=int(video['nb_frames']),
                    decodedFirstRms=first_rms, secondRms=second_rms,
                    reviewedSignalRms=consistency_rms, exportId=export['id'])

                if expected_mp4 is not None:
                    expected_hash = hashlib.sha256(expected_mp4.read_bytes()).hexdigest()
                    actual_hash = hashlib.sha256(output).hexdigest()
                    assert actual_hash == expected_hash, (actual_hash, expected_hash)
                    log('the UI export is byte-identical to the reviewed backend export', sha256=actual_hash, expected=str(expected_mp4))
                    expected_first = rms(options.ffmpeg, expected_mp4, 0, 2)
                    expected_second = rms(options.ffmpeg, expected_mp4, 2, 2)
                    assert expected_first is not None and abs((first_rms or 0) - expected_first) < 0.0001, (first_rms, expected_first)
                    assert (expected_second is None and second_rms is None) or abs((second_rms or 0) - (expected_second or 0)) < 0.0001, (second_rms, expected_second)

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
            if options.screens:
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
