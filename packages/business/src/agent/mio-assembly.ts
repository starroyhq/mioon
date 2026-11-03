import {createHash, randomUUID} from 'node:crypto';
import type {AgentTaskJson} from '../../../contracts/src/agent-tasks-v2.ts';
import {mioInputManifestSchema} from '../../../contracts/src/mio-records.ts';
import type {MioInputManifest, MioRequest} from '../../../contracts/src/mio-records.ts';
import type {MioBeginRequest, MioRecords} from './mio-records.ts';
import type {AgentTaskStepInput} from './task-journal-v2.ts';

// Both known codecs deliberately retain the same model-facing bytes. Version
// 1 is an explicit compatibility vector for the initial frozen-view format;
// version 2 makes canonical-entry collection the default. This is not a claim
// that either format was used by the removed development-only legacy tables.
export const MIO_ASSEMBLER_VERSION = 2;
const MAX_REQUEST_BYTES = 512 * 1024;
const MAX_NODES = 500000;
type JsonObject = {[key: string]: AgentTaskJson};
type Path = (string | number)[];
type Descriptor =
  | {source: string; path: Path; encoding?: 'json'; slice?: [number, number]}
  | {value: null | boolean | number | string}
  | {array: Descriptor[]}
  | {object: [string, Descriptor][]}
  | {concat: Descriptor[]};
interface Reference {source: string; path: Path; encoding?: 'json'; slice?: [number, number]}
interface Candidate {reference: Reference; kind: string; modelSource?: string}
interface SourceIndex {
  values: Map<string, Candidate[]>;
  strings: Map<string, {text: string; candidate: Candidate}[]>;
  modelCalls: Map<string, Candidate[]>;
  resultCalls: Map<string, Candidate[]>;
  modelOrder: string[];
  strictModels: boolean;
}
interface Source {id: string; payload: AgentTaskJson; sha256: string; kind?: string; callId?: string; modelSource?: string}
interface FrozenEnvelope {
  version: 1;
  keys: string[];
  historyField: 'messages' | 'input';
  fields: JsonObject;
  hasTools: boolean;
}
interface FrozenView {
  version: 1;
  sources: {id: string; sha256: string}[];
  history: Descriptor;
  wireHistory: Descriptor;
}
/** The collector supplies values, never live storage handles. Envelope and
 * tools contain the effective profile and localized instructions of this
 * request; rebuilding a past request must not consult today's catalog. */
export interface MioAssemblySnapshot {
  readonly manifest: MioInputManifest;
  readonly entries: readonly Source[];
  readonly configuration: AgentTaskJson;
  readonly tools: AgentTaskJson;
  readonly envelope: AgentTaskJson;
  readonly baseline: AgentTaskJson;
}
export interface MioAssembledRequest {
  readonly body: string;
  readonly history: AgentTaskJson[];
  readonly bodyBytes: number;
  readonly bodySha256: string;
}
const object = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
function fail(): never { throw Object.assign(new Error('Invalid frozen Mio assembly.'), {code: 'AGENT_TASK_STORAGE_CORRUPT'}); }
function json(text: string): AgentTaskJson { try { return JSON.parse(text) as AgentTaskJson; } catch { return fail(); } }
const encoded = (value: unknown): string => JSON.stringify(value);
const own = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
function equalKeys(value: object, expected: string[]): boolean { const keys = Object.keys(value); return keys.length === expected.length && expected.every(key => own(value, key)); }
function validVersion(version: number): void { if (version !== 1 && version !== 2) fail(); }

/** A model-facing view references canonical entry subtrees. This includes raw
 * argument strings, signed thinking and retained tool results: they are not
 * copied into another per-request transcript. Literal nodes describe only the
 * deterministic host/protocol wrapping and compacted views. Every such view
 * retains its exact source range rather than being recomputed from live state. */
