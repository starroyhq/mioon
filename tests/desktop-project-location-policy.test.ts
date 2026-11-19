import test from 'node:test';
import assert from 'node:assert/strict';
import {projectLocationDecision} from '../apps/desktop/src/project-location-policy.ts';
import type {ProjectLocationFacts} from '../packages/contracts/src/project-entry-desktop.ts';

const facts=(overrides:Partial<ProjectLocationFacts>={}):ProjectLocationFacts=>({fileSystem:'apfs',isLocal:true,volumeReadOnly:false,permissionBits:true,cloud:'not-reported',...overrides});
test('network shares and read-only volumes cannot host a project',()=>{
 for(const value of [facts({isLocal:false}),facts({volumeReadOnly:true}),facts({isLocal:false,volumeReadOnly:true}),facts({fileSystem:'smbfs',isLocal:false}),facts({fileSystem:'SMB',isLocal:false})])
  assert.deepEqual(projectLocationDecision(value),{kind:'reject'},JSON.stringify(value));
});
test('cloud sync roots and ACL-less filesystems stay usable after the matching warning',()=>{
 assert.deepEqual(projectLocationDecision(facts({cloud:'known-icloud'})),{kind:'warning',cloud:true,permissions:false});
 assert.deepEqual(projectLocationDecision(facts({cloud:'known-file-provider'})),{kind:'warning',cloud:true,permissions:false});
 assert.deepEqual(projectLocationDecision(facts({permissionBits:false})),{kind:'warning',cloud:false,permissions:true});
 assert.deepEqual(projectLocationDecision(facts({fileSystem:'exFAT'})),{kind:'warning',cloud:false,permissions:true});
 assert.deepEqual(projectLocationDecision(facts({fileSystem:'exFAT',cloud:'known-file-provider',permissionBits:false})),{kind:'warning',cloud:true,permissions:true});
});
test('local writable NTFS/ReFS/APFS locations are admitted without a warning',()=>{
 for(const value of [facts(),facts({fileSystem:'NTFS'}),facts({fileSystem:'ReFS'}),facts({cloud:'unknown'}),facts({cloud:'not-reported'})])
  assert.deepEqual(projectLocationDecision(value),{kind:'admit'},JSON.stringify(value));
});
