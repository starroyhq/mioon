import {canonicalPrevisValue, defaultPrevisScene, isPrevisNodeRecord} from '@mioon/contracts';
import type {PrevisNodeRecord, PrevisScene} from '@mioon/contracts';

// Format 5 admits previs node writes only through the unified sequence entry:
// `sequence.preview` builds the envelope (scene-revision CAS, subject validation)
// and `sequence.commit` applies it as one history-13 step. The previs editor, its
// autosave and its create flow keep talking the legacy `previs.create` /
// `previs.scene.set` shapes; this adapter is the one place that translates them.
// Thumbnails stay a derived cache and pass straight through: format 5 accepts
// `previs.thumbnail.set` outside history under the same scene revision.
export type PrevisEditorRpc = (operation: string, input: Record<string, unknown>) => Promise<unknown>;
type Row = Record<string, unknown>;
interface Failure {code?: unknown; status?: unknown; message?: unknown; details?: unknown}

const failure = (code: string, message: string, status: number, details?: unknown): Error =>
  Object.assign(new Error(message), {code, status, ...(details === undefined ? {} : {details})});
const isRecord = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value);
const codeOf = (error: unknown): string => typeof (error as Failure | null)?.code === 'string' ? String((error as Failure).code) : 'BACKEND_PROTOCOL_ERROR';
const statusOf = (error: unknown): number => typeof (error as Failure | null)?.status === 'number' ? Number((error as Failure)!.status) : 500;

/** Deterministic UUID for the pre-allocated previs node of one create request:
 * a retried create keeps the same node identity instead of adding a second one. */
