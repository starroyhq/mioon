/** Read-only report for this disposable native fixture. Never prints secrets. */
import {DatabaseSync} from 'node:sqlite';
import {readFile,writeFile,readdir,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
const root=path.resolve('evidence/agent-settings/native-runtime'),userData=path.join(root,'user-data');
const db=new DatabaseSync(path.join(userData,'workspace/workbench.sqlite'),{readOnly:true});let domainHash;
try{
 const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='workspace_preferences' ORDER BY name").all().map(row=>row.name);
 const domain=Object.fromEntries(tables.map(name=>[name,db.prepare('SELECT * FROM "'+name+'" ORDER BY rowid').all()]));
 domainHash=createHash('sha256').update(JSON.stringify(domain)).digest('hex');
}finally{db.close();}
let connection=null;try{const descriptor=JSON.parse(await readFile(path.join(userData,'mcp-connection.json'),'utf8'));connection={utilityPid:descriptor.pid,origin:descriptor.url};}catch{}
const settingsFiles=[];
for(const directory of[userData,path.join(userData,'agent-settings')]){
 let entries=[];try{entries=await readdir(directory,{withFileTypes:true});}catch{}
 for(const entry of entries){if(!entry.isFile()||!(entry.name.includes('agent-settings')||directory.endsWith('/agent-settings')))continue;
  const file=path.join(directory,entry.name),bytes=await readFile(file),metadata=await stat(file);
  settingsFiles.push({name:path.relative(userData,file),bytes:bytes.length,mode:(metadata.mode&0o777).toString(8),plaintextDummyKeyPresent:bytes.includes(Buffer.from('mioon-qa-dummy-agent-key-'))});
 }
}
const report={at:new Date().toISOString(),connection,domainHash,settingsFiles};
const name=process.argv[2]||'snapshot';if(!/^[a-z0-9-]+$/.test(name))throw Error('Unsafe report name');
await writeFile(path.join(root,name+'.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
