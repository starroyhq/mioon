import {lutResourceEffects} from './lut-resources.ts';
// Audited against services.mjs, local-mutations.mjs, references.mjs, timeline.mjs and jobs.mjs.
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
// These six operations are only replay-safe when a caller supplies a stable key.
// Their unconditional MCP idempotent hint must therefore remain false.
const optionalReplay = ' With an optional stable requestId, exact retries return the immutable original response; changed reuse conflicts. Keyless calls retain legacy behavior.';
const replayEdit = {...localEdit,idempotent:true};
const generation = {...localAdd,idempotent:true,openWorld:true,fileWrite:true,
  externalIO:true,localProcess:true,paidGeneration:true};
const render = {...localAdd,idempotent:true,fileWrite:true,localProcess:true};

export const operationEffects = Object.freeze({
  ...lutResourceEffects,
  'timeline.loudness.apply': define({...replayEdit,localProcess:true,notes:'Explicit project/revision/request-bound fixed-gain application. Replays a retained exact acknowledgement before media work. A new request rehashes owned audio sources and remeasures the complete original and candidate float mix, then atomically updates eligible clip gains, one undo history and an immutable receipt. No client gains, limiter, normalization, implicit export-profile change, network, model or payment. Socket interruption does not cancel accepted mutation; reconcile the same durable request. Restored workspaces may read captured receipts but cannot execute a new application.'}),
  'timeline.loudness.prepare': define({...read,localProcess:true,notes:'Explicit resource-intensive read of one complete saved timeline at its expected revision, fixed mix/measurement profiles and user-selected LUFS/dBTP target. Hashes owned potentially audible sources twice and streams pre-encode float PCM for the original and, when representable, an actually measured fixed-multiplier candidate. Bounded 120-second local observation; no queue, cache, persistent task, database/file write, automatic retry, network, model or paid generation. Results are ephemeral with applyAllowed always false, never edit/export authority. Read-only idempotence does not promise identical future measurements. Not a built-in Agent tool.'}),
  'timeline.audioPreview.plan': define({...read,notes:'Reads and validates an existing owned saved timeline plus bounded source lineage to plan at most 20 seconds of sound audition. Returns exact revision, source metadata/hash bindings and a fixed aggregate memory budget. No timeline initialization, media bytes, process, cache/file/database write, network or paid generation. A plan is not completed decoding; the separate authenticated fixed PCM resource performs bounded local decoding only after explicit preparation. Not a built-in Agent tool.'}),
  'workspace.restore.inspect': define({...read,notes:'Reads verified restored-workspace profile, non-secret origin, bounded held counts and operation availability. No paths, credentials, task transitions, storage repair, filesystem/media/network work or execution authority. Not a built-in Agent tool.'}),
  'workspace.backup.inspect': define({...read,notes:'Reads bounded database counts for a whole-workspace cold backup. No path arguments, file reads/writes, task reconciliation, credential access or process/network activity. Backend must close before offline capture; readiness is not an integrity or restoration guarantee.'}),
  'timeline.subtitle.add': define({...replayEdit,notes:'Adds one bounded manual subtitle under timeline CAS with a backend-generated ID and fixed local font profile. Saves the complete timeline, undo history and exact immutable acknowledgement in one transaction. No media read, process, network or generation.'}),
  'timeline.subtitle.update': define({...replayEdit,notes:'Updates only text or timing of an existing owned manual subtitle under timeline CAS and exact request replay. Preserves source media, frozen exports and other subtitles. No automatic transcription or media work.'}),
  'timeline.subtitle.remove': define({...replayEdit,notes:'Removes one owned manual subtitle under timeline CAS while retaining exact replay and undo history. Does not delete media, retained tasks or receipts; no external I/O.'}),
  'frame.extract': define({...render,notes:'Durably accepts one project/source-hash/30fps-mark-bound local PNG extraction before bounded FFmpeg work. Required stable requestId replays the immutable original acknowledgement without scheduling again. No provider or network access; originals are preserved.'}),
  'frame.request.get': define({...read,notes:'Reads the exact retained project-scoped frame acknowledgement. Never decodes, repairs or resumes a task.'}),
  'frame.task.get': define({...read,notes:'Reads an existing owned local frame task and safe result metadata. No file reads or work scheduling.'}),
  'frame.task.list': define({...read,notes:'Reads a bounded project-owned frame task page without resuming or creating work.'}),
  'frame.task.cancelQueued': define({...replayEdit,notes:'Explicitly cancels only queued or interrupted provably unstarted local extraction under task CAS. Exact replay is retained; running extraction is not reported cancelled.'}),
  'frame.task.recoverResult': define({...localAdd,idempotent:true,fileWrite:true,notes:'Explicitly verifies and publishes an existing complete task-bound PNG and manifest. Never reruns the decoder, submits generation or edits source media.'}),
  'image.profile.list': define({...read,notes:'Reads profiles and local availability; explicit includeSettingsRevision:true may include each eligible slot\'s non-secret configuration revision from the same safe snapshot. Default output is unchanged. No provider probe, decryption, approval or dispatch; enabled is not live verification.'}),
  'image.review.prepare': define({...localAdd,idempotent:true,notes:'Retains exact project/input/settings-bound pending image review; the official edit branch validates bounded owned local PNG bytes and freezes source provenance without granting approval, dispatch or payment authority. Same key with changed content conflicts; user approval is a separate authenticated UI route.'}),
  'image.review.get': define({...read,notes:'Reads an existing owned immutable image review and bounded attempt state. Never approves or dispatches.'}),
  'image.review.list': define({...read,notes:'Reads a bounded project-scoped review page. Never approves or dispatches.'}),
  'image.generate': define({...localAdd,idempotent:true,fileWrite:true,externalIO:true,openWorld:true,paidGeneration:true,notes:'Image generation can create local Mock output or a separately user-approved one-POST official or custom-compatible Images task through shared acceptance. The Mock/official edit branch reads one owned PNG and publishes a new immutable version without replacing its source. Direct unapproved live Images RPC is blocked; secrets and approval are not tool arguments. Exact historical replay never reschedules work. Declared effects include possible approved worker activity.'}),
  'image.request.get': define({...read,notes:'Reads the original project-scoped image acceptance receipt without dispatch, retry, recovery or status mutation.'}),
  'image.task.get': define({...read,notes:'Reads an existing owned image task; never calls an adapter or resumes it.'}),
  'image.task.list': define({...read,notes:'Reads a bounded project/group-scoped image task page without resuming work.'}),
  'image.group.get': define({...read,notes:'Reads one existing project-scoped image group and validates its current links without changes.'}),
  'image.group.list': define({...read,notes:'Reads a bounded page of existing project-owned image groups; does not create groups.'}),
  'image.version.list': define({...read,notes:'Reads a bounded page of immutable image versions with typed managed-asset ownership. No media bytes, paths or provider requests.'}),
  'image.task.cancelQueued': define({...replayEdit,notes:'Explicitly cancels only a durably undispatched queued/interrupted image task. Exact image-request replay is retained. Does not cancel a provider request or promise refunds.'}),
  'image.task.recoverResult': define({...localAdd,idempotent:true,fileWrite:true,notes:'Explicitly validates and publishes only an existing task-bound local PNG result receipt. Never invokes an image adapter or sends another provider request.'}),
  'image.task.remote.get': define({...read,notes:'Reads only an existing project-owned local ComfyUI run record and latest retained observation. Never contacts the endpoint, creates records, repairs evidence or resumes observation.'}),
  'image.task.observeRemote': define({...localAdd,idempotent:true,openWorld:true,externalIO:true,fileWrite:true,notes:'Durably admits one explicit observation under remote revision CAS and a globally retained image request key before network I/O. Schedules one bounded GET for the frozen ComfyUI prompt identity and at most one fixed output GET after complete graph/marker verification; valid PNG bytes can enter managed staging and publication. Exact replay returns the original acknowledgement without another GET. No POST, new generation, paid submission, automatic polling, endpoint changes or built-in Agent authority.'}),
  'subject.create': define({...localAdd,idempotent:true,notes:'Creates a project-scoped subject and frozen managed-image reference version with required exact replay. Reads only existing asset metadata and lineage; no media reads, provider calls, shot or timeline changes.'}),
  'subject.version.add': define({...localAdd,idempotent:true,notes:'Adds one immutable managed-image version and advances the subject head. Existing shot bindings retain their chosen version; review flags are derived without fan-out writes. Same-head asset rejects without writes.'}),
  'subject.binding.set': define({...replayEdit,notes:'Explicitly attaches, changes, acknowledges or unlinks a subject/style binding under independent binding and subject revisions. Unlink retains a tombstone. Pins selected versions and never edits shot first-frame references, generation snapshots or timelines.'}),
  'subject.list': define({...read,notes:'Reads a bounded project-scoped subject page with frozen current-version metadata; does not create rows or read media.'}),
  'subject.version.list': define({...read,notes:'Reads a bounded project/subject-scoped immutable version page, including older selections; no media paths or URLs.'}),
  'subject.binding.list': define({...read,notes:'Reads a bounded page scoped by exactly one shot or subject; retains unlink tombstones and derives review flags without updates.'}),
  'project.inspect': define({...read,notes:'Reads bounded, allowlisted project metadata; never initializes a timeline.'}),
  'asset.inspect': define({...read,notes:'Reads a bounded project-scoped metadata page; never reads or probes media files.'}),
  'shot.inspect': define({...read,notes:'Reads a bounded project-scoped metadata page with bounded prompt excerpts and truncation indication; omits media.'}),
  'timeline.inspect': define({...read,notes:'Reads bounded metadata of an existing timeline; reports absence without creating it.'}),
  'project.create': define({...localAdd,notes:'Creates a new project on every successful call; no request replay key.'}),
  'project.list': define({...read,notes:'Reads existing project records only.'}),
  'project.get': define({...localAdd,idempotent:true,notes:'Legacy full-project read may create the default empty timeline. Response shape and lazy initialization are preserved.'}),
  'asset.import': define({...localAdd,fileWrite:true,localProcess:true,notes:'Writes supplied bytes to a new managed file, invokes local ffprobe, and adds an asset. Failed decoding removes its new file.'}),
  'asset.range.get': define({...read,notes:'Reads the independent range of an existing owned video/audio asset; absence returns revision 0 and range null without creating any row or timeline. Uses the 30fps timeline timebase, not native/VFR frame indexes.'}),
  'asset.range.set': define({...replayEdit,notes:'Saves only independent source-range metadata under its own revision. Requires a stable requestId; exact retries return the immutable original response. Does not change assets, media, versions or timelines, run media processes, or contact providers.'}),
  'asset.disposition.list': define({...read,notes:'Reads only shared disposition metadata for an explicit ordered batch of 1–100 unique owned assets. Missing or foreign assets fail the entire batch. Absent metadata returns neutral with revision 0 without creating a row or timeline.'}),
  'asset.disposition.set': define({...replayEdit,notes:'Saves only shared neutral/favorite/rejected metadata under its own revision; neutral resets retain revision history. Requires a stable requestId; exact retries return the immutable original response. Never deletes an asset or changes its name, bytes, source range, versions or timeline; no provider calls or media processes.'}),
  'asset.waveform.request': define({...localAdd,destructive:true,localProcess:true,notes:'Explicitly schedules bounded local source-audio probing/decoding and writes only derived SQLite cache data. Admission or explicit retry can replace or evict terminal derived-cache entries; the destructive hint is limited to disposable cache data, never source or business records. No external I/O, paid generation, output media file, or project/timeline edit. Duplicate queued/running/ready requests reuse cache work, but explicit retry or rebuilding evicted cache can run again; no durable exact-mutation replay journal.'}),
  'asset.waveform.get': define({...read,notes:'Reads only existing project-scoped waveform cache with at most 2048 normalized source peaks in a 30fps exclusive-end range. Never probes media, schedules decoding, repairs cache, touches cache access time, writes SQLite, or changes a timeline. Absence/interruption stays explicit; peaks are raw source audio before timeline mixing.'}),
  'asset.list': define({...read,notes:'Reads existing asset records, including legacy media URLs; does not read media bytes.'}),
  'shot.create': define({...localAdd,notes:'Adds a shot and advances project revision; each successful keyless call creates a new ID.'+optionalReplay}),
  'shot.update': define({...localEdit,notes:'Replaces requested shot fields under revision checks; may remove previous text or reference choices.'+optionalReplay}),
  'shot.reorder': define({...localEdit,notes:'Replaces shot ordering and advances project revision under a revision check.'+optionalReplay}),
  'node.create': define({...localAdd,notes:'Adds a canvas node referencing existing managed assets; no media processing.'+optionalReplay}),
  'node.update': define({...localEdit,notes:'Replaces requested node text, label or position under a revision check.'+optionalReplay}),
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
  'version.select': define({...localEdit,notes:'Replaces the selected version and advances the shot revision; does not modify timeline clips.'+optionalReplay}),
  'export.create': define({...render,notes:'Queues a frozen selected-shot export once per exact request; later worker work invokes local FFmpeg/ffprobe and writes managed output. No provider call.'}),
  'export.get': define({...read,notes:'Reads the export record only; does not render or read media bytes.'}),
  'timeline.format.get': define({...read,notes:'Reads existing timeline output format, both revision fences and pristine-state eligibility. Never initializes a timeline, writes metadata or reads media.'}),
  'timeline.format.set': define({...replayEdit,notes:'Explicitly chooses one closed 30fps output preset only for a pristine timeline. Uses project and timeline CAS, immutable exact replay and the existing timeline task lane; creates only an absent timeline or updates its output dimensions/revision. Does not edit the project, enter undo history, rescale clips, read media or contact providers.'}),
  'timeline.get': define({...localAdd,idempotent:true,notes:'Legacy read creates default empty tracks when no timeline exists. Repeated reads do not add another timeline.'}),
  'timeline.history.get': define({...read,notes:'Reads existing history metadata without initializing a timeline.'}),
  'timeline.export.capabilities': define({...read,fileWrite:true,localProcess:true,notes:'Explicit bounded local compute proves the selected fixed MP4/H264 delivery profile. V1 retains its synthetic in-memory encode/mux; opt-in float v2 also creates and cleans a bounded owned private temporary MOV/concat/AAC proof. Reads an existing owned timeline without initialization. No project/database/source write, source decoding, network, credentials, paid generation or durable task. Availability is point-in-time; new custom exports and workers recheck separately.'}),
  'timeline.export.preflight': define({...read,localProcess:true,notes:'Reads an existing timeline and bounded managed source bytes, stream-hashes files and invokes local ffprobe metadata checks. Never initializes a timeline, writes database/cache/files, renders, fully decodes, or contacts providers. Repeated reads can observe source changes; idempotent is the conventional read-only hint, not a promise of identical or future-valid results. An incomplete check is not an export ban.'}),
  'timeline.export.samplePeak': define({...read,localProcess:true,notes:'已导出文件解码样本峰值. Explicitly hashes and fully decodes one owned succeeded delivered MP4 in the ordinary workspace using bounded local compute. One active attempt with no queue, sharing, persistence, automatic retry, database/file write, network or paid generation. Returns an ephemeral observation bound to the twice-verified artifact, not a durable receipt; conventional read-only idempotence does not promise identical results. A warning never changes or blocks the export or download.'}),
  'timeline.export.loudness': define({...read,localProcess:true,notes:'Explicitly hashes and fully decodes one owned succeeded exported MP4 selected by expected artifact SHA-256 and a fixed 48 kHz stereo measurement profile. Bounded local read-only computation shares the no-queue observation lane; no database/file write, persistence, automatic retry, network, model or paid generation. Returns an ephemeral twice-verified file observation. An explicit custom target may produce arithmetic-only advice, never current-timeline validation, gain-apply authority, a standard target claim or an export/download ban.'}),
  'timeline.undo': define({...replayEdit,notes:'Restores a prior editable timeline state and advances revision/history cursor; preserves assets, generation and exports. Exact replay is durable.'}),
  'timeline.redo': define({...replayEdit,notes:'Restores a saved editable timeline state and advances revision/history cursor; exact replay is durable.'}),
  'timeline.track.add': define({...replayEdit,notes:'Adds a track and records an edit; a new branch can discard redo history. Exact replay is durable.'}),
  'timeline.track.update': define({...replayEdit,notes:'Replaces track fields and records an edit; a new branch can discard redo history. Exact replay is durable.'}),
  'timeline.clip.add': define({...replayEdit,notes:'Adds a fixed-asset clip and records an edit; a new branch can discard redo history. Exact replay is durable.'}),
  'timeline.clip.update': define({...replayEdit,notes:'Replaces clip fields and records an edit; a new branch can discard redo history. Exact replay is durable.'}),
  'timeline.clip.replaceSource': define({...replayEdit,notes:'Replaces only the fixed source of one clip with an owned same-category asset, preserving editable clip fields exactly. Optional explicit versionId pins its validated version and shot; omission invents no provenance. Records one undoable edit and its immutable exact-replay response in the existing timeline request namespace; a new branch can discard redo history. Current-source no-ops reject without writes. No media reads/processes, managed-file writes, external I/O or paid generation.'}),
  'timeline.clip.remove': define({...replayEdit,notes:'Removes a timeline clip, preserving its asset; a new branch can discard redo history. Exact replay is durable.'}),
  'timeline.clip.split': define({...replayEdit,notes:'Shortens the original clip and adds the right-hand clip; a new branch can discard redo history. Exact replay preserves the new ID.'}),
  'timeline.seed': define({...replayEdit,notes:'Copies selected shot assets into an empty timeline and records an edit; a new branch can discard redo history. Exact replay is durable.'}),
  'timeline.render': define({...render,notes:'Queues a frozen timeline render once per exact request. Optional export-only fixed delivery settings invoke bounded local capability compute before fresh acceptance; historical replay runs no probe. Later worker work revalidates and invokes local FFmpeg/ffprobe and writes managed output. Omission retains the legacy path. No provider call.'}),
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
