import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {
  LOCAL_DRAFT_LIMITS,clipDraftRawV1Schema,clipDraftRawSchema,
  clipDraftValueSchema,clipDraftSlotSchema,clipDraftDiskV1Schema,
  clipDraftDiskV2Schema,clipDraftDiskSchema,clipDraftWriteSchema,clipDraftEnvelopeSchema,
} from '../packages/contracts/src/local-drafts.ts';
import {
  LOCAL_DRAFT_OPACITY_CANDIDATE_VERSION,
  clipDraftOpacityCandidateEnvelopeRawSchema,clipDraftOpacityCandidateRawSchema,
  clipDraftOpacityCandidateValueSchema,clipDraftOpacityCandidateSlotSchema,
  clipDraftOpacityCandidateDiskV3Schema,clipDraftOpacityCandidateWriteSchema,
  clipDraftOpacityCandidateEnvelopeSchema,captureClipDraftOpacityCandidateSlot,
  captureClipDraftOpacityCandidateDiskV3,
} from '../packages/contracts/src/local-drafts-opacity-candidate.ts';
import {OPACITY_ENVELOPE_PROFILE,OPACITY_ENVELOPE_LIMITS} from '../packages/contracts/src/timeline-opacity-envelope.ts';
import {VOLUME_ENVELOPE_PROFILE} from '../packages/contracts/src/timeline-volume-envelope.ts';
import type {LegacyDraftContracts} from './helpers/strict-timeline-audio-harness-types.ts';
const {clipDraftRawSchema: frozenV1RawSchema, clipDraftDiskSchema: frozenV1DiskSchema} = await import(new URL('./fixtures/local-drafts-v1-contracts.ts', import.meta.url).href) as LegacyDraftContracts;
import {createLocalDrafts} from '../packages/business/src/local-drafts.ts';
import type {LegacyDraftReader} from './helpers/strict-timeline-audio-harness-types.ts';
const {createLocalDrafts: createFrozenV1Drafts} = await import(new URL('./fixtures/local-drafts-v1-reader.ts', import.meta.url).href) as LegacyDraftReader;
import {calculateWorkspaceScope} from '../packages/contracts/src/workspace-scope.ts';

const opacity = (points: unknown[]=[]) => ({profileId:OPACITY_ENVELOPE_PROFILE,points});
function fixture(){
  const key={projectId:randomUUID(),timelineId:randomUUID(),clipId:randomUUID()};
  const authority={workspaceScope:'a'.repeat(64),instanceId:randomUUID()};
  const source={assetId:randomUUID(),assetSha256:'b'.repeat(64)};
  const raw={name:'',trackId:randomUUID(),startFrame:'',durationFrames:'',sourceInFrame:'',rect:{x:'',y:'',width:'',height:''},gain:''};
  const value={baseRevision:1,source,raw,updatedAt:'2026-10-16T00:00:00.000Z'};
  const slot={...key,revision:1,draft:value};
  const write={...authority,...key,expectedRevision:0,baseRevision:1,source,raw};
  const response={supported:true,...authority,key,revision:1,targetStatus:'matching',draft:value};
  const disk={version:3,workspaceScope:authority.workspaceScope,entries:[slot]};
  return {key,authority,source,raw,value,slot,write,response,disk};
}

test('dormant raw opacity preserves absent, null and bounded unfinished editing text exactly',()=>{
  const f=fixture();
  assert.equal(LOCAL_DRAFT_OPACITY_CANDIDATE_VERSION,3);
  assert.equal(OPACITY_ENVELOPE_PROFILE,'mioon-clip-linear-opacity-v1');
  const outOfOrder=opacity([{frame:'10',opacity:'0.2'},{frame:'',opacity:''},{frame:'-1e+2.',opacity:'-.'},{frame:'10',opacity:'2'}]);
  const maximum=opacity(Array.from({length:OPACITY_ENVELOPE_LIMITS.points},()=>({frame:'.'.repeat(8),opacity:'.'.repeat(32)})));
  for(const fields of [{},{opacityEnvelope:null},{opacityEnvelope:opacity()},{opacityEnvelope:outOfOrder},{opacityEnvelope:maximum}]){
    const input={...f.raw,...fields};
    assert.deepEqual(clipDraftOpacityCandidateRawSchema.parse(input),input);
    assert.equal(Object.hasOwn(clipDraftOpacityCandidateRawSchema.parse(input),'opacityEnvelope'),Object.hasOwn(fields,'opacityEnvelope'));
  }
  const combined={...f.raw,opacityEnvelope:outOfOrder,volumeEnvelope:{profileId:VOLUME_ENVELOPE_PROFILE,points:[{frame:'1e',multiplier:'-.'}]},audioRole:'music'};
  assert.deepEqual(clipDraftOpacityCandidateRawSchema.parse(combined),combined);
});

