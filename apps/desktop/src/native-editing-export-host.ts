import {randomUUID} from 'node:crypto';
import {lstatSync, realpathSync} from 'node:fs';
import path from 'node:path';
import {
  fcpChooseDestinationControlInputSchema, fcpChooseDestinationControlResultSchema,
  type NativeFcpExportControlPort,
} from '../../../packages/contracts/src/project-entry-control.ts';
import type {NativeExportWire} from '../../../packages/contracts/src/project-entry-export-bridge.ts';
import type {FcpExportNativeIdentity} from '../../../packages/contracts/src/fcp-export-native.ts';

export interface NativeEditingExportOwner {
  readonly projectId: string;
  readonly windowId: string;
  isCurrent(): boolean;
}

export interface NativeEditingExportPresentation<Event, Owner extends NativeEditingExportOwner> {
  ownerForEvent(event: Event): Owner | null;
  signal: AbortSignal;
  chooseDirectory(owner: Owner): Promise<string | null>;
  revealPath(target: string): void;
}

interface ExportTarget {
  readonly path: string;
  readonly device: string;
  readonly inode: string;
  readonly kind: 'file' | 'directory';
  readonly marker?: string;
}

interface Options<Event, Owner extends NativeEditingExportOwner> extends NativeEditingExportPresentation<Event, Owner> {
  wire: NativeExportWire;
  backend: Pick<NativeFcpExportControlPort, 'chooseDestination'>;
  resolveTarget(input: FcpExportNativeIdentity & {windowId: string}, action: 'reveal' | 'open'): Promise<ExportTarget | null>;
  open(target: string, beforeOpen: () => boolean): Promise<boolean>;
  installed(): Promise<boolean>;
}

export function createNativeEditingExportHost<Event, Owner extends NativeEditingExportOwner>(options: Options<Event, Owner>) {
  let choosing = false;
  return {async handle(event: Event, raw: unknown) {
    const parsed = options.wire.request.safeParse(raw);
    if (!parsed.success) return options.wire.invalid();
    const request = parsed.data;
    try {
      const owner = options.ownerForEvent(event);
      if (!owner) return options.wire.unavailable();
      const live = () => !options.signal.aborted && owner.isCurrent();
      if (!live()) return options.wire.unavailable();
      if (request.kind === 'chooseDestination') {
        if (choosing) return options.wire.unavailable();
        choosing = true;
        try {
          const directory = await options.chooseDirectory(owner);
          if (!live()) return options.wire.unavailable();
          if (directory === null) return {ok: true, data: null} as const;
          const info = lstatSync(directory, {bigint: true});
          if (!info.isDirectory() || realpathSync(directory) !== directory) return options.wire.unavailable();
          const token = randomUUID();
          const input = fcpChooseDestinationControlInputSchema.parse({
            projectId: owner.projectId, windowId: owner.windowId, token, directory, device: String(info.dev), inode: String(info.ino),
          });
          const data = fcpChooseDestinationControlResultSchema.parse(await options.backend.chooseDestination(input, {signal: options.signal}));
          return live() && data.token === token ? {ok: true, data} as const : options.wire.unavailable();
        } finally {choosing = false;}
      }
      if (!('identity' in request)) {
        const data = await options.installed();
        return live() ? {ok: true, data} as const : options.wire.unavailable();
      }
      if (owner.projectId !== request.identity.projectId) return options.wire.unavailable();
      const action = request.kind === 'reveal' ? 'reveal' : 'open';
      if (action === 'open') {
        const installed = await options.installed();
        if (!live()) return options.wire.unavailable();
        if (!installed) return {ok: true, data: false} as const;
      }
      const target = await options.resolveTarget({...request.identity, windowId: owner.windowId}, action);
      if (!live()) return options.wire.unavailable();
      if (!target) return {ok: true, data: false} as const;
      const stillOwnsTarget = (): boolean => {
        if (!live()) return false;
        const current = lstatSync(target.path, {bigint: true, throwIfNoEntry: false});
        return current !== undefined && (target.kind === 'directory' ? current.isDirectory() : current.isFile())
          && String(current.dev) === target.device && String(current.ino) === target.inode
          && realpathSync(target.path) === target.path
          && (!target.marker || lstatSync(path.join(target.path, target.marker), {throwIfNoEntry: false})?.isFile() === true);
      };
      if (!stillOwnsTarget()) return {ok: true, data: false} as const;
      if (action === 'reveal') {
        options.revealPath(target.path);
        return {ok: true, data: true} as const;
      }
      const data = await options.open(target.path, stillOwnsTarget);
      return live() ? {ok: true, data} as const : options.wire.unavailable();
    } catch {
      return options.wire.unavailable();
    }
  }};
}
