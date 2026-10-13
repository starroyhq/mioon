import { readEditorWindowClose } from './editor-window-close.ts';
import type { EditorCloseOwnerSnapshot } from './editor-window-close.ts';
import { parseLauncherProject } from './launcher-state.ts';
interface DraftOwner { getEditorCloseSnapshot(): EditorCloseOwnerSnapshot }
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const settingsValue = (value: unknown): readonly unknown[] => {
  if (!record(value) || !record(value.rateControl)) throw new TypeError('Invalid export settings close state');
  return [value.profileId, value.resolution, value.rateControl.mode, value.rateControl.quality ?? null, value.rateControl.targetKbps ?? null];
};
/** No payload, filenames, credentials or media are retained. An uncertain
 * import has no replay receipt in the old API: it remains an honest unknown
 * until this window is explicitly closed through the distinct risk decision. */
export function createEditorWindowInputs() {
  let serial = 0, importSerial = 0, unknownImports = 0, lastImportProject: string | null = null;
  let createSerial = 0, createUnknown = false, createFlight: object | null = null, createProject: string | null = null;
  const flights = new Set<object>();
  return {
    changed() { serial++; },
    canCreateProject: () => !createUnknown && createFlight === null,
    beginProjectCreate(projectId: string | null): object | null {
      if (createUnknown || createFlight) return null;
      createProject = projectId; createFlight = Object.freeze({ serial: ++createSerial }); serial++;
      return createFlight;
    },
    validateProjectCreate(token: object, value: unknown, name: string, description: string) {
      const project = parseLauncherProject(value);
      if (project.name !== name || project.description !== description) throw new Error('未收到与原输入一致的新建项目确认，请保留当前窗口并核对项目列表。');
      // The exact business ACK settles creation before any follow-up list/read.
      // A later refresh failure cannot turn this accepted create into unknown.
      if (createFlight === token) { createFlight = null; serial++; }
    },
    failProjectCreate(token: object, outcome: { dispatched: boolean; rejected?: boolean }) {
      if (createFlight !== token) return;
      createFlight = null; serial++;
      if (outcome.dispatched && outcome.rejected !== true) createUnknown = true;
    },
    finishProjectCreate(token: object | null) {
      // runSession may return at its pre-dispatch busy guard. Never clear a
      // latched unknown, or an operation owned by a subsequent invocation.
      if (token && createFlight === token) { createFlight = null; serial++; }
    },
    beginImport(projectId: string) { const token = Object.freeze({ projectId, serial: ++importSerial }); flights.add(token); serial++; return token; },
    finishImport(token: object | null, unknown: boolean) {
      if (!token || !flights.delete(token)) return;
      serial++;
      if (unknown) { unknownImports++; lastImportProject = 'projectId' in token && typeof token.projectId === 'string' ? token.projectId : null; }
    },
    read({ clip, shot, delivery, busy, settings, defaultSettings, range, navigation = false }: {
      readonly clip?: DraftOwner | null; readonly shot?: DraftOwner | null; readonly delivery?: DraftOwner | null;
      readonly busy: ReadonlySet<string>; readonly settings?: { getState(): unknown } | null;
      readonly navigation?: boolean; readonly defaultSettings: unknown; readonly range?: { getState(): unknown } | null;
    }) {
      const s = settings?.getState(), r = range?.getState();
      const selected = record(s) ? settingsValue(s.exportSettings) : [], baseline = settingsValue(defaultSettings);
      const rd = record(r) && record(r.draft) ? r.draft : null;
      const snapshot = readEditorWindowClose({ clip, shot, delivery,
        importState: { owner: flights, dirty: false, inflight: flights.size > 0, unknown: unknownImports > 0,
          identity: ['asset.import', serial, importSerial, unknownImports, lastImportProject] },
        mutationState: { owner: busy, dirty: false, inflight: createFlight !== null || [...busy].some(key => !navigation || !key.endsWith(':project-create-flow') && !key.endsWith(':structure')),
          unknown: createUnknown, identity: [serial, busy.size, 'project.create', createSerial, createProject, createUnknown] },
        exportSettings: { owner: settings, dirty: selected.length > 0 && selected.some((v, i) => !Object.is(v, baseline[i])), inflight: false, unknown: false,
          identity: [record(s) && typeof s.scope === 'string' ? s.scope : null, record(s) && typeof s.version === 'number' ? s.version : 0] },
        exportRange: { owner: range, dirty: Boolean(rd && (rd.mode !== 'whole' || rd.startText !== '' || rd.endText !== '')), inflight: false, unknown: false,
          identity: [record(r) && typeof r.scope === 'string' ? r.scope : null, record(r) && typeof r.version === 'number' ? r.version : 0] },
      });
      return { dirty: snapshot.dirty, busy: snapshot.reasons.some(reason => reason.endsWith('-inflight')),
        unknown: snapshot.reasons.some(reason => reason.endsWith('-unknown')), identity: snapshot.identity };
    },
  };
}

