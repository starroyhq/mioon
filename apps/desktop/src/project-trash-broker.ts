import {randomUUID} from 'node:crypto';
import {lstatSync} from 'node:fs';
import path from 'node:path';
import {AppError} from '../../../packages/contracts/src/app-error.ts';
import {projectTrashRequestSchema, projectTrashReserveInputSchema, projectTrashCommandSchema as commandSchema, projectTrashReplySchema as replySchema, ProjectTrashRefusedError} from '../../../packages/contracts/src/project-trash-native.ts';
import type {ProjectTrashPort, ProjectTrashRequest, ProjectTrashReservation, ProjectTrashRefusedCode, ProjectTrashCommand as Command, ProjectTrashReply as Reply} from '../../../packages/contracts/src/project-trash-native.ts';

const VERSION = 1, MAX_ACTIONS = 256, MAX_MESSAGES = 1024, MAX_PENDING = 16, MAX_BYTES = 16 * 1024;
const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(value);
const unconfirmed = () => new AppError('PROJECT_TRASH_UNCONFIRMED', '项目文件是否已移到废纸篓尚不明确，未重复操作。', 409);
const bounded = (value: unknown): boolean => {try {return Buffer.byteLength(JSON.stringify(value)) <= MAX_BYTES;} catch {return false;}};
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
interface WindowReservation {isCurrent(): boolean; release(): void}
export interface ProjectTrashNativeOptions {
  trashItem(projectFile: string): Promise<void>;
  reserveClosedProjectAction(projectId: string): WindowReservation | null;
}
interface Action {
  requestId: string; projectId: string; reservationId: string; window: WindowReservation;
  phase: 'reserved' | 'dispatching' | 'completed' | 'released';
  replyAllowed: boolean; timer: ReturnType<typeof setTimeout>;
}

/** Only metadata reads: opening another descriptor could drop SQLite locks. */
function verifySource(input: ProjectTrashRequest): void {
  const file = input.projectFile;
  if (!path.isAbsolute(file) || path.normalize(file) !== file || path.extname(file) !== '.mioon') throw new ProjectTrashRefusedError('PROJECT_TRASH_SOURCE_CHANGED');
  const parsed = path.parse(file);
  let parent = parsed.root;
  for (const component of path.dirname(file).slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    parent = path.join(parent, component);
    const info = lstatSync(parent, {bigint: true});
    if (!info.isDirectory() || info.isSymbolicLink()) throw new ProjectTrashRefusedError('PROJECT_TRASH_SOURCE_CHANGED');
  }
  const info = lstatSync(file, {bigint: true}), expected = input.fileIdentity;
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || info.dev.toString() !== expected.dev || info.ino.toString() !== expected.ino
    || info.size !== BigInt(expected.size) || info.mtimeNs.toString() !== expected.mtimeNs || info.ctimeNs.toString() !== expected.ctimeNs
    || info.birthtimeNs.toString() !== expected.birthtimeNs) throw new ProjectTrashRefusedError('PROJECT_TRASH_SOURCE_CHANGED');
  for (const suffix of ['-journal', '-wal', '-shm']) if (lstatSync(file + suffix, {throwIfNoEntry: false})) throw new ProjectTrashRefusedError('PROJECT_TRASH_SOURCE_CHANGED');
}

/** One broker belongs to one exact utility child. OS work cannot be cancelled:
 * its window token survives close/release until the actual promise settles. */
