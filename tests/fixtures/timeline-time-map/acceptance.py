"""Headless-Chromium cross-runtime check for the SP-M time mapping.

The page is a standalone fixture: it only runs the pure mapping module and the
shared vector helper. It must compute exactly the committed integer tables and
stable hash that the Node test checks.
"""
import argparse
import hashlib
import json
import platform
import shutil
import sys
import traceback
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright


def acceptance(page, options):
    failures, requests = [], []
    page.on('pageerror', lambda error: failures.append(str(error)))
    origin = urlparse(options.url).netloc

    def observe(request):
        parsed = urlparse(request.url)
        if parsed.netloc != origin or parsed.path.startswith('/api/'):
            requests.append(request.url)
    page.on('request', observe)
    page.goto(options.url, wait_until='networkidle')
    expect(page.locator('body')).to_have_attribute('data-fixture-ready', 'true')
    page.wait_for_function('() => window.__timeMapFixture && window.__timeMapFixture.ready === true')
    computed = page.evaluate('window.__timeMapFixture.run()')
    committed = json.loads(Path(options.fixture).read_text())
    assert computed['payload']['version'] == committed['version'], 'version mismatch'
    assert computed['payload']['profile'] == committed['profile'], 'profile mismatch'
    assert computed['hash'] == committed['hash'], f"hash mismatch: browser={computed['hash']} committed={committed['hash']}"
    assert computed['payload'] == committed['payload'], 'browser integer tables differ from the committed Node tables'
    assert len(computed['hash']) == 16 and all(character in '0123456789abcdef' for character in computed['hash']), 'hash must be lower-case FNV-1a/64'
    rows = computed['payload']['cases']
    assert len(rows) == len(committed['payload']['cases']) and len(rows) > 20, 'vector row count changed'
    frameValues = sum(len(row.get('forward') or []) + len(row.get('reverse') or []) for row in rows)
    assert frameValues > 2000, f'only {frameValues} integer frame values in the cross-runtime table'
    assert not failures, 'browser page errors: ' + '; '.join(failures)
    assert not requests, 'fixture contacted a backend or external origin: ' + json.dumps(requests)
    assert computed['payload'] == page.evaluate('window.__timeMapFixture.run()')['payload'], 'fixture is not deterministic within one page'
    return {'ok': True, 'checks': ['committed integer tables byte-equal in Chromium', 'FNV-1a/64 stable hash equal', 'no backend/external request', 'no browser page error'],
            'hash': computed['hash'], 'rows': len(rows), 'integerFrameValues': frameValues,
            'fixtureSha256': hashlib.sha256(Path(options.fixture).read_bytes()).hexdigest()}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--url', required=True)
    parser.add_argument('--fixture', required=True)
    parser.add_argument('--report')
    parser.add_argument('--browser')
    options = parser.parse_args()
    executable = options.browser or shutil.which('chromium') or shutil.which('google-chrome')
    mac = Path('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    if not executable and mac.exists():
        executable = str(mac)
    assert executable, 'A Chromium executable is required'
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=executable, headless=True, chromium_sandbox=True)
        context = browser.new_context(viewport={'width': 1280, 'height': 720}, device_scale_factor=1)
        page = context.new_page()
        try:
            result = acceptance(page, options)
            result.update({'browserVersion': browser.version, 'platform': platform.system(), 'architecture': platform.machine()})
            if options.report:
                Path(options.report).parent.mkdir(parents=True, exist_ok=True)
                Path(options.report).write_text(json.dumps(result, indent=2) + '\n')
            print(json.dumps(result))
        finally:
            context.close(); browser.close()


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'ok': False, 'error': str(error)}))
        traceback.print_exc()
        sys.exit(1)
