import React from 'react';
import {createRoot} from 'react-dom/client';
import {ConfirmationProvider} from '@mioon/ui/components/workbench-confirm';
import {translate} from '../../../packages/i18n/src/index.ts';
import ProjectEntry from '../../../apps/web/src/ProjectEntry.tsx';
import {useNativeProjectEntry} from '../../../apps/web/src/native-project-entry.ts';
import {UiPreferencesProvider} from '../../../apps/web/src/UiPreferencesProvider.tsx';
import {DEFAULT_UI_PREFERENCES} from '../../../packages/contracts/src/ui-preferences.ts';

const id = value => `77000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const params = new URLSearchParams(location.search);
const role = params.get('role') === 'editor' ? 'editor' : 'launcher';
const scenario = params.get('scenario');
const selection = {token: id(50), displayPath: '/synthetic/Q05 Example/Q05 Example.mioon', facts: {fileSystem: 'apfs', isLocal: true, volumeReadOnly: false, permissionBits: true, cloud: 'not-reported'}, template: {id: 'timeline-basics', version: 1, name: 'Q05 Example'}};
const trash = scenario.startsWith('trash-');
const project = {projectId: id(60), projectFile: trash ? params.get('projectFile') : selection.displayPath, fileIdentity: trash ? {dev: params.get('dev'), ino: params.get('ino')} : {dev: '1', ino: '60'}, name: 'Q05 Example', lastOpenedAt: null, summary: trash ? {description: '', revision: 1, createdAt: '2026-11-08T00:00:00.000Z', updatedAt: '2026-11-08T00:00:00.000Z', fps: 30, width: 1920, height: 1080, presetId: 'landscape_1080', shotCount: 0, durationFrames: 0, cover: null} : null};
const row = () => ({project: structuredClone(project), availability: {state: 'available'}, coverUrl: null});
const directory = {version: 1, appLibraryScope: 'a'.repeat(64), instanceId: id(1), registered: scenario === 'exists' || trash ? [row()] : []};
const originalDirectory = JSON.stringify(directory);
const counts = {panels: 0, instantiations: 0, opens: 0, receipts: 0, deletes: 0};
const admissions = [];
let holdNext = false, release = null;
async function readDirectory() {
  const held = holdNext;
  holdNext = false;
  if (held) await new Promise(resolve => {release = () => {release = null; setTimeout(resolve, 0);};});
  else await new Promise(resolve => setTimeout(resolve, 20));
  if (held && scenario === 'deny') throw Error('Synthetic directory refusal');
  return structuredClone(directory);
}
const context = {version: 2, role, windowId: id(role === 'editor' ? 30 : 31), contextId: id(32), backendId: id(1), initialProjectId: null, autoOpen: false, editorProjectId: role === 'editor' ? id(99) : null, editorPhase: role === 'editor' ? 'ready' : 'none', editorCount: role === 'editor' ? 1 : 0, entryMode: null, entryVersion: 0, entryReceipt: null, settingsSlot: null, settingsVersion: 0, selectionProjectId: null, selectionVersion: 0, locatorStatus: null, locatorIntent: null, quitting: false};
const capabilities = {ready: true, create: true, open: true, saveAs: false, duplicate: true, copyTo: true, adoptCopy: true, help: true, reveal: true, openOriginal: true, copySource: true, locationFacts: false, templates: [{id: 'timeline-basics', version: 1}]};
window.__mioonProjectEntries = {
  capabilities: async () => capabilities,
  listRecent: readDirectory,
  takePendingOpen: async () => null,
  chooseLocation: async () => {counts.panels++; await new Promise(resolve => setTimeout(resolve, 20)); return scenario === 'cancel' ? null : structuredClone(selection);},
  instantiateTemplate: async input => {
    counts.instantiations++;
    await new Promise(resolve => setTimeout(resolve, 20));
    if (scenario === 'exists') throw {code: 'PROJECT_FILE_EXISTS', status: 409, details: {}};
    directory.registered = [row()]; counts.receipts++;
    return {requestId: input.requestId, sourceProjectId: id(59), project: structuredClone(project), contentSequence: 0, contentToken: 'a'.repeat(32), versions: 0};
  },
  openRecent: async input => {
    counts.opens++;
    const result = window.__mioonProjectEntryAdmission.consume(input.entryToken, input.projectId);
    admissions.push(result);
    if (!result.accepted) throw Error('Production entry refused its sealed token');
    await new Promise(resolve => setTimeout(resolve, 20));
    return {status: 'opened', projectId: input.projectId, windowId: id(90)};
  },
};
const unavailable = async () => {throw Error('Unexpected fixture operation');};
const bridge = {context: async () => context, openProject: unavailable, publishLocatorStatus: async () => true, requestLocatorAction: async () => true, requestProjectEntry: async () => true, showProjects: async () => true, showSettings: unavailable, closeSettings: unavailable, editorStatus: async () => true, subscribe: () => () => {}};
const preferences = {get: async () => ({revision: 0, preferences: DEFAULT_UI_PREFERENCES, recentOpened: {}, recoveredDefaults: false, writable: true}), put: unavailable, markOpened: unavailable};
window.fetch = async (input, options) => {
  if (String(input) === '/api/rpc' && trash) {
    const request = JSON.parse(options.body);
    if (request.operation !== 'project.delete') throw Error('Unexpected fixture RPC');
    counts.deletes++;
    const receipt = await window.projectHomeFixture.trash(request.input);
    directory.registered = [];
    return new Response(JSON.stringify({ok: true, data: receipt}), {status: 200, headers: {'content-type': 'application/json'}});
  }
  if (String(input).startsWith('/api/background-tasks')) return new Response(JSON.stringify({ok: true, data: {version: 1, projects: [], nextCursor: null}}), {status: 200, headers: {'content-type': 'application/json'}});
  throw Error('Unexpected network request');
};
function Harness() {
  const entry = useNativeProjectEntry({context, bridge, rpc: unavailable, contractChecks: {parseCreateInput: value => value, readDirectory}});
  window.projectHomeExample.entry = entry;
  return <ProjectEntry controller={entry} editor={role === 'editor'} onSettings={unavailable}/>;
}
const root = createRoot(document.getElementById('root'));
window.projectHomeExample = {
  entry: null,
  holdNext: () => {holdNext = true;},
  waiting: () => release !== null,
  release: () => release(),
  collect: () => ({role, scenario, counts: {...counts}, admissions, registered: directory.registered.length, directoryUnchanged: originalDirectory === JSON.stringify(directory), visibility: document.visibilityState,
    dialogs: [...document.querySelectorAll('[data-testid=project-home-native-dialog]')].map(node => ({kind: node.getAttribute('data-state'), text: node.textContent, visible: node.checkVisibility()})),
    notices: [...document.querySelectorAll('[data-testid=project-home-native-notice]')].map(node => ({text: node.textContent, visible: node.checkVisibility()})),
    messages: {cancelled: translate('zh-Hans', 'projectHomeNative.example.cancelled'), exists: translate('zh-Hans', 'projectHomeNative.example.exists')}, parent: window.projectHomeExample.entry.getState()}),
  unmount: () => root.unmount(),
};
root.render(<ConfirmationProvider><UiPreferencesProvider client={preferences}><Harness/></UiPreferencesProvider></ConfirmationProvider>);