function modelCallIds(value: AgentTaskJson): string[] {
  if (!object(value)) return [];
  if (value.type === 'function_call' && typeof value.call_id === 'string') return [value.call_id];
  if (value.type === 'tool_use' && typeof value.id === 'string') return [value.id];
  if (value.role !== 'assistant') return [];
  if (Array.isArray(value.tool_calls)) return value.tool_calls.flatMap(call => object(call) && typeof call.id === 'string' ? [call.id] : []);
  return Array.isArray(value.content) ? value.content.flatMap(modelCallIds) : [];
}
function describe(value: AgentTaskJson, sources: SourceIndex, cursors = new Map<string, number>(), role = '', preferredSource?: string): Descriptor {
  if (object(value) && value.type === 'mio.context.rules-snapshot' && equalKeys(value, ['type', 'message'])) {
    const rule = sources.values.get(encoded(value.message))?.filter(item => item.kind === 'rules_snapshot').at(-1);
    if (!rule) return fail();
    return {object: [['type', {value: 'mio.context.rules-snapshot'}], ['message', {source: rule.reference.source, path: [...rule.reference.path]}]]};
  }
  const currentRole = object(value) ? typeof value.role === 'string' ? value.role : value.type === 'function_call_output' || value.type === 'tool_result' ? 'tool' : value.type === 'function_call' || value.type === 'tool_use' ? 'assistant' : role : role;
  const choose = (items: readonly Candidate[], key: string): Reference => {
    const kinds = currentRole === 'user' ? ['user_message', 'note'] : currentRole === 'assistant' ? ['model_output'] : currentRole === 'tool' ? ['tool_result', 'answer'] : [];
    const kindMatches = items.filter(item => kinds.includes(item.kind)), pool = kindMatches.length ? kindMatches : items;
    const cursorKey = `${currentRole}:${key}`, cursor = cursors.get(cursorKey) ?? 0;
    cursors.set(cursorKey, cursor + 1); return pool[Math.min(cursor, pool.length - 1)]!.reference;
  };
  if (object(value)) {
    const calls = modelCallIds(value);
    const resultId = currentRole === 'tool' ? value.tool_call_id ?? value.call_id ?? value.tool_use_id : undefined;
    const groups = calls.length ? calls.map(id => (sources.modelCalls.get(id) ?? []).filter(candidate => !sources.strictModels || sources.modelOrder.includes(candidate.reference.source))) : typeof resultId === 'string' ? [sources.resultCalls.get(resultId) ?? []] : [];
    // Once a carrier is bound, its business arguments may themselves contain
    // fields named type/id/call_id. Those are data, not another provider call.
    const businessData = preferredSource !== undefined && groups.length > 0 && groups.every(group => !group.some(candidate => candidate.reference.source === preferredSource));
    if (!businessData && calls.length && sources.strictModels && groups.some(group => !group.length)) return fail();
    if (!businessData && groups.length && groups.every(group => group.length)) {
      let candidates = groups[0]!.filter(candidate => groups.every(group => group.some(item => item.reference.source === candidate.reference.source)));
      if (!candidates.length) return fail();
      if (!preferredSource || !candidates.some(candidate => candidate.reference.source === preferredSource)) {
        if (calls.length && sources.modelOrder.length) {
          const current = cursors.get('model-current'), currentId = current === undefined ? undefined : sources.modelOrder[current];
          const withinCurrent = currentId && candidates.find(candidate => candidate.reference.source === currentId);
          const seen = currentId && calls.some(id => cursors.has(`seen-model-call:${currentId}:${id}`));
          const next = cursors.get('model-next') ?? 0;
          // Responses emits one item per call; a Messages/Chat message owns its
          // entire batch. Distinct batches may legitimately reuse a call ID.
          if (withinCurrent && !seen && value.role !== 'assistant') preferredSource = currentId;
          else {
            const index = sources.modelOrder.findIndex((id, index) => index >= next && candidates.some(candidate => candidate.reference.source === id));
            if (index < 0) return fail();
            preferredSource = sources.modelOrder[index]; cursors.set('model-current', index); cursors.set('model-next', index + 1);
          }
          for (const id of calls) cursors.set(`seen-model-call:${preferredSource}:${id}`, 1);
        } else {
          const current = cursors.get('model-current'), currentId = current === undefined ? undefined : sources.modelOrder[current];
          if (typeof resultId === 'string' && currentId) { const matching = candidates.filter(candidate => candidate.modelSource === currentId); if (matching.length) candidates = matching; }
          preferredSource = choose(candidates, `call-identity:${calls.join(',') || String(resultId)}`).source;
        }
      }
    }
  }
  const key = encoded(value);
  let matches = sources.values.get(key);
  if (preferredSource) matches = matches?.filter(item => item.reference.source === preferredSource);
  // A copied message object in an older context is a view of an action. Bind
  // user/assistant actions to their own canonical entries instead of accepting
  // that older equal object and thereby losing a later action's identity.
  if (object(value) && typeof value.role === 'string') {
    const kinds = value.role === 'user' ? ['user_message', 'note'] : value.role === 'assistant' ? ['model_output'] : value.role === 'tool' ? ['tool_result', 'answer'] : [];
    if (kinds.length) matches = matches?.filter(item => kinds.includes(item.kind));
  }
  const saved = matches?.length ? choose(matches, key) : undefined;
  if (saved) return {source: saved.source, path: [...saved.path], ...(saved.encoding ? {encoding: saved.encoding} : {})};
  if (Array.isArray(value)) {
    if (sources.modelOrder.length && !cursors.has('model-next')) {
      let groups = 0, responseGroup = false;
      for (const item of value) if (object(item)) {
        if (item.role === 'assistant' && modelCallIds(item).length) { groups++; responseGroup = false; }
        else if (item.type === 'function_call') { if (!responseGroup) groups++; responseGroup = true; }
        else if (item.role === 'user' || item.role === 'tool' || item.type === 'function_call_output') responseGroup = false;
      }
      if (groups) cursors.set('model-next', Math.max(0, sources.modelOrder.length - groups));
    }
    return {array: value.map(item => describe(item, sources, cursors, role, preferredSource))};
  }
  if (object(value)) {
    return {object: Object.entries(value).map(([key, item]) => [key, describe(item, sources, cursors, currentRole, preferredSource)])};
  }
  if (typeof value === 'string' && value.length >= 16) {
    const parts: Descriptor[] = []; let literal = '', cursor = 0;
    while (cursor < value.length) {
      const candidates = (sources.strings.get(value.slice(cursor, cursor + 16)) ?? []).filter(item => !preferredSource || item.candidate.reference.source === preferredSource).map(item => {
        let length = 16;
        while (length < item.text.length && cursor + length < value.length && item.text[length] === value[cursor + length]) length++;
        return {...item, length};
      });
      const length = candidates.reduce((maximum, item) => Math.max(maximum, item.length), 0), matched = candidates.find(item => item.length === length);
      if (!matched) { literal += value[cursor++]; continue; }
      const compatible = candidates.filter(item => item.length === length);
      const candidate = choose(compatible.map(item => item.candidate), `string:${value.slice(cursor, cursor + length)}`);
      const origin = compatible.find(item => item.candidate.reference.source === candidate.source && encoded(item.candidate.reference.path) === encoded(candidate.path))!;
      if (literal) { parts.push({value: literal}); literal = ''; }
      parts.push({...candidate, path: [...candidate.path], ...(length < origin.text.length ? {slice: [0, length] as [number, number]} : {})}); cursor += length;
    }
    if (parts.length) { if (literal) parts.push({value: literal}); return {concat: parts}; }
  }
  return {value};
}
function sourceIndex(sources: readonly Source[], modelOrder: string[] = [], strictModels = false): SourceIndex {
  const result: SourceIndex = {values: new Map(), strings: new Map(), modelCalls: new Map(), resultCalls: new Map(), modelOrder, strictModels}; let nodes = 0;
  const addString = (text: string, candidate: Candidate): void => {
    if (text.length < 16) return;
    const key = text.slice(0, 16), values = result.strings.get(key) ?? [];
    if (!values.some(item => item.text === text && item.candidate.reference.source === candidate.reference.source)) values.push({text, candidate});
    result.strings.set(key, values);
  };
  const visitView = (node: AgentTaskJson, source: string, path: Path, kind: string): void => {
    if (!object(node)) return;
    // The literal pieces of a frozen host view are canonical host observations.
    // Index their values, without mistaking entry IDs/JSON paths in references
    // for model-facing content or recursively duplicating older view metadata.
    if (own(node, 'value')) visit(node.value!, source, [...path, 'value'], kind);
    else if (Array.isArray(node.array)) node.array.forEach((item, index) => visitView(item, source, [...path, 'array', index], kind));
    else if (Array.isArray(node.concat)) node.concat.forEach((item, index) => visitView(item, source, [...path, 'concat', index], kind));
    else if (Array.isArray(node.object)) node.object.forEach((pair, index) => { if (Array.isArray(pair) && pair.length === 2) visitView(pair[1]!, source, [...path, 'object', index, 1], kind); });
  };
  const visit = (value: AgentTaskJson, source: string, path: Path, kind: string): void => {
    if (++nodes > MAX_NODES) fail();
    // Small punctuation/scalars belong to the projection, not a coincidentally
    // equal unrelated entry. Retaining object/long-string references saves the
    // provider content without merging the identities of separate user actions.
    const referenceMetadata = object(value) && value.type === 'run_context' && own(value, 'contextView');
    const actionText = ['user_message', 'note'].includes(kind) && path.length === 1 && path[0] === 'text' && typeof value === 'string';
    if (!referenceMetadata && (value !== null && typeof value === 'object' || typeof value === 'string' && (value.length >= 16 || actionText))) {
      const key = encoded(value), values = result.values.get(key) ?? [];
      if (!values.some(item => item.reference.source === source)) values.push({reference: {source, path}, kind});
      result.values.set(key, values);
      addString(key, {reference: {source, path, encoding: 'json'}, kind});
    }
    if (typeof value === 'string') addString(value, {reference: {source, path}, kind});
    if (Array.isArray(value)) value.forEach((item, index) => visit(item, source, [...path, index], kind));
    else if (object(value)) for (const [key, item] of Object.entries(value)) {
      // References to earlier entries are metadata, not new canonical prose.
      // Indexing every older view's descriptors would grow quadratically.
      if (value.type === 'run_context' && key === 'contextView') { if (object(item) && own(item, 'context')) visitView(item.context!, source, [...path, key, 'context'], kind); continue; }
      visit(item, source, [...path, key], kind);
    }
  };
  for (const source of sources) {
    visit(source.payload, source.id, [], source.kind ?? '');
    const candidate = {reference: {source: source.id, path: []}, kind: source.kind ?? '', ...(source.modelSource ? {modelSource: source.modelSource} : {})};
    if (source.kind === 'model_output' && object(source.payload)) {
      const provider = source.payload.providerOutput;
      const ids = Array.isArray(provider) ? provider.flatMap(modelCallIds) : provider === undefined ? [] : modelCallIds(provider);
      for (const id of ids) { const candidates = result.modelCalls.get(id) ?? []; candidates.push(candidate); result.modelCalls.set(id, candidates); }
    }
    if (source.callId) { const candidates = result.resultCalls.get(source.callId) ?? []; candidates.push(candidate); result.resultCalls.set(source.callId, candidates); }
  }
  for (const values of result.strings.values()) values.sort((a, b) => b.text.length - a.text.length);
  return result;
}
function referencedSources(...descriptors: Descriptor[]): Set<string> {
  const result = new Set<string>();
  const visit = (node: Descriptor): void => {
    if ('source' in node) result.add(node.source);
    else if ('array' in node) node.array.forEach(visit);
    else if ('object' in node) node.object.forEach(([, value]) => visit(value));
    else if ('concat' in node) node.concat.forEach(visit);
  };
  descriptors.forEach(visit); return result;
}
function resolve(value: unknown, sources: ReadonlyMap<string, AgentTaskJson>, counter: {nodes: number}, depth = 0): AgentTaskJson {
  if (++counter.nodes > MAX_NODES || depth > 100 || !object(value)) return fail();
  if (own(value, 'source')) {
    if (!equalKeys(value, ['source', 'path', ...(own(value, 'encoding') ? ['encoding'] : []), ...(own(value, 'slice') ? ['slice'] : [])]) || own(value, 'encoding') && value.encoding !== 'json' || typeof value.source !== 'string' || !Array.isArray(value.path) || !sources.has(value.source)) return fail();
    let result = sources.get(value.source)!;
    for (const key of value.path) {
      if (typeof key === 'number') { if (!Number.isSafeInteger(key) || key < 0 || !Array.isArray(result) || key >= result.length) return fail(); result = result[key]!; }
      else { if (typeof key !== 'string' || !object(result) || !own(result, key)) return fail(); result = result[key]!; }
    }
    const resolved = value.encoding === 'json' ? encoded(result) : structuredClone(result);
    if (!own(value, 'slice')) return resolved;
    if (typeof resolved !== 'string' || !Array.isArray(value.slice) || value.slice.length !== 2) return fail();
    const [start, end] = value.slice;
    if (typeof start !== 'number' || typeof end !== 'number' || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > resolved.length) return fail();
    return resolved.slice(start, end);
  }
  if (own(value, 'value')) {
    if (!equalKeys(value, ['value']) || value.value !== null && !['string', 'boolean', 'number'].includes(typeof value.value) || typeof value.value === 'number' && !Number.isFinite(value.value)) return fail();
    return value.value!;
  }
  if (own(value, 'array')) {
    if (!equalKeys(value, ['array']) || !Array.isArray(value.array)) return fail();
    return value.array.map(item => resolve(item, sources, counter, depth + 1));
  }
  if (own(value, 'concat')) {
    if (!equalKeys(value, ['concat']) || !Array.isArray(value.concat)) return fail();
    return value.concat.map(item => { const part = resolve(item, sources, counter, depth + 1); return typeof part === 'string' ? part : fail(); }).join('');
  }
  if (!equalKeys(value, ['object']) || !Array.isArray(value.object)) return fail();
  const result: JsonObject = {};
  for (const pair of value.object) {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || own(result, pair[0])) return fail();
    Object.defineProperty(result, pair[0], {value: resolve(pair[1], sources, counter, depth + 1), enumerable: true, writable: true, configurable: true});
  }
  return result;
}

