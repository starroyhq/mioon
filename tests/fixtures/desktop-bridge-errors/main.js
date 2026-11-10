import {app, BrowserWindow, ipcMain, session} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {createProjectEntryDesktopHost} from '../../../apps/desktop/src/project-entry-desktop-host.ts';
import {PROJECT_ENTRY_DESKTOP_CHANNEL, PROJECT_ENTRY_DESKTOP_LIMITS} from '../../../packages/contracts/src/project-entry-desktop.ts';
import {NATIVE_ASSET_MEDIA_CHANNEL} from '../../../packages/contracts/src/asset-media-native.ts';

const directory = __dirname;
const config = JSON.parse(fs.readFileSync(path.join(directory, 'config.json'), 'utf8'));
for (const name of ['profile', 'session', 'cache', 'logs', 'crashes', 'files']) fs.mkdirSync(path.join(directory, name));
app.setPath('userData', path.join(directory, 'profile'));
app.setPath('sessionData', path.join(directory, 'session'));
app.setPath('logs', path.join(directory, 'logs'));
app.setPath('crashDumps', path.join(directory, 'crashes'));
app.commandLine.appendSwitch('disk-cache-dir', path.join(directory, 'cache'));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const projectId = '77000000-0000-4000-8000-000000000001';
const assetId = '77000000-0000-4000-8000-000000000002';
const previewToken = '77000000-0000-4000-8000-000000000003';
const facts = {fileSystem: 'apfs', isLocal: true, volumeReadOnly: false, permissionBits: true, cloud: 'not-reported'};
const capabilities = {ready: true, create: true, open: true, saveAs: false, duplicate: true, copyTo: true, adoptCopy: true, templates: [{id: 'timeline-basics', version: 1}]};
const files = path.join(directory, 'files');
const sourceFile = path.join(files, 'copy.mioon');
fs.writeFileSync(sourceFile, 'Synthetic bridge fixture only\n', {flag: 'wx'});
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const originalSha256 = sha(sourceFile);
const sourceStat = fs.statSync(sourceFile, {bigint: true});
const source = {sourceProjectId: projectId, sourceFile, sourceIdentity: {dev: String(sourceStat.dev), ino: String(sourceStat.ino)}, sourceStamp: {contentSequence: 0, contentToken: 'a'.repeat(32)}};
const details = {projectId, requestId: 'fixture-template-request', operation: 'instantiateTemplate', database: 'project', reason: 'occupied', invalidReason: 'fixture'};
const mediaInput = {projectId, previewToken, requestId: 'fixture-media-request'};
const mediaSuccess = {status: 'applied', assets: [{id: assetId, projectId, name: 'Fixture asset', mimeType: 'video/mp4', sizeBytes: 1, referenceRevision: 2, sha256: null, fingerprint: {sizeBytes: 1, mtimeMs: 0, sampledSha256: 'a'.repeat(64), fullSha256: null}, hashState: 'sampled', url: `/api/projects/${projectId}/media/${assetId}`}], confirmedDirectories: []};
const results = [];
let win, host, scenario = '', offset = 0, releaseChoice, choiceEntered = false;
const realNow = Date.now;
Date.now = () => realNow() + offset;
const counts = {adoptCopy: 0, duplicate: 0, instantiateTemplate: 0};
const failure = (code, status = 409, more = {}) => Object.assign(new Error('Synthetic backend rejection'), {code, status, details: more});
const check = (condition, code) => {if (!condition) throw new Error(code);};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(condition) {
  const start = performance.now();
  while (performance.now() - start < 10000) {if (await condition()) return; await pause(20);}
  throw new Error('FIXTURE_TIMEOUT');
}
const page = expression => win.webContents.executeJavaScript(expression);
const call = (method, input) => page(`window.desktopBridgeErrors.call(${JSON.stringify(method)}, ${JSON.stringify(input)})`);
const pair = (kind, method, input) => page(`window.desktopBridgeErrors.pair(${JSON.stringify(kind)}, ${JSON.stringify(method)}, ${JSON.stringify(input)})`);
function errorPair(result, expected, {media = false, write = true, transport = false} = {}) {
  check(!result.raw.resolved && !result.client.resolved, 'EXPECTED_REJECTIONS');
  const raw = result.raw.error, client = result.client.error;
  if (config.baseline || transport) {
    check(raw.isError && raw.code === null && raw.status === null && raw.details === null && raw.keys.length === 0, 'EXPECTED_ERROR_PROPERTY_LOSS');
    if (media && write) check(client.isError && client.code === 'ASSET_RELINK_UNAVAILABLE' && client.status === null && client.outcomeUnknown === true, 'EXPECTED_BASELINE_UNKNOWN');
    else check(client.isError && client.code === null && client.status === null, 'EXPECTED_BASELINE_CLIENT_LOSS');
  } else {
    check(!raw.isError && raw.code === expected.code && raw.status === expected.status, 'EXPECTED_CLONEABLE_REJECTION');
    check(client.isError && client.code === expected.code && client.status === expected.status, 'EXPECTED_PAGE_ERROR');
    if (!media) check(isDeepStrictEqual(raw.details, expected.details) && isDeepStrictEqual(client.details, expected.details), 'EXPECTED_COMPLETE_DETAILS');
    if (media) check(client.outcomeUnknown === (write && (expected.status >= 500 || ['ASSET_MEDIA_NATIVE_OUTCOME_UNKNOWN', 'PROJECT_ENTRY_OUTCOME_UNKNOWN'].includes(expected.code))), 'EXPECTED_EXISTING_UNKNOWN_RULE');
  }
}
async function run(name, operation) {
  scenario = name;
  try {const observation = await operation(); results.push({name, passed: true, observation});}
  catch (error) {results.push({name, passed: false, error: /^[A-Z_]+$/u.test(error?.message ?? '') ? error.message : 'FIXTURE_OPERATION_FAILED'});}
}
app.whenReady().then(async () => {
  check(process.versions.electron === '44.7.0', 'UNEXPECTED_ELECTRON_VERSION');
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, respond) => respond(false));
  session.defaultSession.webRequest.onBeforeRequest({urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*']}, (_request, respond) => respond({cancel: true}));
  win = new BrowserWindow({show: false, webPreferences: {preload: path.join(directory, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false}});
  win.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
  win.webContents.on('will-navigate', event => event.preventDefault());
  const owner = {window: win, windowId: randomUUID(), backendId: randomUUID(), contextId: randomUUID(), projectId, isCurrent: () => !win.isDestroyed()};
  const copy = input => ({requestId: input.requestId, sourceProjectId: projectId, project: {projectId: '77000000-0000-4000-8000-000000000004', projectFile: input.projectFile, fileIdentity: {dev: '1', ino: '2'}, name: 'Fixture project', lastOpenedAt: null, summary: null}, contentSequence: 1, contentToken: 'b'.repeat(32), versions: 0});
  host = createProjectEntryDesktopHost({
    ownerForEvent: event => event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame ? owner : null,
    backend: {
      capabilities: async () => capabilities,
      openPath: async () => {throw failure('PROJECT_FILE_COPY');},
      observeSource: async () => ({source, name: 'Fixture copy', original: null}),
      adoptCopy: async () => {counts.adoptCopy++; throw new Error('UNEXPECTED_ADOPTION');},
      duplicate: async input => {counts.duplicate++; return copy(input);},
      instantiateTemplate: async () => {counts.instantiateTemplate++; throw failure('PROJECT_FILE_EXISTS', 409, details);},
      release() {},
    },
    isReady: () => true,
    chooseDirectory: async () => files,
    chooseOpenFile: async () => sourceFile,
    chooseSaveFile: async () => {
      if (scenario === 'permission-eacces' || scenario === 'permission-eperm') throw Object.assign(new Error('Synthetic permission refusal'), {code: scenario.endsWith('eacces') ? 'EACCES' : 'EPERM'});
      if (scenario === 'host-busy') {choiceEntered = true; return await new Promise(resolve => {releaseChoice = resolve;});}
      return path.join(files, scenario + '.mioon');
    },
    probeLocation: async () => facts,
    admitLocation: async () => scenario !== 'location-rejected',
    adoptPrepared: async prepared => ({ok: true, targetWindowId: prepared.windowId, reason: 'accepted'}),
    openRecent: async () => {throw new Error('UNEXPECTED_RECENT_OPEN');},
  });
  ipcMain.handle(PROJECT_ENTRY_DESKTOP_CHANNEL, (event, input) => host.handle(event, input));
  // Only this main-side media protocol peer is synthetic. The complete real
  // preload and real renderer client still perform every validation and the
  // contextBridge crossing. No file is relinked and no outcome is inferred.
  ipcMain.handle(NATIVE_ASSET_MEDIA_CHANNEL, (event, input) => {
    check(event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame, 'UNOWNED_FRAME');
    if (scenario === 'media-transport') throw new Error('Synthetic transport rejection');
    if (scenario === 'media-success') return {ok: true, data: mediaSuccess};
    const error = scenario === 'media-5xx' ? {code: 'PROJECT_HOST_STOPPED', status: 503}
      : scenario === 'media-native-unknown' ? {code: 'ASSET_MEDIA_NATIVE_OUTCOME_UNKNOWN', status: 409}
      : scenario === 'media-entry-unknown' ? {code: 'PROJECT_ENTRY_OUTCOME_UNKNOWN', status: 409}
      : {code: 'REVISION_CONFLICT', status: 409};
    check(input.action === 'apply' || input.action === 'discard', 'UNEXPECTED_MEDIA_ACTION');
    return {ok: false, error};
  });
  await win.loadFile(path.join(directory, 'index.html'));
  await waitFor(() => page('Boolean(window.desktopBridgeErrors?.ready)'));
  await run('adopt-expired', async () => {
    const selection = await call('openSelectedFile');
    check(selection.status === 'copy', 'EXPECTED_COPY_TICKET');
    offset += PROJECT_ENTRY_DESKTOP_LIMITS.ticketMs + 1;
    const result = await pair('entry', 'adoptCopy', {token: selection.token});
    errorPair(result, {code: 'PROJECT_ENTRY_TICKET_EXPIRED', status: 409, details: {}});
    check(counts.adoptCopy === 0 && sha(sourceFile) === originalSha256, 'EXPIRED_ADOPTION_EXECUTED');
    return {result, backendWrites: counts.adoptCopy, originalSha256, sha256: sha(sourceFile)};
  });
  await run('duplicate-expired', async () => {
    const selection = await call('chooseLocation', {purpose: 'duplicate', suggestedName: 'Fixture project', message: 'Fixture location'});
    offset += PROJECT_ENTRY_DESKTOP_LIMITS.ticketMs + 1;
    const result = await pair('entry', 'duplicate', {token: selection.token, projectId, requestId: randomUUID()});
    errorPair(result, {code: 'PROJECT_ENTRY_TICKET_EXPIRED', status: 409, details: {}});
    check(counts.duplicate === 0 && !fs.existsSync(selection.displayPath) && sha(sourceFile) === originalSha256, 'EXPIRED_DUPLICATION_EXECUTED');
    return {result, backendWrites: counts.duplicate, targetExists: false, originalSha256, sha256: sha(sourceFile)};
  });
  await run('template-existing-selection', async () => {
    const occupied = path.join(files, scenario + '.mioon'); fs.writeFileSync(occupied, 'Existing placeholder\n', {flag: 'wx'});
    const before = sha(occupied);
    const result = await pair('entry', 'chooseLocation', {purpose: 'template', suggestedName: 'Fixture example', message: 'Fixture location'});
    errorPair(result, {code: 'PROJECT_FILE_EXISTS', status: 409, details: {}});
    check(counts.instantiateTemplate === 0 && before === sha(occupied), 'EXISTING_TEMPLATE_CHANGED');
    return {result, backendWrites: 0, originalSha256: before, sha256: sha(occupied)};
  });
  await run('template-existing-mutation', async () => {
    const selection = await call('chooseLocation', {purpose: 'template', suggestedName: 'Fixture example', message: 'Fixture location'});
    const result = await pair('entry', 'instantiateTemplate', {token: selection.token, templateId: 'timeline-basics', templateVersion: 1, name: selection.template.name, requestId: randomUUID()});
    errorPair(result, {code: 'PROJECT_FILE_EXISTS', status: 409, details});
    check(counts.instantiateTemplate === 1, 'TEMPLATE_REQUEST_NOT_DEDUPLICATED');
    return {result, syntheticBackendCalls: counts.instantiateTemplate};
  });
  for (const name of ['location-rejected', 'permission-eacces', 'permission-eperm']) await run(name, async () => {
    const result = await pair('entry', 'chooseLocation', {purpose: 'duplicate', suggestedName: 'Fixture project', message: 'Fixture location'});
    errorPair(result, {code: name === 'location-rejected' ? 'PROJECT_LOCATION_REJECTED' : 'PROJECT_ACCESS_DENIED', status: name === 'location-rejected' ? 409 : 403, details: {}});
    return result;
  });
  await run('host-busy', async () => {
    await page('window.desktopBridgeErrors.startBlockedChoice()');
    await waitFor(() => choiceEntered);
    try {
      const result = await pair('entry', 'chooseLocation', {purpose: 'duplicate', suggestedName: 'Fixture project', message: 'Fixture location'});
      errorPair(result, {code: 'PROJECT_ENTRY_BUSY', status: 409, details: {}});
      return result;
    } finally {releaseChoice(null); await page('window.desktopBridgeErrors.finishBlockedChoice()');}
  });
  await run('entry-success', async () => {
    const selection = await call('chooseLocation', {purpose: 'duplicate', suggestedName: 'Fixture project', message: 'Fixture location'});
    const input = {token: selection.token, projectId, requestId: randomUUID()};
    const expected = copy({...input, projectFile: selection.displayPath});
    const result = await pair('entry', 'duplicate', input);
    check(result.raw.resolved && result.client.resolved && isDeepStrictEqual(result.raw.value, expected) && isDeepStrictEqual(result.client.value, expected) && counts.duplicate === 1, 'ENTRY_SUCCESS_DTO_CHANGED');
    return {unchanged: true, backendCalls: counts.duplicate};
  });
  for (const name of ['media-conflict', 'media-5xx', 'media-native-unknown', 'media-entry-unknown', 'media-transport']) await run(name, async () => {
    const result = await pair('media', 'apply', mediaInput);
    const expected = name === 'media-5xx' ? {code: 'PROJECT_HOST_STOPPED', status: 503} : name === 'media-native-unknown' ? {code: 'ASSET_MEDIA_NATIVE_OUTCOME_UNKNOWN', status: 409} : name === 'media-entry-unknown' ? {code: 'PROJECT_ENTRY_OUTCOME_UNKNOWN', status: 409} : {code: 'REVISION_CONFLICT', status: 409};
    errorPair(result, expected, {media: true, transport: name === 'media-transport'});
    return result;
  });
  await run('media-discard', async () => {
    const result = await pair('media', 'discard', {projectId, previewToken});
    errorPair(result, {code: 'REVISION_CONFLICT', status: 409}, {media: true, write: false});
    return result;
  });
  await run('media-success', async () => {
    const result = await pair('media', 'apply', mediaInput);
    check(result.raw.resolved && result.client.resolved && isDeepStrictEqual(result.raw.value, mediaSuccess) && isDeepStrictEqual(result.client.value, mediaSuccess), 'MEDIA_SUCCESS_DTO_CHANGED');
    return {unchanged: true};
  });
  const prefs = win.webContents.getLastWebPreferences();
  fs.writeFileSync(path.join(directory, 'results.json'), JSON.stringify({
    mode: config.baseline ? 'fixed-commit-baseline' : 'working-tree', electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node,
    isolation: {sandbox: prefs.sandbox, contextIsolation: prefs.contextIsolation, nodeIntegration: prefs.nodeIntegration},
    scope: 'Real complete preload and page clients; real entry host and injected clock; synthetic backend/chooser/location ports; media main-side IPC envelopes only. No actual project database or relink execution, no user data or network.',
    results,
  }, null, 2) + '\n');
  host.close(); win.destroy(); Date.now = realNow;
  app.exit(results.every(result => result.passed) ? 0 : 1);
}).catch(() => {
  host?.close(); if (win && !win.isDestroyed()) win.destroy(); Date.now = realNow;
  fs.writeFileSync(path.join(directory, 'error.json'), JSON.stringify({error: 'FIXTURE_INITIALIZATION_FAILED'}) + '\n');
  app.exit(1);
});
