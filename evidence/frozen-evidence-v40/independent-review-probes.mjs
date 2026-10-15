// Deterministic in-memory review probes. No media, network, build or install.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
let source=fs.readFileSync(path.join(root,'tests/workspace-frozen-evidence-v40.test.mjs'),'utf8')
  .split("for(const feature of ['audioRole','colour'])for(const table")[0];
source=source.replace(/from '([^']+)'/g,(_,specifier)=>
  `from '${specifier.startsWith('.')?pathToFileURL(path.resolve(root,'tests',specifier)).href:specifier}'`);
source+=`
let cases=0;
for(const feature of ['audioRole','colour']) for(const table of ['timeline_requests','exports']) for(const kind of ['public projection','null envelope','running','failed','succeeded','nested wrapper','escaped duplicate asset','hidden invalid source']){
 const clean=[],t={after(fn){clean.push(fn);}},db=database(t),value=receipt(feature);
 let shouldPass=true,raw;
 if(kind==='public projection') delete value.snapshot.assets[0].projectId;
 if(kind==='null envelope'){value.snapshot.timeline.clips[0].volumeEnvelope=null;delete value.snapshot.volumeEnvelopeProfile;}
 if(kind==='running') value.status='running';
 if(kind==='failed'){value.status='failed';value.error={code:'TEST_FAILURE',message:'Deterministic failure'};}
 if(kind==='succeeded'){value.status='succeeded';value.assetId=id(90);value.url='/media/'+id(90);}
 if(kind==='nested wrapper'){raw=JSON.stringify({nested:value});shouldPass=false;}
 if(kind==='escaped duplicate asset'){raw=JSON.stringify(value).replace('"mimeType":','"mimeT\\\\u0079pe":"image/png","mimeType":');shouldPass=false;}
 if(kind==='hidden invalid source'){
  value.snapshot.timeline.tracks[0].hidden=true;
  if(feature==='audioRole'){value.snapshot.assets[0].mimeType='image/png';value.snapshot.timeline.clips[0].volumeEnvelope=null;delete value.snapshot.volumeEnvelopeProfile;}
  else{value.snapshot.colourPlan=createTimelineColourPlan(value.snapshot.timeline,value.snapshot.assets);value.snapshot.assets[0].sha256='b'.repeat(64);}
  shouldPass=false;
 }
 seed(db,value,table,raw??JSON.stringify(value));changeCache(db,feature);
 let failure;try{validateWorkspaceSchema40(db);profile.classifyWorkspaceSchemaV40V41(db);}catch(error){failure=error.code;}
 if(shouldPass&&failure||!shouldPass&&!failure) throw Error([feature,table,kind,shouldPass,failure].join(' '));
 for(const fn of clean)fn();cases++;
}
for(const feature of ['audioRole','colour']) for(const owner of ['short-review-owner',id(9),Buffer.from('blob-review-owner')]){
 const clean=[],t={after(fn){clean.push(fn);}},db=database(t),value=receipt(feature,false);
 seed(db,value,'exports');
 if(owner!==id(9))insert(db,'projects',{id:owner,data:'{}'});
 db.prepare('UPDATE exports SET projectId=? WHERE id=?').run(owner,id(6));
 changeCache(db,feature);
 assert.throws(()=>validateWorkspaceSchema40(db),error(feature));
 assert.throws(()=>profile.classifyWorkspaceSchemaV40V41(db),error(feature));
 for(const fn of clean)fn();cases++;
}
console.log('Independent edge probes passed:',cases);
`;
await import('data:text/javascript,'+encodeURIComponent(source));