/** Pure serialization of a frozen, versioned model view. No DB, filesystem,
 * current profile, clock, UUID, network or tool execution is consulted. */
export function assembleRequest(assemblerVersion: number, snapshot: MioAssemblySnapshot): MioAssembledRequest {
  validVersion(assemblerVersion);
  const parsed = mioInputManifestSchema.safeParse(snapshot.manifest); if (!parsed.success) return fail();
  const manifest = parsed.data, rawView = manifest.parameters, rawEnvelope = snapshot.envelope;
  if (manifest.viewVersion !== 1 || !object(rawView) || rawView.version !== 1 || !Array.isArray(rawView.sources) || !own(rawView, 'history') || !own(rawView, 'wireHistory') ||
    !object(rawEnvelope) || rawEnvelope.version !== 1 || !Array.isArray(rawEnvelope.keys) || !object(rawEnvelope.fields) || !['messages', 'input'].includes(String(rawEnvelope.historyField)) || typeof rawEnvelope.hasTools !== 'boolean') return fail();
  const sources = new Map<string, AgentTaskJson>();
  if (snapshot.entries.length !== manifest.entryIds.length || rawView.sources.length !== snapshot.entries.length) return fail();
  for (let index = 0; index < snapshot.entries.length; index++) {
    const entry = snapshot.entries[index]!, expected = rawView.sources[index];
    if (entry.id !== manifest.entryIds[index] || !object(expected) || expected.id !== entry.id || expected.sha256 !== entry.sha256 || hash(encoded(entry.payload)) !== entry.sha256 || sources.has(entry.id)) return fail();
    sources.set(entry.id, entry.payload);
  }
  if (manifest.rulesBlobHash !== null && !snapshot.entries.some(entry => entry.kind === 'rules_snapshot' && entry.sha256 === manifest.rulesBlobHash)) return fail();
  if (hash(encoded(snapshot.configuration)) !== manifest.configurationBlobHash || hash(encoded(snapshot.tools)) !== manifest.toolsBlobHash || hash(encoded(snapshot.envelope)) !== manifest.systemBlobHash || hash(encoded(snapshot.baseline)) !== manifest.baselineBlobHash) return fail();
  const counter = {nodes: 0}, history = resolve(rawView.history, sources, counter), wireHistory = resolve(rawView.wireHistory, sources, counter);
  if (!Array.isArray(history) || !Array.isArray(wireHistory)) return fail();
  const envelope = rawEnvelope as unknown as FrozenEnvelope, body: JsonObject = {};
  if (new Set(envelope.keys).size !== envelope.keys.length || !envelope.keys.includes(envelope.historyField) || envelope.hasTools !== envelope.keys.includes('tools') || own(envelope.fields, envelope.historyField) || own(envelope.fields, 'tools')) return fail();
  for (const key of envelope.keys) {
    if (typeof key !== 'string') return fail();
    const value = key === envelope.historyField ? wireHistory : key === 'tools' ? snapshot.tools : envelope.fields[key];
    if (value === undefined) return fail();
    Object.defineProperty(body, key, {value, enumerable: true, writable: true, configurable: true});
  }
  if (Object.keys(envelope.fields).length !== envelope.keys.length - 1 - Number(envelope.hasTools)) return fail();
  const serialized = encoded(body), bodyBytes = Buffer.byteLength(serialized, 'utf8');
  if (!bodyBytes || bodyBytes > MAX_REQUEST_BYTES) return fail();
  return {body: serialized, history, bodyBytes, bodySha256: hash(serialized)};
}