test('candidate opacity accepts only bounded raw strings and rejects unknown fields at every leaf',()=>{
  const f=fixture(),point={frame:'0',opacity:'1'};
  for(const value of [
    opacity([{frame:0,opacity:'1'}]),opacity([{frame:'0',opacity:1}]),
    opacity([{frame:'0'.repeat(9),opacity:'1'}]),opacity([{frame:'0',opacity:'1'.repeat(33)}]),
    opacity([{frame:'０',opacity:'1'}]),opacity([{frame:'0',opacity:' 1'}]),
    opacity([{frame:'0',opacity:'\n'}]),opacity([{frame:'0',opacity:'Infinity'}]),
    opacity([{frame:'0',opacity:'\uD800'}]),opacity(Array.from({length:OPACITY_ENVELOPE_LIMITS.points+1},()=>point)),
    {...opacity(),profileId:'future'}, {...opacity(),extra:true},
    opacity([{...point,extra:true}]),opacity([[point]]),
  ])assert.equal(clipDraftOpacityCandidateRawSchema.safeParse({...f.raw,opacityEnvelope:value}).success,false);
  for(const value of [[],{...f.raw,extra:true},{...f.raw,rect:{...f.raw.rect,extra:true}}])assert.equal(clipDraftOpacityCandidateRawSchema.safeParse(value).success,false);
  assert.equal(clipDraftOpacityCandidateEnvelopeRawSchema.safeParse({profileId:OPACITY_ENVELOPE_PROFILE,points:[]}).success,true);
});

test('candidate value, slot, write and response retain existing v2 shapes without publishing them',()=>{
  const f=fixture(),raw={...f.raw,opacityEnvelope:opacity([{frame:'1e',opacity:'-.'}])};
  const value={...f.value,raw},slot={...f.slot,draft:value},write={...f.write,raw},response={...f.response,draft:value};
  for(const [schema,input] of [[clipDraftOpacityCandidateValueSchema,value],[clipDraftOpacityCandidateSlotSchema,slot],[clipDraftOpacityCandidateWriteSchema,write],[clipDraftOpacityCandidateEnvelopeSchema,response]] as const){
    assert.deepEqual(schema.parse(input),input);
    assert.equal(schema.safeParse({...input,extra:true}).success,false);
  }
  for(const [schema,input] of [[clipDraftValueSchema,value],[clipDraftSlotSchema,slot],[clipDraftWriteSchema,write],[clipDraftEnvelopeSchema,response]] as const)assert.equal(schema.safeParse(input).success,false);
  const unsupported={supported:false,reason:'RESTORED_WORKSPACE_UNSUPPORTED'};
  assert.deepEqual(clipDraftOpacityCandidateEnvelopeSchema.parse(unsupported),unsupported);
  assert.equal(clipDraftOpacityCandidateEnvelopeSchema.safeParse({...unsupported,draft:value}).success,false);
  assert.equal(clipDraftOpacityCandidateWriteSchema.safeParse({...write,expectedRevision:-1}).success,false);
  assert.equal(clipDraftOpacityCandidateWriteSchema.safeParse({...write,source:{...f.source,extra:true}}).success,false);
  assert.equal(clipDraftOpacityCandidateValueSchema.safeParse({...value,baseRevision:0}).success,false);
});

test('v3 accepts unchanged legacy rows and exact tombstones but rejects other disk versions',()=>{
  const f=fixture(),tombstone={...f.key,clipId:randomUUID(),revision:Number.MAX_SAFE_INTEGER,draft:null};
  const v2Row={...f.slot,clipId:randomUUID(),draft:{...f.value,raw:{...f.raw,volumeEnvelope:null}}};
  const disk={...f.disk,entries:[f.slot,v2Row,tombstone]};
  assert.deepEqual(clipDraftOpacityCandidateDiskV3Schema.parse(disk),disk);
  assert.deepEqual(clipDraftOpacityCandidateSlotSchema.parse(tombstone),tombstone);
  assert.deepEqual(clipDraftOpacityCandidateEnvelopeSchema.parse({...f.response,draft:null}),{...f.response,draft:null});
  for(const version of [1,2,4,'3',undefined])assert.equal(clipDraftOpacityCandidateDiskV3Schema.safeParse({...disk,version}).success,false);
  assert.equal(clipDraftOpacityCandidateDiskV3Schema.safeParse({...disk,extra:true}).success,false);
  assert.equal(clipDraftOpacityCandidateDiskV3Schema.safeParse({...disk,entries:[{...tombstone,extra:true}]}).success,false);
  assert.equal(clipDraftOpacityCandidateDiskV3Schema.safeParse({...disk,entries:Array.from({length:128},()=>tombstone)}).success,true);
  assert.equal(clipDraftOpacityCandidateDiskV3Schema.safeParse({...disk,entries:Array.from({length:129},()=>tombstone)}).success,false);
  assert.equal(LOCAL_DRAFT_LIMITS.slots,128);
});

