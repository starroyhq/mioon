// Audited against services.mjs, references.mjs, timeline.mjs and jobs.mjs.
// Effects include work the call schedules/resumes, not just its synchronous RPC.
// These are advisory descriptions, never permission checks or authorization.
// Missing fields use conservative values; missing operations have no fallback.
const define = ({readOnly = false, idempotent = false, destructive = true,
  openWorld = true, databaseWrite = true, fileWrite = true, externalIO = true,
  localProcess = true, paidGeneration = true, notes}) => Object.freeze({
  readOnly, idempotent, destructive, openWorld, databaseWrite, fileWrite,
  externalIO, localProcess, paidGeneration, notes,
});
const read = {readOnly:true,idempotent:true,destructive:false,openWorld:false,
  databaseWrite:false,fileWrite:false,externalIO:false,localProcess:false,paidGeneration:false};
const localAdd = {...read,readOnly:false,idempotent:false,databaseWrite:true};
const localEdit = {...localAdd,destructive:true};
const replayEdit = {...localEdit,idempotent:true};
const generation = {...localAdd,idempotent:true,openWorld:true,fileWrite:true,
  externalIO:true,localProcess:true,paidGeneration:true};
const render = {...localAdd,idempotent:true,fileWrite:true,localProcess:true};

export const operationEffects = Object.freeze({
  'project.inspect': define({...read,notes:'Reads bounded, allowlisted project metadata; never initializes a timeline.'}),
  'asset.inspect': define({...read,notes:'Reads a bounded project-scoped metadata page; never reads or probes media files.'}),
  'shot.inspect': define({...read,notes:'Reads a bounded project-scoped metadata page with bounded prompt excerpts and truncation indication; omits media.'}),
  'timeline.inspect': define({...read,notes:'Reads bounded metadata of an existing timeline; reports absence without creating it.'}),
  'project.create': define({...localAdd,notes:'Creates a new project on every successful call; no request replay key.'}),
  'project.list': define({...read,notes:'Reads existing project records only.'}),
  'project.get': define({...localAdd,idempotent:true,notes:'Legacy full-project read may create the default empty timeline. Response shape and lazy initialization are preserved.'}),
  'asset.import': define({...localAdd,fileWrite:true,localProcess:true,notes:'Writes supplied bytes to a new managed file, invokes local ffprobe, and adds an asset. Failed decoding removes its new file.'}),
  'asset.list': define({...read,notes:'Reads existing asset records, including legacy media URLs; does not read media bytes.'}),
  'shot.create': define({...localAdd,notes:'Adds a shot and advances project revision; each successful call creates a new ID.'}),
  'shot.update': define({...localEdit,notes:'Replaces requested shot fields under revision checks; may remove previous text or reference choices.'}),
  'shot.reorder': define({...localEdit,notes:'Replaces shot ordering and advances project revision under a revision check.'}),
  'node.create': define({...localAdd,notes:'Adds a canvas node referencing existing managed assets; no media processing.'}),
  'node.update': define({...localEdit,notes:'Replaces requested node text, label or position under a revision check.'}),
  'edge.create': define({...localAdd,idempotent:true,notes:'Adds a decorative edge or returns the existing same-project/source/target edge.'}),
  'edge.delete': define({...localEdit,idempotent:true,notes:'Deletes a decorative edge; repeated input has no further effect and can return NOT_FOUND. Reference edges are rejected.'}),
  'reference.attach': define({...localAdd,idempotent:true,notes:'Adds a typed first-frame binding only to an empty slot and saves its exact replay response; no provider call.'}),
  'reference.detach': define({...replayEdit,notes:'Removes a typed edge and clears its owned reference slot; preserves source assets and snapshots. Exact request replay is durable.'}),
  'provider.list': define({...read,notes:'Reads in-process provider capabilities/configuration gates and local job counts; does not contact providers.'}),
  'generation.submit': define({...generation,notes:'Queues one generation per exact stable request; later worker work can upload references, submit a paid provider job, poll/download, run local media processes and publish assets/versions.'}),
  'job.get': define({...read,notes:'Reads the existing job record only; does not poll a provider or resume work.'}),
  'job.list': define({...read,notes:'Reads existing project job records only.'}),
  'job.retry': define({...generation,notes:'An explicit new attempt for a definitively failed job can incur another charge; exact replay of its new stable request does not create another attempt.'}),
  'job.cancel': define({...localEdit,idempotent:true,notes:'Stops local waiting and updates the job. Repetition after a terminal result has no effect; no remote cancellation or refund is promised.'}),
  'job.reconcile': define({...localEdit,openWorld:true,fileWrite:true,externalIO:true,localProcess:true,notes:'Contacts the existing provider task and updates/resumes local processing; may later download and publish media. Never submits new generation; repeated calls can update revisions and repeat network I/O.'}),
  'version.list': define({...read,notes:'Reads immutable version records only.'}),
  'version.select': define({...localEdit,notes:'Replaces the selected version and advances the shot revision; does not modify timeline clips.'}),
  'export.create': define({...render,notes:'Queues a frozen selected-shot export once per exact request; later worker work invokes local FFmpeg/ffprobe and writes managed output. No provider call.'}),
  'export.get': define({...read,notes:'Reads the export record only; does not render or read media bytes.'}),
  'timeline.get': define({...localAdd,idempotent:true,notes:'Legacy read creates default empty tracks when no timeline exists. Repeated reads do not add another timeline.'}),
  'timeline.history.get': define({...read,notes:'Reads existing history metadata without initializing a timeline.'}),
  'timeline.undo': define({...replayEdit,notes:'Restores a prior editable timeline state and advances revision/history cursor; preserves assets, generation and exports. Exact replay is durable.'}),
  'timeline.redo': define({...replayEdit,notes:'Restores a saved editable timeline state and advances revision/history cursor; exact replay is durable.'}),
  'timeline.track.add': define({...replayEdit,notes:'Adds a track and records an edit; a new branch can discard redo history. Exact replay is durable.'}),
  'timeline.track.update': define({...replayEdit,notes:'Replaces track fields and records an edit; a new branch can discard redo history. Exact replay is durable.'}),
  'timeline.clip.add': define({...replayEdit,notes:'Adds a fixed-asset clip and records an edit; a new branch can discard redo history. Exact replay is durable.'}),
  'timeline.clip.update': define({...replayEdit,notes:'Replaces clip fields and records an edit; a new branch can discard redo history. Exact replay is durable.'}),
  'timeline.clip.remove': define({...replayEdit,notes:'Removes a timeline clip, preserving its asset; a new branch can discard redo history. Exact replay is durable.'}),
  'timeline.clip.split': define({...replayEdit,notes:'Shortens the original clip and adds the right-hand clip; a new branch can discard redo history. Exact replay preserves the new ID.'}),
  'timeline.seed': define({...replayEdit,notes:'Copies selected shot assets into an empty timeline and records an edit; a new branch can discard redo history. Exact replay is durable.'}),
  'timeline.render': define({...render,notes:'Queues a frozen timeline render once per exact request; later worker work invokes local FFmpeg/ffprobe and writes managed output. No provider call.'}),
});

export function assertOperationEffectCoverage(schemas, effects = operationEffects) {
  const missing = Object.keys(schemas).filter(operation => !Object.hasOwn(effects, operation));
  const unknown = Object.keys(effects).filter(operation => !Object.hasOwn(schemas, operation));
  if (missing.length || unknown.length)
    throw new Error(`Operation effect coverage mismatch; missing: ${missing.join(', ') || 'none'}; unknown: ${unknown.join(', ') || 'none'}`);
}

export function operationEffect(operation) {
  if (!Object.hasOwn(operationEffects, operation)) throw new Error(`Operation effects are not defined: ${operation}`);
  return operationEffects[operation];
}

// Official MCP SDK 1.32.1 ToolAnnotations: these hints describe possible
// environment effects, not response freshness or permission to execute a tool.
export function effectAnnotations(effects) {
  const fields = ['readOnly', 'destructive', 'idempotent', 'openWorld'];
  if (!effects || fields.some(field => typeof effects[field] !== 'boolean'))
    throw new Error('Explicit operation effects are required for MCP annotations.');
  return Object.fromEntries(fields.map(field => [`${field}Hint`, effects[field]]));
}
