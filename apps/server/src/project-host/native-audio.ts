import type {NativeAudioPreviewAuthority} from '@mioon/business/native-audio-preview';
import type {AudioPreviewPlanInput} from '../../../../packages/contracts/src/timeline-audio-preview.ts';
import type {ProjectHostManager} from './manager.ts';
import type {HostedProject} from './runtime.ts';
import type {ProjectLease} from './host.ts';

/** Bind once per backend epoch. The native retained plan, not a transient
 * planning RPC, holds its project's task lease until exact retirement. */
export function bindProjectNativeAudio(authority: NativeAudioPreviewAuthority, manager: ProjectHostManager<HostedProject>): void {
  const leases = new Map<string, ProjectLease<HostedProject>>();
  async function plan(input: AudioPreviewPlanInput, continuous: boolean): Promise<unknown> {
    let lease = leases.get(input.projectId);
    if (!lease) { lease = await manager.acquire(input.projectId, 'task'); leases.set(input.projectId, lease); }
    try {
      const handlers = lease.host.runtime.project.services.audioPreview.handlers;
      return await (continuous ? handlers['timeline.audioPreview.continuousPlan'] : handlers['timeline.audioPreview.plan'])(input);
    } catch (error) { leases.delete(input.projectId); lease.release(); throw error; }
  }
  authority.bind({handlers: {'timeline.audioPreview.plan': input => plan(input, false), 'timeline.audioPreview.continuousPlan': input => plan(input, true)},
    retireSessionById: async sessionId => {
      // The native authority has exactly one retained lane in this epoch.
      for (const lease of leases.values()) await lease.host.runtime.project.services.audioPreview.retireSessionById(sessionId);
    },
    retireProject: projectId => { const lease = leases.get(projectId); if (lease) { leases.delete(projectId); lease.release(); } },
  });
}
