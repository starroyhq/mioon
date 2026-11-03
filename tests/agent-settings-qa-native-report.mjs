/** Physical live evidence; use --cold after Desktop exits for logical SQL.
 * Settings bytes are never printed, and dummy credentials are boolean only. */
import {readdir} from 'node:fs/promises';
import path from 'node:path';
import {auditColdNativeQa,nativeQaDomain,nativeQaFileFingerprint,nativeQaOwners,readNativeQaJson,snapshotNativeQaFiles,writeNativeQaJson} from './helpers/native-qa-audit.mjs';

const root=path.resolve('evidence/agent-settings/native-runtime'),userData=path.join(root,'user-data');
const cold=process.argv.includes('--cold'),name=process.argv.slice(2).find(value=>!value.startsWith('--'))||'snapshot';
if(!/^[a-z0-9-]+$/.test(name))throw Error('Unsafe report name');
const layout=readNativeQaJson(path.join(root,'native-audit-layout.json')),owners=nativeQaOwners(root,{cold});
const settingsFiles=[];
for(const directory of[userData,path.join(userData,'agent-settings')]){
 let entries=[];try{entries=await readdir(directory,{withFileTypes:true});}catch(error){if(error.code!=='ENOENT')throw error;}
 if(entries.length>128)throw Error('Native settings file inventory bound exceeded');
 for(const entry of entries){if(!(entry.name.includes('agent-settings')||directory.endsWith('/agent-settings')))continue;
  const file=path.join(directory,entry.name),evidence=nativeQaFileFingerprint(file,{ownerPids:owners.ownerPids,maxBytes:64*1024,dummyKeyMarker:true});
  settingsFiles.push({name:path.relative(userData,file),bytes:evidence.bytes,mode:(Number(evidence.identity.mode)&0o777).toString(8),sha256:evidence.sha256,plaintextDummyKeyPresent:evidence.plaintextDummyKeyPresent});
 }
}
const connection={utilityPid:owners.utilityPid,origin:owners.origin};
const logical=cold?await auditColdNativeQa(layout,{ownerPids:owners.ownerPids}):null;
const report={at:new Date().toISOString(),phase:cold?'cold-sql':'live-physical',connection,settingsFiles,
 ...(logical?{...nativeQaDomain(logical),application:logical.application,preferences:logical.preferences,logical}:{physical:snapshotNativeQaFiles(layout,{ownerPids:owners.ownerPids}),domainHash:null,coldVerificationRequired:true})};
writeNativeQaJson(path.join(root,name+(cold?'.cold':'')+'.json'),report);console.log(JSON.stringify(report,null,2));