/** Storage/identity effects are confined to this collector. freeze is called
 * inside the journal's intent transaction; collect/hydrate only read records. */
export function createMioAssembly(records: MioRecords, options: {newId?: () => string; now?: () => string; assemblerVersion?: 1 | 2} = {}) {
  const newId = options.newId ?? randomUUID, now = options.now ?? (() => new Date().toISOString());
  const assemblerVersion = options.assemblerVersion ?? MIO_ASSEMBLER_VERSION;
  validVersion(assemblerVersion);
  function source(id: string, stepCache: Map<string, ReturnType<MioRecords['steps']>>): Source {
    const entry = records.entry(id), payload = records.payload(entry);
    const result: Source = {id, kind: entry.kind, payload, sha256: hash(encoded(payload))};
    if (entry.kind === 'tool_result' || entry.kind === 'answer') {
      let steps = stepCache.get(entry.runId);
      if (!steps) { steps = records.steps(entry.runId); stepCache.set(entry.runId, steps); }
      const owner = steps.find(step => step.resultEntryId === entry.id && step.kind === 'tool');
      if (owner?.sourceEntryId !== null && owner?.sourceEntryId !== undefined && owner.sourceCallIndex !== null) {
        result.callId = records.sourceCall(owner.sourceEntryId, owner.sourceCallIndex).id;
        result.modelSource = owner.sourceEntryId;
      }
    }
    return result;
  }
  function loadSources(ids: readonly string[]): Source[] {
    if (ids.length > 20000 || new Set(ids).size !== ids.length) return fail();
    const stepCache = new Map<string, ReturnType<MioRecords['steps']>>();
    return ids.map(id => source(id, stepCache));
  }
  function contextSources(view: AgentTaskJson): Source[] {
    if (!object(view) || view.version !== 1 || !Array.isArray(view.sources) || !own(view, 'context')) return fail();
    const sources = loadSources(view.sources.map(source => { if (!object(source) || typeof source.id !== 'string' || typeof source.sha256 !== 'string') return fail(); return source.id; }));
    for (let index = 0; index < sources.length; index++) if ((view.sources[index] as JsonObject).sha256 !== sources[index]!.sha256) return fail();
    return sources;
  }
  function freezeContext(context: AgentTaskJson[], sourceEntryIds: string[]): AgentTaskJson {
    const sources = loadSources(sourceEntryIds), descriptor = describe(context, sourceIndex(sources));
    const referenced = referencedSources(descriptor);
    return {version: 1, sources: sources.filter(source => referenced.has(source.id)).map(({id, sha256}) => ({id, sha256})), context: descriptor as unknown as AgentTaskJson};
  }
  function hydrateContext(view: AgentTaskJson): AgentTaskJson[] {
    const sources = contextSources(view), result = resolve((view as JsonObject).context, new Map(sources.map(source => [source.id, source.payload])), {nodes: 0});
    return Array.isArray(result) ? result : fail();
  }
  function collect(manifest: MioInputManifest): MioAssemblySnapshot {
    const entries = loadSources(manifest.entryIds);
    return {manifest, entries, configuration: json(records.blob(manifest.configurationBlobHash)), tools: json(records.blob(manifest.toolsBlobHash)), envelope: json(records.blob(manifest.systemBlobHash)), baseline: json(records.blob(manifest.baselineBlobHash))};
  }
  function hydrate(request: MioRequest): AgentTaskJson {
    const assembled = assembleRequest(request.assemblerVersion, collect(request.inputManifest));
    if (assembled.bodyBytes !== request.bodyBytes || assembled.bodySha256 !== request.bodySha256 || request.originalBody !== null && assembled.body !== request.originalBody) return fail();
    return {body: assembled.body, history: assembled.history};
  }
  function freeze(runId: string, stepId: string, input: Omit<AgentTaskStepInput, 'kind'>, noteIds: string[]): MioBeginRequest {
    const request = input.request;
    if (!object(request) || typeof request.body !== 'string' || !Array.isArray(request.history)) return fail();
    const body = json(request.body), run = records.run(runId);
    if (!object(body) || typeof body.model !== 'string') return fail();
    const configuration = run.configurationBlobHash === null ? null : json(records.blob(run.configurationBlobHash));
    if (!object(configuration) || !['chat_completions', 'responses', 'anthropic_messages'].includes(String(configuration.protocol))) return fail();
    const protocol = configuration.protocol as MioRequest['protocol'], historyField = protocol === 'responses' ? 'input' : 'messages';
    if (!Array.isArray(body[historyField]) || body.tools !== undefined && !Array.isArray(body.tools)) return fail();
    const entries: (Source & {kind: string; runId: string})[] = [], visited = new Set<string>(), boundNotes = new Set(noteIds), stepCache = new Map<string, ReturnType<MioRecords['steps']>>();
    const modelSteps = object(input.data) ? input.data.assemblyModelStepIds : undefined, modelOrder: string[] = [], allowedOutputs = new Set<string>();
    if (modelSteps !== undefined) {
      if (!Array.isArray(modelSteps) || !modelSteps.every(id => typeof id === 'string') || new Set(modelSteps).size !== modelSteps.length) return fail();
      for (const id of modelSteps) {
        const step = records.step(String(id)); if (step.runId !== runId || step.kind !== 'model') return fail();
        if (step.resultEntryId !== null) {
          const output = records.entry(step.resultEntryId); if (output.kind !== 'model_output' || output.runId !== runId) return fail();
          allowedOutputs.add(output.id);
          const saved = records.payload(output), provider = object(saved) ? saved.providerOutput : undefined;
          const calls = Array.isArray(provider) ? provider.flatMap(modelCallIds) : provider === undefined ? [] : modelCallIds(provider);
          if (calls.length) modelOrder.push(output.id);
        } else if (step.status === 'completed') return fail();
      }
    }
    const runEntries = records.entries(runId);
    for (const entry of runEntries) if (entry.kind === 'host_state') {
      const saved = records.payload(entry);
      if (object(saved) && saved.type === 'notes_bound' && Array.isArray(saved.requestIds)) for (const id of saved.requestIds) if (typeof id === 'string') boundNotes.add(id);
    }
    const add = (id: string): void => {
      if (visited.has(id)) return;
      if (visited.size >= 20000) return fail();
      const entry = records.entry(id); if (entry.conversationId !== run.conversationId) return fail();
      visited.add(id);
      const payload = records.payload(entry);
      // An unbound note is a later user action, even when its text happens to
      // equal an earlier message. It cannot become an input by value matching.
      if (entry.runId === runId && entry.kind === 'note' && (!object(payload) || typeof payload.requestId !== 'string' || !boundNotes.has(payload.requestId))) return;
      if (entry.runId === runId && entry.kind === 'model_output' && modelSteps !== undefined && !allowedOutputs.has(entry.id)) return;
      entries.push({...source(id, stepCache), kind: entry.kind, runId: entry.runId});
      if (entry.kind === 'host_hint' && object(payload) && payload.type === 'run_context' && payload.contextView !== undefined) for (const source of contextSources(payload.contextView)) add(source.id);
    };
    // Prior action identities precede this run's actions even though the new
    // host observation points backwards to them. Equal message text consumes
    // those identities in model-history order, without coalescing actions.
    for (const entry of runEntries) if (entry.kind === 'host_hint') {
      const saved = records.payload(entry);
      if (object(saved) && saved.type === 'run_context' && saved.contextView !== undefined) for (const source of contextSources(saved.contextView)) add(source.id);
    }
    for (const entry of runEntries) if (entry.kind !== 'request_reassembled') add(entry.id);
    const index = sourceIndex(entries, modelOrder, modelSteps !== undefined), fields: JsonObject = {};
    for (const [key, value] of Object.entries(body)) if (key !== historyField && key !== 'tools') Object.defineProperty(fields, key, {value, enumerable: true, configurable: true, writable: true});
    const envelope: FrozenEnvelope = {version: 1, keys: Object.keys(body), historyField, fields, hasTools: own(body, 'tools')};
    const history = describe(request.history, index), wireHistory = describe(body[historyField]!, index), selected = referencedSources(history, wireHistory);
    // These are the exact provider sources given to the compactor, including
    // a prefix represented by a host summary rather than raw continuation.
    for (const id of allowedOutputs) selected.add(id);
    const noteEntryIds = entries.filter(entry => entry.runId === runId && entry.kind === 'note' && object(entry.payload) && typeof entry.payload.requestId === 'string' && noteIds.includes(entry.payload.requestId)).map(entry => entry.id);
    for (const id of noteEntryIds) selected.add(id);
    // Preserve current user-action identity and the frozen host observation,
    // including empty/short messages that need no large-content reference.
    for (const entry of entries) if (entry.runId === runId && (entry.kind === 'user_message' || entry.kind === 'rules_snapshot' || entry.kind === 'host_hint' && object(entry.payload) && entry.payload.type === 'run_context')) selected.add(entry.id);
    const retainContext = (id: string): void => {
      const entry = entries.find(item => item.id === id); if (!entry || entry.kind !== 'host_hint' || !object(entry.payload) || entry.payload.type !== 'run_context' || entry.payload.contextView === undefined) return;
      for (const source of contextSources(entry.payload.contextView)) if (!selected.has(source.id)) { selected.add(source.id); retainContext(source.id); }
    };
    for (const id of [...selected]) retainContext(id);
    const inputs = entries.filter(entry => selected.has(entry.id));
    const view: FrozenView = {version: 1, sources: inputs.map(({id, sha256}) => ({id, sha256})), history, wireHistory};
    const at = now(), baseline = object(input.data) && input.data.baseline !== undefined ? input.data.baseline : [];
    const inputManifest: MioInputManifest = {
      version: 1, entryIds: inputs.map(entry => entry.id), noteEntryIds,
      configurationBlobHash: records.putBlob(encoded(configuration), at), toolsBlobHash: records.putBlob(encoded(body.tools ?? []), at), systemBlobHash: records.putBlob(encoded(envelope), at), baselineBlobHash: records.putBlob(encoded(baseline), at),
      rulesBlobHash: run.rulesSnapshotHash, parameters: view as unknown as AgentTaskJson, viewVersion: 1,
    };
    const assembled = assembleRequest(assemblerVersion, collect(inputManifest));
    // The gateway boundary and persisted intent must share the exact same
    // bytes. This also rejects noncanonical JSON that descriptors cannot retain.
    if (assembled.body !== request.body) return fail();
    return {id: newId(), stepId, assemblerVersion, protocol, body: assembled.body, inputManifest, assembledAt: at};
  }
  function upgrade(request: MioRequest): MioBeginRequest | undefined {
    if (request.assemblerVersion === assemblerVersion) return;
    validVersion(request.assemblerVersion);
    if (request.state !== 'intent' || request.dispatchStartedAt !== null || request.assemblerVersion > assemblerVersion) return fail();
    const assembled = assembleRequest(assemblerVersion, collect(request.inputManifest));
    return {id: newId(), stepId: request.stepId, assemblerVersion, protocol: request.protocol, body: assembled.body, inputManifest: request.inputManifest, assembledAt: now()};
  }
  return {freeze, collect, hydrate, upgrade, freezeContext, hydrateContext};
}