async function createNodeId(requestId: string): Promise<string> {
  const bytes = new TextEncoder().encode(`mioon.previs-create-node.v1:${requestId}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  digest[6] = (digest[6]! & 0x0f) | 0x40;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = Array.from(digest.subarray(0, 16), byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Read one previs node back through the existing full-project read: that is
 * the only read entry that returns a `PrevisNodeRecord` for the canvas. */
async function readPrevisNode(rpc: PrevisEditorRpc, projectId: string, nodeId: string): Promise<PrevisNodeRecord | null> {
  let project: unknown;
  try { project = await rpc('project.get', {projectId}); }
  catch { return null; }
  if (!isRecord(project) || !Array.isArray(project.nodes)) return null;
  const node = project.nodes.find(item => isPrevisNodeRecord(item) && item.id === nodeId);
  return node ?? null;
}

/** The autosave understands exactly two answers: a node that confirms the save
 * (revision +1, same scene) or a `REVISION_CONFLICT` whose details carry the
 * current node, so a lost reply is recognized as applied and a foreign edit can
 * be reloaded or overwritten. The adapter reproduces that contract. */
function revisionConflict(current: PrevisNodeRecord, expectedSceneRevision: number): Error {
  return failure('REVISION_CONFLICT', 'Previs scene changed since it was read', 409, {
    entityId: current.id, expectedSceneRevision, currentSceneRevision: current.sceneRevision, current,
  });
}

interface Options {
  readonly rpc: PrevisEditorRpc;
  /** `data.projectFormatVersion === 5` of the open project. */
  readonly format5: boolean;
  readonly projectId: () => string | null;
  readonly requestId: () => string;
}

export function createPrevisEditorRpc(options: Options): PrevisEditorRpc {
  const endpoint = (operation: string, input: Row): Promise<unknown> => options.rpc(operation, input);
  const preview = async (projectId: string, requestId: string, intent: Row): Promise<{envelope: Row; planDigest: string}> => {
    const result = await endpoint('sequence.preview', {projectId, requestId, previsIntent: {side: 'board', operation: intent}});
    if (isRecord(result) && result.ok === false) throw failure(String(result.code ?? 'SEQUENCE_EDIT_PATCH_INVALID'), 'The format-5 previs action did not pass preview', 409, {ids: result.ids});
    if (!isRecord(result) || !isRecord(result.envelope) || typeof result.planDigest !== 'string') {
      throw failure('BACKEND_PROTOCOL_ERROR', 'The previs preview result is invalid', 502);
    }
    return {envelope: result.envelope, planDigest: result.planDigest};
  };
  const commit = async (projectId: string, envelope: Row, planDigest: string): Promise<void> => {
    await endpoint('sequence.commit', {projectId, envelope, expectedPlanDigest: planDigest});
  };

  async function sceneSet(projectId: string, input: Row): Promise<PrevisNodeRecord> {
    const nodeId = String(input.nodeId ?? ''), expectedSceneRevision = Number(input.expectedSceneRevision);
    let prepared: {envelope: Row; planDigest: string};
    try {
      prepared = await preview(projectId, String(input.requestId ?? ''), {kind: 'previs-scene-set', nodeId,
        expectedSceneRevision, scene: input.scene as PrevisScene});
    } catch (error) {
      const current = await readPrevisNode(endpoint, projectId, nodeId);
      // A save whose reply was lost leaves a newer revision; anything else keeps
      // its own failure code so the editor offers retry instead of a conflict.
      if (current && current.sceneRevision !== expectedSceneRevision) throw revisionConflict(current, expectedSceneRevision);
      if (current === null && codeOf(error) !== 'BACKEND_PROTOCOL_ERROR') throw failure(codeOf(error), 'The previs save did not pass the unified entry', statusOf(error));
      throw error;
    }
    try { await commit(projectId, prepared.envelope, prepared.planDigest); }
    catch (error) {
      const code = codeOf(error);
      const current = await readPrevisNode(endpoint, projectId, nodeId);
      if (code === 'SEQUENCE_EDIT_REVISION_CONFLICT' || code === 'SEQUENCE_EDIT_PATCH_INVALID') {
        if (current) throw revisionConflict(current, expectedSceneRevision);
      }
      throw error;
    }
    const saved = await readPrevisNode(endpoint, projectId, nodeId);
    if (!saved) throw failure('BACKEND_PROTOCOL_ERROR', 'The previs node could not be read back after saving', 502);
    return saved;
  }

  async function create(projectId: string, input: Row): Promise<PrevisNodeRecord> {
    const requestId = String(input.requestId ?? ''), nodeId = await createNodeId(requestId);
    const label = typeof input.label === 'string' ? input.label : '';
    const position = isRecord(input.position) ? {x: Number(input.position.x), y: Number(input.position.y)} : {x: 0, y: 0};
    const sameCreate = (node: PrevisNodeRecord | null): boolean => Boolean(node && node.label === label &&
      canonicalPrevisValue(node.position) === canonicalPrevisValue(position) && canonicalPrevisValue(node.scene) === canonicalPrevisValue(defaultPrevisScene()));
    let prepared: {envelope: Row; planDigest: string};
    try {
      prepared = await preview(projectId, requestId, {kind: 'previs-create', nodeId, label, position});
    } catch (error) {
      // A retried create whose first reply was lost finds its node already
      // there: same identity, same label and position, still the default scene.
      const current = await readPrevisNode(endpoint, projectId, nodeId);
      if (sameCreate(current)) return current!;
      throw failure(codeOf(error), 'The previs create did not pass the unified entry', statusOf(error));
    }
    try { await commit(projectId, prepared.envelope, prepared.planDigest); }
    catch (error) {
      const current = await readPrevisNode(endpoint, projectId, nodeId);
      if (sameCreate(current)) return current!;
      throw error;
    }
    const created = await readPrevisNode(endpoint, projectId, nodeId);
    if (!created) throw failure('BACKEND_PROTOCOL_ERROR', 'The previs node could not be read back after creating', 502);
    return created;
  }

  return async (operation, input) => {
    if (!options.format5) return options.rpc(operation, input);
    const projectId = String(input.projectId ?? options.projectId() ?? '');
    if (operation === 'previs.scene.set') return sceneSet(projectId, input);
    if (operation === 'previs.create') return create(projectId, input);
    return options.rpc(operation, input);
  };
}
