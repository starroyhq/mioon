// Trusted envelope predicates are shared by ordinary startup and the fixed
// historical schema derivation. This leaf never opens a workspace or project.
import {installWorkspaceEnvelopeRuntime} from './workspace-envelope-runtime.ts';
import {createWorkspaceRestoreProfileV41} from './workspace-restore-schema-v41.ts';
import {initializeWorkspaceSchemaThrough24} from './workspace-fixed-schema.ts';
import {schemas} from '../../contracts/src/index.ts';
import {isTimelineRecord} from '../../contracts/src/timeline-replacement.ts';
import {isTimelineRenderRecord,TIMELINE_RENDER_RESPONSE_BYTES} from '../../contracts/src/timeline-acknowledgement.ts';

const envelopeRestored41=createWorkspaceRestoreProfileV41(initializeWorkspaceSchemaThrough24);
installWorkspaceEnvelopeRuntime({isTimelineRecord,isTimelineRenderRecord,
 timelineRenderResponseBytes:TIMELINE_RENDER_RESPONSE_BYTES,
 validateClipIntent:(operation,value)=>schemas[operation].safeParse(value).success,
 classify40Or41:envelopeRestored41.classifyWorkspaceSchemaV40V41,
 validateRestored41:envelopeRestored41.validateWorkspaceRestoreSchemaV41});
