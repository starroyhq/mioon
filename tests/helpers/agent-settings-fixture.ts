import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {AGENT_PRESETS} from '../../packages/business/src/agent/presets.ts';
import {exactObject,parseAgentConfiguration,agentSettingsError} from '../../packages/business/src/agent/config.ts';
import type {AgentSettingsService,SettingsContextOptions} from '../../packages/business/src/agent/settings.ts';
import {agentPresetPlatform} from '../../packages/contracts/src/agent-provider-catalog.ts';
import {agentServiceInput,agentServiceInputSchema,agentSettingsSnapshotSchema,agentSecretActionSchema} from '../../packages/contracts/src/agent-connection-settings.ts';
import type {AgentSettingsSnapshot} from '../../packages/contracts/src/agent-connection-settings.ts';

/** Positive engine/network fixture setup using the real v3 collection API.
 * This is a test DSL, never an old-shape production write compatibility path. */
export async function putTestAgentConfiguration(settings:Pick<AgentSettingsService,'get'|'put'>,input:unknown,options:SettingsContextOptions={}):Promise<AgentSettingsSnapshot>{
 if(!exactObject(input,['expectedRevision','configuration','secret']))throw agentSettingsError('AGENT_SETTINGS_VALIDATION');
 const configuration=parseAgentConfiguration(input.configuration,options),snapshot=await settings.get(options);
 const preset=AGENT_PRESETS.find(p=>p.id===configuration.presetId),platform=agentPresetPlatform(AGENT_PRESETS,configuration.presetId,configuration.platformId);assert.ok(preset&&platform);
 const serviceKey=configuration.presetId==='custom'?(snapshot.services.find(s=>s.presetId==='custom')?.serviceKey??randomUUID()):configuration.presetId;
 const addressInput=platform.addressMode==='fixed'?'':platform.addressMode==='workspace'?new URL(configuration.baseUrl).hostname.split('.')[0]!:platform.addressMode==='local'?new URL(configuration.baseUrl).origin:configuration.baseUrl;
 const service={serviceKey,presetId:configuration.presetId,name:preset.label,platformId:configuration.platformId,protocol:configuration.protocol,addressInput,manualModelIds:[]};
 const services=snapshot.services.filter(s=>s.serviceKey!==serviceKey).map(agentServiceInput);services.push(agentServiceInputSchema.parse(service));
 if(!input.secret||typeof input.secret!=='object'||Array.isArray(input.secret))throw agentSettingsError('AGENT_SETTINGS_VALIDATION');
 const action=agentSecretActionSchema.parse({serviceKey,...input.secret});
 return settings.put({expectedRevision:input.expectedRevision,services,mioSelection:{serviceKey,modelId:configuration.model},secretActions:[action]},options);
}
export function testAgentExecution(value:unknown){const snapshot=agentSettingsSnapshotSchema.parse(value);assert.ok(snapshot.execution,'Fixture must explicitly select a Mio model');return snapshot.execution;}
export function testAgentCredential(value:unknown){const active=testAgentExecution(value);return {expectedRevision:active.revision,configuration:active.configuration,binding:active.binding};}
