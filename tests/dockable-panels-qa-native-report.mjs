/** Read-only native SQLite verification. Never reads credentials. */
import {DatabaseSync} from 'node:sqlite';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve('evidence/dockable-panels/native-runtime');
const db=new DatabaseSync(path.join(root,'user-data/workspace/workbench.sqlite'),{readOnly:true});
try{
 const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('workspace_preferences','provider_credentials') ORDER BY name").all().map(x=>x.name);
 const domain=Object.fromEntries(tables.map(name=>[name,db.prepare('SELECT * FROM "'+name+'"').all()]));
 const preferences=db.prepare('SELECT projectId,revision,state FROM workspace_preferences ORDER BY projectId').all().map(row=>({...row,state:JSON.parse(row.state)}));
 const descriptor=JSON.parse(await readFile(path.join(root,'user-data/mcp-connection.json'),'utf8'));
 const snapshot={at:new Date().toISOString(),utilityPid:descriptor.pid,origin:descriptor.url,preferences,domain};
 const name=process.argv[2]||'snapshot';await writeFile(path.join(root,name+'.json'),JSON.stringify(snapshot,null,2));console.log(JSON.stringify({name,utilityPid:snapshot.utilityPid,origin:snapshot.origin,preferences},null,2));
}finally{db.close();}
