"""Headless acceptance for a lost format-5 commit response against the real
format-5 kernel and RPC. The page talks to the real project service; only the
commit transport is interrupted at the browser network layer:
`lost-after-write` forwards the real POST (so the kernel writes and stores its
receipt) and then aborts the response, `lost-before-write` aborts before the
request leaves the browser. Every other call reaches the real service."""
import argparse
import json
import shutil
import sys
import traceback
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--url', required=True)
    parser.add_argument('--base', required=True)
    parser.add_argument('--screens')
    parser.add_argument('--browser')
    options = parser.parse_args()
    executable = options.browser or shutil.which('chromium') or shutil.which('google-chrome')
    mac = Path('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    if not executable and mac.exists():
        executable = str(mac)
    assert executable, 'A Chromium executable is required'
    screens = Path(options.screens) if options.screens else None
    if screens:
        screens.mkdir(parents=True, exist_ok=True)
    result = {'checks': [], 'screens': {}}
    transport = {'mode': 'normal', 'attempts': []}

    def log(name: str, **details) -> None:
        result['checks'].append({'name': name, 'passed': True, **details})

    def capture(page, name: str) -> None:
        if not screens:
            return
        path = screens / name
        page.screenshot(path=str(path), full_page=True)
        result['screens'][name] = str(path)

    def debug(page, request_id: str | None = None) -> dict:
        suffix = '?requestId=' + request_id if request_id else ''
        return page.request.get(options.base + '/debug/state' + suffix).json()

    def lost_commit(mode_value: str) -> None:
        transport['mode'] = mode_value

    def handle_route(route) -> None:
        request = route.request
        if request.method != 'POST' or not request.url.endswith('/rpc'):
            route.continue_()
            return
        try:
            body = request.post_data_json or {}
        except Exception:  # noqa: BLE001
            body = {}
        if body.get('operation') != 'sequence.commit':
            route.continue_()
            return
        mode_value = transport['mode']
        transport['mode'] = 'normal'
        transport['attempts'].append({'mode': mode_value,
                                      'requestId': (body.get('input') or {}).get('envelope', {}).get('requestId')})
        if mode_value == 'lost-after-write':
            route.fetch()
            route.abort('failed')
            return
        if mode_value == 'lost-before-write':
            route.abort('failed')
            return
        route.continue_()

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=executable, headless=True, chromium_sandbox=True)
        context = browser.new_context(viewport={'width': 1440, 'height': 900}, locale='zh-Hans')
        page = context.new_page()
        page.route('**/rpc', handle_route)
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        try:
            page.goto(options.url)
            page.wait_for_function("() => Boolean(window.__wireState?.ready)", timeout=30000)
            page.wait_for_selector('[data-testid="timeline-panel"]', timeout=30000)
            initial = debug(page)
            initial_position = initial['historyPosition']
            assert initial['receipts'] == [], 'the fixture starts without editor receipts'

            # 1) The commit reached the kernel and was applied, but its response
            # was lost. One read-only receipt lookup settles it as applied.
            lost_commit('lost-after-write')
            page.get_by_test_id('wire-trim').click()
            expect(page.get_by_test_id('edit-ui-unconfirmed-bar')).to_be_visible()
            expect(page.get_by_test_id('edit-ui-unconfirmed-status')).to_have_text('结果未确认')
            expect(page.get_by_test_id('edit-ui-unconfirmed-retry')).to_be_visible()
            expect(page.get_by_test_id('edit-ui-unconfirmed-abandon')).to_be_visible()
            assert page.get_by_test_id('edit-ui-unconfirmed-bar').get_by_test_id('edit-ui-notice-dismiss').count() == 0
            capture(page, 'format5-lost-after-write-unconfirmed.png')
            log('a lost commit response keeps one unconfirmed bar with retry/abandon')
            page.wait_for_function("() => document.querySelector('[data-testid=edit-ui-unconfirmed-bar]') === null", timeout=15000)
            page.wait_for_function("() => document.querySelector('[data-testid=wire-state]')?.dataset.operation === 'clip-trim'")
            expect(page.get_by_test_id('edit-ui-notice-message')).to_have_text('已应用')
            applied = debug(page)
            assert len(transport['attempts']) == 1 and transport['attempts'][0]['mode'] == 'lost-after-write'
            request_id = transport['attempts'][0]['requestId']
            assert len(applied['commits']) == 1 and applied['commits'][0]['requestId'] == request_id
            assert len(applied['receipts']) == 1 and applied['receipts'][0]['requestId'] == request_id
            assert applied['receipts'][0]['status'] == 'applied'
            assert applied['historyPosition'] == initial_position + 1, (initial_position, applied['historyPosition'])
            assert applied['outcome'] == {'applied': True, 'operation': 'timeline.clip.trim',
                                          'status': 'applied', 'code': None}, applied['outcome']
            log('the receipt read proves applied, clears the bar and writes exactly once',
                requestId=request_id, position=applied['historyPosition'])
            capture(page, 'format5-lost-after-write-applied.png')

            # 2) The commit never reached the service. The same bar stays; retry
            # resends the identical envelope/requestId and applies exactly once.
            lost_commit('lost-before-write')
            page.get_by_test_id('wire-track-add').click()
            expect(page.get_by_test_id('edit-ui-unconfirmed-bar')).to_be_visible()
            capture(page, 'format5-lost-before-write-unconfirmed.png')
            page.wait_for_timeout(1500)
            lost = debug(page, transport['attempts'][1]['requestId'])
            assert transport['attempts'][1]['mode'] == 'lost-before-write'
            lost_request = transport['attempts'][1]['requestId']
            assert len(lost['receipts']) == 1, 'an unwritten commit stores no receipt'
            assert len(lost['commits']) == 1, 'the unwritten commit never reached the service'
            assert lost['historyPosition'] == applied['historyPosition']
            assert lost['outcome'] == {'applied': False, 'operation': None}, lost['outcome']
            assert page.get_by_test_id('wire-state').get_attribute('data-unconfirmed') == lost_request
            log('a commit that never reached the service stays unconfirmed without a write',
                requestId=lost_request)
            page.get_by_test_id('edit-ui-unconfirmed-retry').click()
            page.wait_for_function("() => document.querySelector('[data-testid=edit-ui-unconfirmed-bar]') === null", timeout=15000)
            page.wait_for_function("() => document.querySelector('[data-testid=wire-state]')?.dataset.operation === 'retry'")
            expect(page.get_by_test_id('edit-ui-notice-message')).to_have_text('已应用')
            retried = debug(page)
            assert len(transport['attempts']) == 3 and transport['attempts'][2]['mode'] == 'normal'
            assert transport['attempts'][2]['requestId'] == lost_request, 'retry reuses the retained requestId'
            assert len(retried['commits']) == 2 and retried['commits'][1]['requestId'] == lost_request
            assert len(retried['receipts']) == 2
            assert retried['historyPosition'] == applied['historyPosition'] + 1
            assert retried['trackCount'] == 4, retried['trackCount']
            log('retry resends the same requestId and applies the untracked commit exactly once',
                requestId=lost_request, tracks=retried['trackCount'])
            capture(page, 'format5-lost-before-write-retried.png')

            # 3) Abandon drops the retained envelope without any write.
            lost_commit('lost-before-write')
            page.get_by_test_id('wire-trim').click()
            expect(page.get_by_test_id('edit-ui-unconfirmed-bar')).to_be_visible()
            page.wait_for_timeout(1500)
            page.get_by_test_id('edit-ui-unconfirmed-abandon').click()
            page.wait_for_function("() => document.querySelector('[data-testid=edit-ui-unconfirmed-bar]') === null")
            abandoned = debug(page)
            assert len(transport['attempts']) == 4 and transport['attempts'][3]['mode'] == 'lost-before-write'
            assert len(abandoned['commits']) == 2, 'abandon sends no follow-up commit'
            assert len(abandoned['receipts']) == 2, 'abandon writes no receipt'
            assert abandoned['historyPosition'] == retried['historyPosition']
            log('abandon drops the retained envelope without any follow-up write',
                commits=len(abandoned['commits']))
            capture(page, 'format5-lost-before-write-abandoned.png')

            assert not errors, errors
            result.update({'ok': True, 'requestIds': [request_id, lost_request],
                           'historyPositions': [initial_position, applied['historyPosition'],
                                                retried['historyPosition'], abandoned['historyPosition']],
                           'receipts': len(abandoned['receipts']), 'browserVersion': browser.version})
        except Exception as error:
            try:
                result['debug'] = {'wireState': page.evaluate("() => { const s = window.__wireState; return s ? {operation: s.lastOperation, error: s.lastError, unresolved: s.unresolved, debug: s.debug} : null; }"),
                                   'wireLog': page.evaluate("() => window.__wireLog ?? []"),
                                   'server': debug(page), 'transport': transport,
                                   'wireStateAttributes': page.get_by_test_id('wire-state').evaluate("el => ({...el.dataset})") if page.get_by_test_id('wire-state').count() else None}
            except Exception:  # noqa: BLE001
                pass
            result.update({'ok': False, 'error': str(error)})
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