test('frozen v1 and current v2 contracts still reject opacity presence and v3 with no promotion',()=>{
  const f=fixture();
  for(const opacityEnvelope of [null,opacity(),opacity([{frame:'0',opacity:'1'}])]){
    const raw={...f.raw,opacityEnvelope};
    for(const schema of [frozenV1RawSchema,clipDraftRawV1Schema,clipDraftRawSchema])assert.equal(schema.safeParse(raw).success,false);
    const slot={...f.slot,draft:{...f.value,raw}};
    for(const schema of [frozenV1DiskSchema,clipDraftDiskV1Schema,clipDraftDiskV2Schema,clipDraftDiskSchema]){
      for(const version of [1,2,3])assert.equal(schema.safeParse({...f.disk,version,entries:[slot]}).success,false);
    }
  }
  for(const schema of [frozenV1DiskSchema,clipDraftDiskV1Schema,clipDraftDiskV2Schema,clipDraftDiskSchema])assert.equal(schema.safeParse(f.disk).success,false);
  const legacyV1={...f.disk,version:1};
  const legacyV2={...f.disk,version:2,entries:[{...f.slot,draft:{...f.value,raw:{...f.raw,volumeEnvelope:null}}}]};
  for(const schema of [frozenV1DiskSchema,clipDraftDiskV1Schema,clipDraftDiskSchema])assert.deepEqual(schema.parse(legacyV1),legacyV1);
  for(const schema of [clipDraftDiskV2Schema,clipDraftDiskSchema])assert.deepEqual(schema.parse(legacyV2),legacyV2);
  assert.equal(frozenV1DiskSchema.safeParse(legacyV2).success,false);
});

test('actual v1/v2 services reject v3 reads and opacity writes with in-memory storage and no publication',()=>{
  const f=fixture(),root='/synthetic-mioon-opacity-draft-candidate';
  const directory={dev:1,ino:2},db={dev:1,ino:3,birthtimeMs:4};
  const workspaceScope=calculateWorkspaceScope({channel:'web',root,directory,db});
  const legacy={version:1,workspaceScope,entries:[f.slot]};
  let contents=Buffer.from(JSON.stringify(legacy)),publications=0;
  const options={root,storage:{
    validatePrivateDirectory:()=>directory,validateManagedFile:()=>db,
    readPrivateFile:()=>Buffer.from(contents),
    writePrivateFileAtomic:()=>{publications++;throw Error('Read-only fixture must never publish');},
  },guards:{ownsLock:()=>true,isRestored:()=>false,readTimeline:()=>null,
    readClipAsset:()=>({id:f.source.assetId,projectId:f.key.projectId,sha256:f.source.assetSha256}),
  }};
  for(const create of [createFrozenV1Drafts,createLocalDrafts]){
    contents=Buffer.from(JSON.stringify(legacy));
    const reader=create(options),base=reader.get(f.key) as import('./helpers/strict-timeline-audio-draft-types.ts').OrdinaryDraftEnvelope;
    const write={...f.write,workspaceScope,instanceId:base.instanceId,expectedRevision:base.revision};
    const deletion={...f.key,workspaceScope,instanceId:base.instanceId,expectedRevision:base.revision};
    const raw={...f.raw,opacityEnvelope:opacity([{frame:'',opacity:'-.'}])};
    assert.throws(()=>reader.put({...write,raw}),{code:'LOCAL_DRAFT_VALIDATION'});
    assert.deepEqual(contents,Buffer.from(JSON.stringify(legacy)));
    for(const disk of [
      {...legacy,version:3},
      {...legacy,version:3,entries:[{...f.slot,draft:{...f.value,raw}}]},
    ]){
      contents=Buffer.from(JSON.stringify(disk));const before=Buffer.from(contents);
      for(const call of [()=>reader.get(f.key),()=>reader.list({projectId:f.key.projectId}),()=>reader.put(write),()=>reader.discard(deletion)]){
        assert.throws(call,{code:'LOCAL_DRAFT_STORAGE_UNAVAILABLE'});
        assert.deepEqual(contents,before);
      }
    }
  }
  assert.equal(publications,0);
});

const serializedBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
function sizedSlot<T extends ReturnType<typeof fixture>['slot']>(slot: T,size: number){
  const copy=structuredClone(slot),delta=size-serializedBytes(copy);
  assert.ok(delta>=0);
  copy.draft.updatedAt='2026-10-16T00:00:00.'+'0'.repeat(3+delta)+'Z';
  assert.equal(serializedBytes(copy),size);
  assert.equal(clipDraftOpacityCandidateSlotSchema.safeParse(copy).success,true,'shape validity is separate from complete row admission');
  return copy;
}

for(const size of [8191,8192,8193])test(`candidate complete slot admission retains the exact ${size}-byte row boundary`,()=>{
  const f=fixture(),slot=sizedSlot({...f.slot,draft:{...f.value,raw:{...f.raw,opacityEnvelope:opacity([{frame:'',opacity:'-.'}])}}},size);
  const before=JSON.stringify(slot);
  if(size<=LOCAL_DRAFT_LIMITS.rowBytes){
    const result=captureClipDraftOpacityCandidateSlot(slot);
    assert.deepEqual(result.slot,slot);assert.equal(result.text,before);assert.equal(result.bytes,size);
    assert.notEqual(result.slot,slot);assert.notEqual(result.slot.draft,slot.draft);assert.notEqual(result.slot.draft.raw,slot.draft.raw);
    assert.notEqual(result.slot.draft.raw.opacityEnvelope!.points,slot.draft.raw.opacityEnvelope.points);
  }else assert.throws(()=>captureClipDraftOpacityCandidateSlot(slot),{code:'OPACITY_DRAFT_CANDIDATE_ROW_LIMIT'});
  assert.equal(JSON.stringify(slot),before);
});

test('candidate complete disk capture validates all rows, preserves tombstones and counts the final newline',()=>{
  const f=fixture(),maximum=sizedSlot({...f.slot,draft:{...f.value,raw:{...f.raw,opacityEnvelope:opacity([{frame:'',opacity:'-.'}])}}},8192);
  const entries=Array.from({length:LOCAL_DRAFT_LIMITS.slots},()=>({...structuredClone(maximum),clipId:randomUUID()}));
  const disk={...f.disk,entries},before=JSON.stringify(disk),result=captureClipDraftOpacityCandidateDiskV3(disk);
  const maximumBytes=serializedBytes({...disk,entries:[]})+entries.length*LOCAL_DRAFT_LIMITS.rowBytes+entries.length-1+1;
  assert.deepEqual(result.disk,disk);assert.equal(result.text,before+'\n');assert.equal(result.bytes,maximumBytes);
  assert.ok(result.bytes<LOCAL_DRAFT_LIMITS.envelopeBytes,'128 maximum rows and fixed metadata cannot reach the retained 2 MiB disk cap');
  assert.equal(result.bytes,Buffer.byteLength(result.text));assert.notEqual(result.disk.entries,disk.entries);
  assert.notEqual(result.disk.entries[0].draft.raw.opacityEnvelope,disk.entries[0].draft.raw.opacityEnvelope);
  assert.equal(JSON.stringify(disk),before);
  const tombstone={...f.key,clipId:randomUUID(),revision:2,draft:null},mixed={...f.disk,entries:[maximum,tombstone]};
  assert.deepEqual(captureClipDraftOpacityCandidateDiskV3(mixed).disk,mixed);
  assert.equal(LOCAL_DRAFT_LIMITS.envelopeBytes,2*1024*1024);
});

test('candidate disk capture rejects duplicate identities and late invalid or oversized rows without altering input',()=>{
  const f=fixture(),tombstone={...f.key,revision:2,draft:null};
  const duplicate={...f.disk,entries:[f.slot,tombstone]},duplicateBefore=JSON.stringify(duplicate);
  assert.equal(clipDraftOpacityCandidateDiskV3Schema.safeParse(duplicate).success,true,'shape alone does not establish companion admission');
  assert.throws(()=>captureClipDraftOpacityCandidateDiskV3(duplicate),{code:'OPACITY_DRAFT_CANDIDATE_DUPLICATE_KEY'});
  assert.equal(JSON.stringify(duplicate),duplicateBefore);
  for(const last of [
    {...f.slot,clipId:randomUUID(),draft:{...f.value,raw:{...f.raw,unknown:true}}},
    sizedSlot({...f.slot,clipId:randomUUID()},8193),
  ]){
    const disk={...f.disk,entries:[f.slot,last]},before=JSON.stringify(disk);
    assert.throws(()=>captureClipDraftOpacityCandidateDiskV3(disk));
    assert.equal(JSON.stringify(disk),before);
  }
  for(const value of [{...f.disk,version:1},{...f.disk,version:2},JSON.stringify(f.disk)])assert.throws(()=>captureClipDraftOpacityCandidateDiskV3(value));
});
