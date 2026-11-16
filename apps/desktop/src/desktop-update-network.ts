import {readFileSync} from 'node:fs';
import path from 'node:path';
import type {AppUpdater} from 'electron-updater';

const repo = '/starroyhq/mioon/releases';
const version = String.raw`(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)`;
const gitHubReleasePath = new RegExp(`^${repo}/(?:latest|tag/v${version}|download/v${version}/(?:latest-mac\\.yml|mioon-${version}-mac\\.zip(?:\\.blockmap)?))$`, 'u');
const candidateAsset = new RegExp(`^mioon-${version}-mac\\.zip(?:\\.blockmap)?$`, 'u');
const gitHubAssetPath = /^\/github-production-release-asset(?:-2e65be)?\/1412990290\/[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/u;
const gitHubAssetQuery = new Set([
  'jwt', 'response-content-disposition', 'response-content-type', 'rscd', 'rsct', 'se', 'sig', 'ske',
  'skoid', 'sks', 'skt', 'sktid', 'skv', 'sp', 'spr', 'sr', 'sv',
]);
const allowedHeaders = new Set(['accept', 'accept-encoding', 'cache-control', 'range']);

function candidateFeed(resourcesPath: string): URL | undefined {
  try {
    const yaml = readFileSync(path.join(resourcesPath, 'app-update.yml'));
    if (yaml.length > 4096) return;
    // Only recognize the canonical electron-builder generic-provider manifest.
    // The updater still reads the packaged feed itself, including its provider.
    const text = yaml.toString('utf8');
    const providers = [...text.matchAll(/^provider:[ \t]*([^\r\n]+)\r?$/gmu)];
    const urls = [...text.matchAll(/^url:[ \t]*([^\r\n]+)\r?$/gmu)];
    if (providers.length !== 1 || providers[0]![1]!.trim() !== 'generic' || urls.length !== 1) return;
    const value = urls[0]![1]!.trim().replace(/^(['"])(.*)\1$/u, '$2');
    if (!/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}(?:\/[a-zA-Z\d_-]+)*\/?$/u.test(value)) return;
    const feed = new URL(value);
    if (!feed.pathname.endsWith('/')) feed.pathname += '/';
    return feed;
  } catch {
    // A missing or malformed packaged config has no candidate exception.
  }
}

function allowedRequest(url: URL, candidate: URL | undefined): boolean {
  if (url.username || url.password || url.hash) return false;
  if (candidate) {
    if (url.origin !== candidate.origin || !url.pathname.startsWith(candidate.pathname)) return false;
    const asset = url.pathname.slice(candidate.pathname.length);
    return asset === 'latest-mac.yml' ? !url.search || /^\?noCache=[0-9a-v]+$/u.test(url.search)
      : !url.search && candidateAsset.test(asset);
  }
  if (url.origin === 'https://github.com') {
    return !url.search && (url.pathname === repo + '.atom' || gitHubReleasePath.test(url.pathname));
  }
  if (url.origin === 'https://api.github.com') {
    return !url.search && url.pathname === '/repos' + repo + '/latest';
  }
  // GitHub can redirect release downloads to this signed asset endpoint.
  // Keep only this repository's bucket and the CDN's query fields.
  return (url.origin === 'https://release-assets.githubusercontent.com' || url.origin === 'https://objects.githubusercontent.com') &&
    gitHubAssetPath.test(url.pathname) && [...url.searchParams.keys()].every(key => gitHubAssetQuery.has(key));
}

/** ElectronHttpExecutor uses this dedicated session for metadata, assets and
 * redirects. Squirrel's separate private loopback feed remains untouched. */
export function installDesktopUpdateNetworkPolicy(updater: Pick<AppUpdater, 'netSession' | 'logger'>, resourcesPath: string): void {
  updater.logger = null;
  const candidate = candidateFeed(resourcesPath);
  const requests = updater.netSession.webRequest;
  requests.onBeforeRequest((details, callback) => {
    let allowed = false;
    try {allowed = details.method === 'GET' && allowedRequest(new URL(details.url), candidate);}
    catch { /* Malformed network destinations are unavailable. */ }
    callback({cancel: !allowed});
  });
  requests.onBeforeSendHeaders((details, callback) => {
    // The library adds a persistent staging UUID. An allowlist also excludes
    // cookies, credentials, referers and arbitrary configured request headers.
    const requestHeaders = Object.fromEntries(Object.entries(details.requestHeaders)
      .filter(([name]) => allowedHeaders.has(name.toLowerCase())));
    callback({requestHeaders: {...requestHeaders, 'User-Agent': 'Mioon updater'}});
  });
}
