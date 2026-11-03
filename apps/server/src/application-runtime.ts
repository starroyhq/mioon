import path from 'node:path';
import {createAgentAuthorizations} from '@mioon/business/agent/authorizations';
import {createAgentSettings, sanitizeAgentSettingsResult} from '@mioon/business/agent/settings';
import {createAgentSettingsFile} from '@mioon/business/agent/settings-file';
import type {AppLibrary} from '@mioon/business/app-db/index';
import {isAppLibraryHeld, projectFileIdentity} from '@mioon/business/app-db/index';
import {createAppCompanionDocuments} from '@mioon/business/companion-scope';
import {createComfyConnector} from '@mioon/business/comfy/connector';
import {createComfySettings} from '@mioon/business/comfy/settings';
import {createCustomImageSettings, createImageSettings} from '@mioon/business/images/settings';
import {createCompatibleImageGateway, createLiveImageGateway} from '@mioon/business/images/gateway';
import {createCustomImageSettingsFile, createImageSettingsFile} from '@mioon/business/images/settings-file';
import {createLastProject} from '@mioon/business/last-project';
import {createUiPreferences} from '@mioon/business/ui-preferences';
import {createVideoSettings} from '@mioon/business/video/settings';
import {createWorkspacePreferences} from '@mioon/business/workspace-preferences';
import {readPrivateFile, validateManagedFile, validatePrivateDirectory, writePrivateFileAtomic} from '@mioon/contracts/private-storage';
import {deriveAgentEndpoint} from '../../../packages/contracts/src/agent-protocol.ts';
import {createComfyHttp} from './comfy-http.ts';
import {composeOfficialComfyModule} from './comfy-module.ts';
import {createImageHttp} from './image-http.ts';
import {createLastProjectHttp} from './last-project-http.ts';
import {createVideoHttp} from './video-http.ts';
import {AppError} from '../../../packages/contracts/src/app-error.ts';
import type {ServerOptions} from './index.ts';

/** Settings and their authorization scope outlive every project host. The app
 * owns the instances; project runtimes borrow them and never close them. */
export async function composeApplicationRuntime(library: AppLibrary, options: ServerOptions, signal: AbortSignal, selfPort: () => number | undefined) {
  const root = library.dataDir, channel = options.localDraftChannel ?? 'web';
  const documents = createAppCompanionDocuments(library);
  const ownsLock = () => {
    const identity = projectFileIdentity(library.databaseFile);
    return library.db.isOpen && identity !== null && isAppLibraryHeld(identity, library.db);
  };
  const hasProject = (id: string) => library.registry.get(id) !== null;
  const storage = {readPrivateFile, writePrivateFileAtomic, validatePrivateDirectory, validateManagedFile};
  const scope = {root, databaseFile: library.databaseFile, channel, signal, storage};
  let ownsSettings = false;
  const closers: (() => unknown)[] = [];
  try {
    let agentSettings = options.agentSettings;
    if (!agentSettings) {
      const directory = path.join(root, 'agent-settings');
      const codec = await options.agentSecretCodecFactory?.({directory, channel});
      try { agentSettings = await createAgentSettings({persistence: createAgentSettingsFile({directory}), ...(codec ? {secretCodec: codec.secretCodec, storage: codec.storage} : {})}); }
      catch (error) { codec?.close(); throw error; }
      ownsSettings = true;
      closers.push(() => agentSettings!.close());
    }
    const authorizations = createAgentAuthorizations({...scope, guards: {ownsLock}, readCurrentTarget: async () => {
      const settings = sanitizeAgentSettingsResult(await agentSettings!.get({selfPort: selfPort()}));
      return {destination: deriveAgentEndpoint(settings.configuration), model: settings.configuration.model, settingsRevision: settings.revision};
    }});
    const image = await createImageSettings({persistence: createImageSettingsFile({directory: path.join(root, 'image-settings'), privateRoot: root}),
      ...(options.imageSecretCodec ? {secretCodec: options.imageSecretCodec, storage: () => options.imageSecretCodec!.storage()} : {})});
    closers.push(() => image.close());
    const customImage = await createCustomImageSettings({persistence: createCustomImageSettingsFile({directory: path.join(root, 'image-settings'), privateRoot: root}),
      ...(options.imageSecretCodec ? {secretCodec: options.imageSecretCodec, storage: () => options.imageSecretCodec!.storage()} : {})});
    closers.push(() => customImage.close());
    const video = await createVideoSettings({directory: path.join(root, 'video-settings'), privateRoot: root, signal,
      ...(options.videoSecretCodec ? {secretCodec: options.videoSecretCodec, storage: () => options.videoSecretCodec!.storage()} : {})});
    closers.push(() => video.close());
    const reservedPorts = () => new Set([options.port, selfPort()].filter((port): port is number => Number.isInteger(port) && port !== undefined && port > 0));
    const comfy = await createComfySettings({directory: path.join(root, 'comfy-settings'), privateRoot: root, reservedPorts});
    closers.push(() => comfy.close());
    const {connector, availability} = composeOfficialComfyModule(options.comfyModule ?? 'load', () => createComfyConnector({reservedPorts,
      ...(options.comfyNetwork ? {networkDeps: {httpRequest: options.comfyNetwork.httpRequest}} : {})}));
    const ui = createUiPreferences({...scope, documents, guards: {ownsLock, isReadOnly: () => false, hasProject}});
    const lastProject = createLastProject({...scope, documents, guards: {ownsLock, readProject: id => hasProject(id) ? {id} : null}});
    // The application port selects db/tx/registration; no project is needed.
    const preferences = createWorkspacePreferences({db: library.db, tx: library.tx, get: () => undefined}, {application: {db: library.db, tx: library.tx, hasProject}});
    const close = async (): Promise<void> => {
      const results = await Promise.allSettled(closers.map(close => { try { return Promise.resolve(close()); } catch (error) { return Promise.reject(error); } }));
      const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      if (errors.length) throw new AggregateError(errors, 'Application settings could not close');
    };
    return {agentSettings, ownsSettings, authorizations, ui, lastProject, preferences, settings: {image, customImage, video, comfy},
      profileDependencies: {settings: image, customSettings: customImage, comfySettings: comfy, comfyConnector: connector,
        liveGateway: createLiveImageGateway({settings: image, ...options.imageNetwork}), customGateway: createCompatibleImageGateway({settings: customImage, ...options.imageNetwork})},
      imageHttp: createImageHttp({settings: image, customSettings: customImage, signal,
        approve: () => { throw new AppError('NOT_FOUND', '接口不存在', 404); }, reject: () => { throw new AppError('NOT_FOUND', '接口不存在', 404); }}),
      videoHttp: createVideoHttp({settings: video, signal}), comfyHttp: createComfyHttp({settings: comfy, connector, availability, signal}),
      lastProjectHttp: createLastProjectHttp({lastProject, signal}), close};
  } catch (error) {
    const results = await Promise.allSettled(closers.map(close => { try { return Promise.resolve(close()); } catch (failure) { return Promise.reject(failure); } }));
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (errors.length) throw new AggregateError([error, ...errors], 'Application startup and cleanup failed');
    throw error;
  }
}
export type ApplicationRuntime = Awaited<ReturnType<typeof composeApplicationRuntime>>;
