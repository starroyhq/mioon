import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test, {type TestContext} from 'node:test';
import {installDesktopUpdateNetworkPolicy} from '../apps/desktop/src/desktop-update-network.ts';

type BeforeRequest = (request: {url: string; method: string}, reply: (response: {cancel: boolean}) => void) => void;
type BeforeSendHeaders = (request: {requestHeaders: Record<string, string>},
  reply: (response: {requestHeaders: Record<string, string>}) => void) => void;

function fixture(t: TestContext, manifest?: string) {
  const root = mkdtempSync(path.join(tmpdir(), 'mioon-update-network-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  if (manifest !== undefined) writeFileSync(path.join(root, 'app-update.yml'), manifest);
  let beforeRequest: BeforeRequest | undefined;
  let beforeSend: BeforeSendHeaders | undefined;
  const updater: {logger: unknown; netSession: unknown} = {
    logger: console,
    netSession: {webRequest: {
      onBeforeRequest(listener: BeforeRequest) {beforeRequest = listener;},
      onBeforeSendHeaders(listener: BeforeSendHeaders) {beforeSend = listener;},
    }},
  };
  installDesktopUpdateNetworkPolicy(updater as Parameters<typeof installDesktopUpdateNetworkPolicy>[0], root);
  assert.equal(updater.logger, null);
  return {
    accepts(url: string, method = 'GET') {
      let answer: boolean | undefined;
      assert.ok(beforeRequest);
      beforeRequest({url, method}, ({cancel}) => {answer = !cancel;});
      assert.equal(typeof answer, 'boolean');
      return answer;
    },
    headers(requestHeaders: Record<string, string>) {
      let answer: Record<string, string> | undefined;
      assert.ok(beforeSend);
      beforeSend({requestHeaders}, response => {answer = response.requestHeaders;});
      assert.ok(answer);
      return answer;
    },
  };
}

const github = 'https://github.com/starroyhq/mioon/releases';
const releaseAsset = 'https://release-assets.githubusercontent.com/github-production-release-asset/1412990290/00000000-0000-0000-0000-000000000012';

test('production admits only the Mioon release feed, macOS update assets and its GitHub CDN redirects', t => {
  const {accepts} = fixture(t, 'provider: github\nowner: starroyhq\nrepo: mioon\nreleaseType: release\n');
  for (const url of [github + '.atom', github + '/latest', github + '/tag/v0.2.1',
    'https://api.github.com/repos/starroyhq/mioon/releases/latest', github + '/download/v0.2.1/latest-mac.yml',
    github + '/download/v0.2.1/mioon-0.2.1-mac.zip', github + '/download/v0.2.0/mioon-0.2.0-mac.zip.blockmap',
    releaseAsset + '?sig=synthetic-signature&jwt=synthetic-token']) assert.equal(accepts(url), true);
  for (const url of ['https://example.invalid/updates/latest-mac.yml', 'http://127.0.0.1:24831/latest-mac.yml',
    github.replace('/starroyhq/mioon/', '/other/repo/') + '/latest', github + '/latest?projectId=fixture',
    github + '/tag/v0.2.1-beta', github + '/download/v0.2.1/mioon-0.2.1-mac.dmg',
    releaseAsset.replace('1412990290', '1234567890'), releaseAsset + '?uid=fixture',
    github.replace('https://', 'http://') + '/latest']) assert.equal(accepts(url), false);
  assert.equal(accepts(github + '/latest', 'POST'), false);
});

test('a packaged candidate uses only its fixed loopback directory and generic provider cache buster', t => {
  const {accepts} = fixture(t, "provider: generic\nurl: 'http://127.0.0.1:24831/updates'\nupdaterCacheDirName: synthetic-updater\n");
  assert.equal(accepts('http://127.0.0.1:24831/updates/latest-mac.yml?noCache=ab18'), true);
  assert.equal(accepts('http://127.0.0.1:24831/updates/mioon-0.2.1-mac.zip'), true);
  for (const url of ['http://127.0.0.1:24832/updates/latest-mac.yml', 'http://localhost:24831/updates/latest-mac.yml',
    'http://127.0.0.1:24831/elsewhere/latest-mac.yml', 'http://127.0.0.1:24831/updates/latest-mac.yml?noCache=ab18&project=fixture',
    'http://127.0.0.1:24831/updates/mioon-0.2.1-mac.zip?token=fixture', github + '/latest']) assert.equal(accepts(url), false);
});

test('a generic manifest for a remote host grants no exception', t => {
  const {accepts} = fixture(t, 'provider: generic\nurl: https://example.invalid/updates\n');
  assert.equal(accepts('https://example.invalid/updates/latest-mac.yml'), false);
  assert.equal(accepts('http://127.0.0.1:24831/latest-mac.yml'), false);
});

test('the transport drops private metadata while preserving negotiation and range headers', t => {
  const {headers} = fixture(t);
  assert.deepEqual(headers({'x-user-staging-id': 'fixture', Cookie: 'fixture', authorization: 'fixture',
    ReFeReR: 'fixture', 'X-Project-Id': 'fixture', 'X-Local-Path': 'fixture', 'user-agent': 'fixture',
    'Cache-Control': 'no-cache', Accept: 'application/json', Range: 'bytes=0-7'}), {
    'Cache-Control': 'no-cache', Accept: 'application/json', Range: 'bytes=0-7', 'User-Agent': 'Mioon updater',
  });
});
