/** Independent physical live report; preferences require --cold after exit. */
import path from 'node:path';
import {auditColdNativeQa,nativeQaDomain,nativeQaOwners,readNativeQaJson,snapshotNativeQaFiles,writeNativeQaJson} from './helpers/native-qa-audit.mjs';
const root=path.resolve('evidence/dockable-panels/native-runtime');
const cold=process.argv.includes('--cold'),name=process.argv.slice(2).find(value=>!value.startsWith('--'))||'snapshot';
if(!/^[a-z0-9-]+$/.test(name))throw Error('Unsafe report name');
const layout=readNativeQaJson(path.join(root,'native-audit-layout.json')),owners=nativeQaOwners(root,{cold});
const logical=cold?await auditColdNativeQa(layout,{ownerPids:owners.ownerPids}):null;
const snapshot={at:new Date().toISOString(),phase:cold?'cold-sql':'live-physical',utilityPid:owners.utilityPid,origin:owners.origin,
 ...(logical?{...nativeQaDomain(logical),preferences:logical.preferences,application:logical.application,logical}:{preferences:null,coldVerificationRequired:true,physical:snapshotNativeQaFiles(layout,{ownerPids:owners.ownerPids})})};
writeNativeQaJson(path.join(root,name+(cold?'.cold':'')+'.json'),snapshot);
console.log(JSON.stringify({name,phase:snapshot.phase,utilityPid:snapshot.utilityPid,origin:snapshot.origin,preferences:snapshot.preferences},null,2));
