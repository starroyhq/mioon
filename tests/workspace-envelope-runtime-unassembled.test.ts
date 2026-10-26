import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {requireWorkspaceEnvelopeRuntime,installWorkspaceEnvelopeRuntime} from '../packages/business/src/workspace-envelope-runtime.ts';
import {validateWorkspaceVolumeEnvelopeRows} from '../packages/business/src/workspace-volume-envelope-validation.ts';
import {initializeWorkspaceSchema40} from '../packages/business/src/workspace-schema-v40.ts';
import {assertTimelineVolumeEnvelopeWorkspace} from '../packages/business/src/timeline-volume-envelope-admission.ts';
import {frozenReceiptBindingsV40} from '../packages/business/src/workspace-frozen-evidence-v40.ts';
import {readTimelineVolumeEnvelopeCapability} from '../packages/business/src/timeline-volume-envelope-capability.ts';
const unavailable={code:'WORKSPACE_VOLUME_ENVELOPE_RUNTIME_UNAVAILABLE'};
test('unassembled typed admission fails closed before reads or migration writes',()=>{
 assert.throws(()=>requireWorkspaceEnvelopeRuntime(),unavailable);
 const noDatabase=new Proxy({}, {get(){throw new Error('Database must not be touched');}});
 assert.equal(readTimelineVolumeEnvelopeCapability((noDatabase as unknown as Parameters<typeof readTimelineVolumeEnvelopeCapability>[0])).editable,false);
 assert.throws(()=>validateWorkspaceVolumeEnvelopeRows((noDatabase as unknown as Parameters<typeof validateWorkspaceVolumeEnvelopeRows>[0]),{allowVolumeEnvelopes:true}),unavailable);
 assert.throws(()=>initializeWorkspaceSchema40((noDatabase as unknown as Parameters<typeof initializeWorkspaceSchema40>[0])),unavailable);
 assert.throws(()=>assertTimelineVolumeEnvelopeWorkspace((noDatabase as unknown as Parameters<typeof assertTimelineVolumeEnvelopeWorkspace>[0]),{volumeEnvelope:null}),{code:'TIMELINE_VOLUME_ENVELOPE_WORKSPACE_REQUIRED'});
 assert.throws(()=>frozenReceiptBindingsV40((noDatabase as unknown as Parameters<typeof frozenReceiptBindingsV40>[0]),{snapshot:{}},null,'exports','id',()=>{throw new Error('invalid');}),unavailable);
});
test('missing or malformed dependencies cannot install a permissive runtime',()=>{
 for(const value of [undefined,{}, {timelineRenderResponseBytes:4194304}] as const)assert.throws(()=>installWorkspaceEnvelopeRuntime((value! as unknown as Parameters<typeof installWorkspaceEnvelopeRuntime>[0])),unavailable);
 assert.throws(()=>requireWorkspaceEnvelopeRuntime(),unavailable);
});
test('unassembled historical scans stay usable, but reject envelope evidence',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  db.exec('CREATE TABLE timelines(data TEXT)');
  validateWorkspaceVolumeEnvelopeRows(db,{allowVolumeEnvelopes:false});
  db.prepare('INSERT INTO timelines VALUES(?)').run('{"volumeEnvelope":null}');
  assert.throws(()=>validateWorkspaceVolumeEnvelopeRows(db,{allowVolumeEnvelopes:false}),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
 }finally{db.close();}
});
