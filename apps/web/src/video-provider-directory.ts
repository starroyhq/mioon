import {videoConnectionProviders} from './generation-settings.ts';
import type {GenerationProvider} from './generation-settings.ts';

export interface GenerationProviderDirectory {
  providers: GenerationProvider[];
  videoUnavailable: boolean;
}

/** A broken optional catalog must not take ordinary project editing offline. */
export async function readGenerationProviderDirectory(call: (operation: string) => Promise<unknown>): Promise<GenerationProviderDirectory> {
  const [legacy, video] = await Promise.all([
    call('provider.list'),
    Promise.resolve().then(() => call('video.connection.list')).then(value => ({providers: videoConnectionProviders(value), unavailable: false})).catch((error: unknown) => {
      const failure = error && typeof error === 'object' ? error as {code?: unknown; status?: unknown} : null;
      // Authentication belongs to the whole session, not this optional feature.
      if (failure?.code === 'UNAUTHORIZED' || failure?.status === 401) throw error;
      return {providers: [], unavailable: true};
    }),
  ]);
  return {providers: [...legacy as GenerationProvider[], ...video.providers], videoUnavailable: video.unavailable};
}
