import {randomUUID} from 'node:crypto';
import {lstatSync, realpathSync} from 'node:fs';
import path from 'node:path';
import {
  fcpChooseDestinationControlInputSchema, fcpChooseDestinationControlResultSchema, fcpCompletedBundleControlResultSchema,
  type NativeFcpExportControlPort,
} from '../../../packages/contracts/src/project-entry-native.ts';
import {fcpNativeInvalid, fcpNativeRequest, fcpNativeUnavailable} from '../../../packages/contracts/src/project-entry-fcp-bridge.ts';

export interface FcpExportOwner {
  readonly projectId: string;
  readonly windowId: string;
  isCurrent(): boolean;
}
interface Options<Event, Owner extends FcpExportOwner> {
  ownerForEvent(event: Event): Owner | null;
  backend: NativeFcpExportControlPort;
  signal: AbortSignal;
  chooseDirectory(owner: Owner): Promise<string | null>;
  revealPath(bundle: string): void;
  openInFinalCut(bundle: string, beforeOpen: () => boolean): Promise<boolean>;
  finalCutInstalled(): Promise<boolean>;
}

export function createFcpExportHost<Event, Owner extends FcpExportOwner>(options: Options<Event, Owner>) {
  let choosing = false;
  return {async handle(event: Event, raw: unknown) {
    const parsed = fcpNativeRequest.safeParse(raw);
    if (!parsed.success) return fcpNativeInvalid();
    const request = parsed.data;
    try {
      const owner = options.ownerForEvent(event);
      if (!owner) return fcpNativeUnavailable();
      const live = () => !options.signal.aborted && owner.isCurrent();
      if (!live()) return fcpNativeUnavailable();
      if (request.kind === 'chooseDestination') {
        if (choosing) return fcpNativeUnavailable();
        choosing = true;
        try {
          const directory = await options.chooseDirectory(owner);
          if (!live()) return fcpNativeUnavailable();
          if (directory === null) return {ok: true, data: null} as const;
          const info = lstatSync(directory, {bigint: true});
          if (!info.isDirectory() || realpathSync(directory) !== directory) return fcpNativeUnavailable();
          const token = randomUUID();
          const input = fcpChooseDestinationControlInputSchema.parse({
            projectId: owner.projectId, windowId: owner.windowId, token, directory, device: String(info.dev), inode: String(info.ino),
          });
          const data = fcpChooseDestinationControlResultSchema.parse(await options.backend.chooseDestination(input, {signal: options.signal}));
          return live() && data.token === token ? {ok: true, data} as const : fcpNativeUnavailable();
        } finally {choosing = false;}
      }
      if (request.kind === 'finalCutInstalled') {
        const data = await options.finalCutInstalled();
        return live() ? {ok: true, data} as const : fcpNativeUnavailable();
      }
      if (owner.projectId !== request.identity.projectId) return fcpNativeUnavailable();
      if (request.kind === 'openInFinalCut') {
        const installed = await options.finalCutInstalled();
        if (!live()) return fcpNativeUnavailable();
        if (!installed) return {ok: true, data: false} as const;
      }
      const bundle = fcpCompletedBundleControlResultSchema.parse(await options.backend.completedBundle({
        ...request.identity, windowId: owner.windowId,
      }, {signal: options.signal}));
      if (!live()) return fcpNativeUnavailable();
      if (!bundle) return {ok: true, data: false} as const;
      const stillOwnsBundle = (): boolean => {
        if (!live()) return false;
        const target = lstatSync(bundle.path, {bigint: true, throwIfNoEntry: false});
        return target?.isDirectory() === true && String(target.dev) === bundle.device && String(target.ino) === bundle.inode
          && realpathSync(bundle.path) === bundle.path
          && lstatSync(path.join(bundle.path, 'Info.fcpxml'), {throwIfNoEntry: false})?.isFile() === true;
      };
      if (!stillOwnsBundle()) return {ok: true, data: false} as const;
      if (request.kind === 'reveal') {
        options.revealPath(bundle.path);
        return {ok: true, data: true} as const;
      }
      const data = await options.openInFinalCut(bundle.path, stillOwnsBundle);
      return live() ? {ok: true, data} as const : fcpNativeUnavailable();
    } catch {
      return fcpNativeUnavailable();
    }
  }};
}