export function createProjectTrashBroker({native, send, isActive, reservationTimeout = 60000}: {
  native?: ProjectTrashNativeOptions;
  send(message: unknown): void;
  isActive(): boolean;
  reservationTimeout?: number;
}) {
  if (!Number.isSafeInteger(reservationTimeout) || reservationTimeout < 1 || reservationTimeout > 60000) throw unconfirmed();
  const actions = new Map<string, Action>(), requests = new Set<string>(), messages = new Set<string>();
  let closed = false;
  const active = () => !closed && isActive();
  const reply = (message: Reply) => {if (active()) {try {send(message);} catch {/* Lost ACK remains unconfirmed. */}}};
  const failure = (messageId: string, refused: ProjectTrashRefusedCode | null = null) => reply({type: 'project-trash:reply', version: VERSION, messageId, ok: false, refused});
  const success = (messageId: string, reservationId: string | null) => reply({type: 'project-trash:reply', version: VERSION, messageId, ok: true, reservationId});
  const releaseWindow = (action: Action) => {try {action.window.release();} catch {/* A failed release must retain its fence, never invent another native attempt. */}};
  const release = (action: Action) => {
    clearTimeout(action.timer);
    if (action.phase === 'reserved') {action.phase = 'released'; requests.delete(action.requestId); releaseWindow(action);}
  };
  return Object.freeze({
    handle(raw: unknown): boolean {
      const envelope = object(raw);
      if (!['project-trash:reserve', 'project-trash:trash', 'project-trash:release'].includes(String(envelope?.type))) return false;
      if (!active()) return true;
      const parsed = bounded(raw) ? commandSchema.safeParse(raw) : null;
      if (!parsed?.success) {if (validId(envelope?.messageId)) failure(envelope.messageId, 'PROJECT_TRASH_UNAVAILABLE'); return true;}
      const command = parsed.data;
      if (messages.has(command.messageId)) return true;
      if (messages.size >= MAX_MESSAGES) {failure(command.messageId, 'PROJECT_TRASH_UNAVAILABLE'); return true;}
      messages.add(command.messageId);
      if (command.deadline <= Date.now() || command.deadline > Date.now() + 60000) {failure(command.messageId, 'PROJECT_TRASH_UNAVAILABLE'); return true;}
      if (command.type === 'project-trash:reserve') {
        if (requests.has(command.input.requestId)) {failure(command.messageId); return true;}
        if (!native || actions.size >= MAX_ACTIONS) {failure(command.messageId, 'PROJECT_TRASH_UNAVAILABLE'); return true;}
        let window: WindowReservation | null;
        try {window = native.reserveClosedProjectAction(command.input.projectId);} catch {window = null;}
        if (!window) {failure(command.messageId, 'PROJECT_HOST_BUSY'); return true;}
        const reservationId = randomUUID();
        const timer = setTimeout(() => {const action = actions.get(reservationId); if (action) release(action);}, reservationTimeout);
        timer.unref?.();
        const action: Action = {...command.input, reservationId, window, phase: 'reserved', replyAllowed: true, timer};
        actions.set(reservationId, action); requests.add(action.requestId); success(command.messageId, reservationId); return true;
      }
      const action = actions.get(command.reservationId);
      if (!action || action.requestId !== command.input.requestId || action.projectId !== command.input.projectId) {failure(command.messageId, 'PROJECT_TRASH_UNAVAILABLE'); return true;}
      if (command.type === 'project-trash:release') {
        action.replyAllowed = false; release(action); success(command.messageId, null); return true;
      }
      if (action.phase !== 'reserved') {failure(command.messageId, action.phase === 'released' ? 'PROJECT_TRASH_UNAVAILABLE' : null); return true;}
      try {
        if (!native || !action.window.isCurrent()) throw new ProjectTrashRefusedError('PROJECT_TRASH_UNAVAILABLE');
        verifySource(command.input);
        if (!active() || !action.window.isCurrent()) throw new ProjectTrashRefusedError('PROJECT_TRASH_UNAVAILABLE');
      } catch (error) {
        release(action); failure(command.messageId, error instanceof ProjectTrashRefusedError ? error.code : 'PROJECT_TRASH_SOURCE_CHANGED'); return true;
      }
      clearTimeout(action.timer); action.phase = 'dispatching';
      // Marked before the native call: even a synchronous exception cannot
      // prove the OS did not act. Never serialize it as a preflight refusal.
      let nativeResult: Promise<void>;
      try {nativeResult = native!.trashItem(command.input.projectFile);} catch {nativeResult = Promise.reject(unconfirmed());}
      void Promise.resolve(nativeResult).then(() => {
        if (action.replyAllowed) success(command.messageId, null);
      }, () => {if (action.replyAllowed) failure(command.messageId);}).finally(() => {
        action.phase = 'completed'; releaseWindow(action);
      });
      return true;
    },
    close(): void {
      closed = true;
      for (const action of actions.values()) {action.replyAllowed = false; release(action);}
    },
  });
}

