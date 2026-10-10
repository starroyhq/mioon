// Development-only fixed checks, disabled by app.isPackaged in the host.
// No debug server, inspector port, renderer bridge or arbitrary test script input.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export async function runSmoke({ app, getWindow, getSession, getReady, getBackend, restart, paths, report, output, attemptDirtyQuit }) {
  const checks = [], skippedChecks = [];
  const record = (name, details = {}) => checks.push({ name, ok: true, ...details });
  const evaluate = expression => getWindow().webContents.executeJavaScript(expression, true);
  const rpc = (operation, input = {}) => evaluate(`fetch('/api/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(${JSON.stringify({ operation, input })})}).then(async r=>({status:r.status,body:await r.json()}))`);
  const waitFor = async (predicate, message, timeout = 60000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = await predicate();
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out: ${message}`);
  };
  const call = async (operation, input = {}) => {
    const response = await rpc(operation, input);
    assert.equal(response.status, 200, operation); assert.equal(response.body.ok, true, `${operation}: ${JSON.stringify(response.body.error)}`);
    return response.body.data;
  };
  const waitExport = id => waitFor(async () => {
    const job = await call('export.get', { exportId: id });
    if (job.status === 'failed') throw new Error(`Render failed: ${JSON.stringify(job.error)}`);
    return job.status === 'succeeded' ? job : false;
  }, 'actual FFmpeg timeline render');
  const metadata = JSON.parse(await readFile(path.join(app.getAppPath(), 'package.json'), 'utf8'));
  assert.deepEqual(report.identity, metadata.mioonDesktop);
  assert.equal(app.getName(), report.identity.productName);
  assert.equal(app.getPath('userData'), paths.userData);
  const marker = JSON.parse(await readFile(path.join(paths.userData, 'desktop-identity.json'), 'utf8'));
  assert.equal(marker.appId, report.identity.appId);
  record('embedded-app-identity-and-data-ownership', report.identity);
  assert.ok(process.versions.electron);
  assert.equal(report.runtime.electron, process.versions.electron);
  assert.ok(Number(report.runtime.node.split('.')[0]) >= 24);
  assert.notEqual(report.runtime.pid, process.pid);
  record('bundled-electron-utility-node-sqlite', report.runtime);
  const prefs = getWindow().webContents.getLastWebPreferences();
  assert.equal(prefs.sandbox, true);
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.nodeIntegration, false);
  assert.equal(prefs.webSecurity, true);
  record('renderer-sandbox-context-isolation-no-node');
  const globals = await evaluate(`({node:typeof process,require:typeof require,electron:typeof window.electron,bridge:typeof window.workbench,cookie:document.cookie,url:location.href,secureContext:isSecureContext})`);
  assert.equal(globals.node, 'undefined'); assert.equal(globals.require, 'undefined');
  assert.equal(globals.electron, 'undefined'); assert.equal(globals.bridge, 'undefined');
  assert.equal(globals.cookie, ''); assert.equal(globals.secureContext, true);
  assert.ok(!new URL(globals.url).searchParams.has('token'));
  record('no-node-no-bridge-no-readable-cookie-no-url-secret');
  const cookies = await getSession().cookies.get({ name: 'mioon_session' });
  assert.equal(cookies.length, 1);
  assert.equal(cookies[0].secure, true); assert.equal(cookies[0].httpOnly, true);
  assert.equal(cookies[0].sameSite, 'strict'); assert.equal(cookies[0].session, true);
  const oldToken = cookies[0].value;
  record('secure-httponly-strict-memory-cookie');
  const initial = await rpc('project.list');
  assert.equal(initial.status, 200); assert.equal(initial.body.ok, true);
  record('authenticated-loopback-fetch-with-secure-cookie');
  const providerCatalog=await call('provider.list');
  assert.deepEqual(providerCatalog.map(provider=>provider.id),['mock','runway','ark','veo','minimax','vidu']);
  assert.equal(providerCatalog.find(provider=>provider.mock).status,'available');
  for(const provider of providerCatalog.filter(provider=>!provider.mock)){
    assert.equal(provider.enabled,false);assert.equal(provider.liveVerified,false);assert.ok(provider.modelCapabilities.length);
  }
  record('v4-six-provider-catalog-safe-status', {providers:providerCatalog.map(({id,status})=>({id,status}))});
  const fixture = initial.body.data.find(project => project.name !== 'Electron utility persistence smoke');
  assert.ok(fixture, 'Synthetic multitrack example must be copied into isolated userData before launch');
  const anonymous = await fetch(`${getReady().url}/api/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operation: 'project.list' }) });
  assert.equal(anonymous.status, 401);
  record('anonymous-loopback-denied');
  assert.equal(await evaluate(`window.open('https://example.com') === null`), true);
  record('new-window-denied');
  assert.equal(await evaluate(`fetch('https://example.com').then(()=>false,()=>true)`), true);
  record('external-network-denied');
  assert.equal(await evaluate(`Notification.requestPermission()`), 'denied');
  record('permission-denied');
  const origin = getReady().url;
  const originalNavigation = getWindow().webContents.getURL();
  await evaluate(`location.assign('https://example.com'); true`);
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(getWindow().webContents.getURL(), originalNavigation);
  record('external-navigation-denied');
  const created = await rpc('project.create', { name: 'Electron utility persistence smoke' });
  assert.equal(created.body.ok, true);
  const projectId = created.body.data.id;
  await getWindow().loadURL(`${origin}/`);
  assert.equal((await rpc('project.list')).status, 200);
  record('reload-preserves-session');
  const connection = JSON.parse(await readFile(path.join(paths.userData, 'mcp-connection.json'), 'utf8'));
  assert.equal(connection.appId, report.identity.appId); assert.equal(connection.channel, report.identity.channel);
  assert.equal(connection.url, origin); assert.equal(connection.pid, report.runtime.pid);
  assert.equal((await stat(connection.tokenFile)).mode & 0o777, 0o600);
  assert.equal((await stat(path.join(paths.userData, 'mcp-connection.json'))).mode & 0o777, 0o600);
  record('private-mcp-discovery-files');
  await restart();
  const restored = await rpc('project.get', { projectId });
  assert.equal(restored.body.data.project.id, projectId);
  const rotated = (await getSession().cookies.get({ name: 'mioon_session' }))[0];
  assert.notEqual(rotated.value, oldToken);
  record('graceful-backend-restart-persists-data-rotates-auth');
  const crashedPid = getReady().runtime.pid;
  const exited = new Promise(resolve => getBackend().once('exit', resolve));
  process.kill(crashedPid, 'SIGKILL');
  await exited;
  await restart();
  assert.equal((await rpc('project.get', { projectId })).body.data.project.id, projectId);
  record('crashed-backend-recovery-clears-stale-lock');

  const timeline = await call('timeline.get', { projectId: fixture.id });
  assert.ok(timeline.clips.length >= 4, 'Use the actual synthetic layered example');
  const enqueue = () => call('timeline.render', { projectId: fixture.id, expectedRevision: timeline.revision,
    requestId: randomUUID(), purpose: 'preview' });
  const firstRender = await enqueue();
  const rendered = await waitExport(firstRender.id);
  assert.ok(rendered.assetId);
  const mediaStatus = await evaluate(`fetch(${JSON.stringify(rendered.url)}).then(async r=>({status:r.status,bytes:(await r.arrayBuffer()).byteLength,mime:r.headers.get('Content-Type')}))`);
  assert.equal(mediaStatus.status, 200); assert.ok(mediaStatus.bytes > 10000); assert.equal(mediaStatus.mime, 'video/mp4');
  record('real-shared-ffmpeg-layered-render-and-authenticated-media', { bytes: mediaStatus.bytes });

  async function waitForLongMediaChild() {
    let previous, since = 0;
    return waitFor(async () => {
      const pids = [...getBackend().mediaPids].filter(pid => getBackend().mediaKinds.get(pid) === 'ffmpeg');
      const current = pids[0];
      if (current && current === previous && Date.now() - since > 250) return pids;
      if (current !== previous) { previous = current; since = Date.now(); }
      return false;
    }, 'utility-owned active FFmpeg child', 15000);
  }
  // Do not intentionally orphan a real FFmpeg process merely to exercise the
  // retired numeric-PID cleanup assumption. Synthetic supervisor tests cover
  // the failed/unconfirmed outcome; native ownership recovery remains a gate.
  skippedChecks.push({ name: 'active-render-utility-crash-media-ownership-recovery',
    reason: 'Native orphan ownership and cleanup are unverified. A stale reported PID is not safe authority to signal; automatic restart is blocked when media exit is unknown.' });

  const interrupted = await enqueue();
  await waitForLongMediaChild();
  await restart();
  await waitExport(interrupted.id);
  record('graceful-restart-interrupts-and-recovers-active-render');

  await getWindow().loadURL(`${getReady().url}/?project=${fixture.id}`);
  await waitFor(() => evaluate(`Boolean(document.querySelector('[data-testid="project-switcher"]')?.textContent.includes(${JSON.stringify(fixture.name)}) && document.querySelector('[data-testid="timeline-panel"]') && document.querySelectorAll('[data-testid^="timeline-clip-"]').length >= 4 && !document.body.innerText.includes('正在打开项目'))`), 'final project and timeline ready');
  await evaluate(`window.__desktopTestPreventUnload = event => { event.preventDefault(); event.returnValue = false; }; window.addEventListener('beforeunload', window.__desktopTestPreventUnload); true`);
  const beforeCancelPid = getReady().runtime.pid;
  assert.equal(await attemptDirtyQuit(), false);
  assert.equal(getReady().runtime.pid, beforeCancelPid);
  assert.equal((await rpc('project.list')).status, 200);
  await evaluate(`window.removeEventListener('beforeunload', window.__desktopTestPreventUnload); delete window.__desktopTestPreventUnload; true`);
  record('actual-renderer-beforeunload-cancel-preserves-window-and-service');

  await evaluate(`document.querySelector('[data-testid="workspace-preview"]').click(); true`);
  await waitFor(() => evaluate(`Boolean(document.querySelector('[data-testid="central-preview"]:not(.workspace-hidden)'))`), 'preview workspace visible');
  await evaluate(`document.querySelector('[data-testid="preview-timeline-mode"]').click(); true`);
  await waitFor(() => evaluate(`Boolean(document.querySelector('[data-testid="timeline-preview-video"]'))`), 'rendered timeline video present');
  const decoded = await evaluate(`(async () => {
    const video = document.querySelector('[data-testid="timeline-preview-video"]');
    video.muted = true;
    if (video.readyState < 1) await new Promise((resolve,reject) => { video.addEventListener('loadedmetadata',resolve,{once:true});video.addEventListener('error',reject,{once:true}); });
    video.currentTime = 3;
    await video.play();
    await new Promise(resolve => video.requestVideoFrameCallback(resolve));
    video.pause();
    return {width:video.videoWidth,height:video.videoHeight,duration:video.duration,readyState:video.readyState,currentTime:video.currentTime};
  })()`);
  assert.equal(decoded.width, 720); assert.equal(decoded.height, 1280);
  assert.ok(decoded.duration >= 9.9 && decoded.duration <= 10.1); assert.ok(decoded.readyState >= 2);
  record('shared-react-ui-stable-and-real-timeline-video-decoded', decoded);
  await mkdir(path.dirname(output), { recursive: true });
  const screenshot = path.join(path.dirname(output), 'electron-workbench.png');
  await writeFile(screenshot, (await getWindow().webContents.capturePage()).toPNG());
  await writeFile(output, JSON.stringify({ ok: true, appVersion: app.getVersion(), runtime: report.runtime,
    ffmpeg: report.tools, checks, skippedChecks, screenshot }, null, 2) + '\n');
}