interface Port {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown;
  postMessage(message: unknown): void;
}
/** No retry or cancellation messages. Only main's explicit preflight refusal
 * constructs ProjectTrashRefusedError; all uncertain transport failures differ. */
export function createProjectTrashClient({port, timeout = 10000}: {port: Port; timeout?: number}): ProjectTrashPort & {close(): void} {
  if (!port || typeof port.on !== 'function' || typeof port.postMessage !== 'function' || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60000) throw unconfirmed();
  const pending = new Map<string, {phase: Command['type']; deadline: number; resolve(value: string | null): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>}>();
  let closed = false;
  const complete = (messageId: string, error: Error | null, result: string | null = null) => {
    const entry = pending.get(messageId); if (!entry) return;
    pending.delete(messageId); clearTimeout(entry.timer); if (error) entry.reject(error); else entry.resolve(result);
  };
  const receive = (event?: unknown) => {
    const raw = object(object(event)?.data);
    if (raw?.type !== 'project-trash:reply' || !pending.has(String(raw.messageId))) return;
    if (Date.now() >= pending.get(String(raw.messageId))!.deadline) {complete(String(raw.messageId), unconfirmed()); return;}
    const parsed = bounded(raw) ? replySchema.safeParse(raw) : null;
    if (!parsed?.success) {complete(String(raw.messageId), unconfirmed()); return;}
    const message = parsed.data, entry = pending.get(message.messageId)!;
    if (!message.ok) {complete(message.messageId, message.refused ? new ProjectTrashRefusedError(message.refused) : unconfirmed()); return;}
    if ((entry.phase === 'project-trash:reserve') !== (message.reservationId !== null)) {complete(message.messageId, unconfirmed()); return;}
    complete(message.messageId, null, message.reservationId);
  };
  const close = () => {
    if (closed) return; closed = true;
    port.removeListener?.('message', receive); port.removeListener?.('close', close);
    for (const messageId of pending.keys()) complete(messageId, unconfirmed());
  };
  port.on('message', receive); port.on('close', close);
  const request = (command: Omit<Extract<Command, {type: 'project-trash:reserve'}>, 'version' | 'messageId' | 'deadline'>
    | Omit<Extract<Command, {type: 'project-trash:trash'}>, 'version' | 'messageId' | 'deadline'>
    | Omit<Extract<Command, {type: 'project-trash:release'}>, 'version' | 'messageId' | 'deadline'>): Promise<string | null> => {
    if (closed || pending.size >= MAX_PENDING) return Promise.reject(unconfirmed());
    const message = {...command, version: VERSION, messageId: randomUUID(), deadline: Date.now() + timeout};
    if (!bounded(message) || !commandSchema.safeParse(message).success) return Promise.reject(unconfirmed());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => complete(message.messageId, unconfirmed()), timeout);
      pending.set(message.messageId, {phase: command.type, deadline: message.deadline, resolve, reject, timer});
      try {port.postMessage(message);} catch {complete(message.messageId, unconfirmed());}
    });
  };
  return Object.freeze({
    async reserve(raw: Parameters<ProjectTrashPort['reserve']>[0]): Promise<ProjectTrashReservation> {
      const parsed = projectTrashReserveInputSchema.safeParse(raw); if (!parsed.success) throw unconfirmed();
      const input = parsed.data, reservationId = (await request({type: 'project-trash:reserve', input}))!;
      let released = false, dispatched = false;
      return Object.freeze({
        async trash(value: ProjectTrashRequest): Promise<void> {
          const parsed = projectTrashRequestSchema.safeParse(value);
          if (released || dispatched || !parsed.success || parsed.data.requestId !== input.requestId || parsed.data.projectId !== input.projectId) throw unconfirmed();
          dispatched = true;
          await request({type: 'project-trash:trash', reservationId, input: parsed.data});
        },
        release(): void {
          if (released) return; released = true;
          try {void request({type: 'project-trash:release', reservationId, input}).catch(() => {/* Main expires an undispatched token; native work owns dispatched tokens. */});} catch {/* Release never replaces the service outcome. */}
        },
      });
    },
    close,
  });
}
