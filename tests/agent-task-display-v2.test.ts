import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {agentTaskDisplaySchema} from '../packages/contracts/src/agent-tasks-v2.ts';
import type {AgentTaskChange,AgentTaskJson,AgentTaskStep} from '../packages/contracts/src/agent-tasks-v2.ts';
import {agentTaskDisplayTargetReader,projectAgentTaskChangeDisplay,projectAgentTaskStepDisplay} from '../packages/business/src/agent/task-display-v2.ts';
import {openStore} from '../packages/business/src/db.ts';

const now='2026-10-21T00:00:00.000Z';
function change(operation:string,kind:string,before:Record<string,AgentTaskJson>|null,after:Record<string,AgentTaskJson>|null):AgentTaskChange {
  const id=randomUUID();
  return {id:randomUUID(),projectId:randomUUID(),runId:randomUUID(),stepId:randomUUID(),operation,targets:[{kind,id,revision:2}],before:before?[{kind,id,table:'PRIVATE_TABLE',value:before,revision:1}]:[],after:after?[{kind,id,table:'PRIVATE_TABLE',value:after,revision:2}]:[],undo:{private:'UNDO_MUST_STAY_PRIVATE'},summary:'MODEL_SUMMARY_MUST_NOT_BE_USED',reversible:true,status:'applied',createdAt:now};
}
function step(name:string,args:AgentTaskJson,target?:{kind:string;id:string}):AgentTaskStep {
  return {id:randomUUID(),runId:randomUUID(),position:2,kind:'tool',status:'awaiting_approval',createdAt:now,updatedAt:now,toolCall:{id:'call_synthetic',name,arguments:args},...(target?{targets:[{...target,revision:1}]}:{})};
}
test('display names preserve slashes in project content and shorten only media filenames',()=>{
  for(const [kind,key,text,expected] of [
    ['timeline_subtitle','text','A/B 对比：雨后的城市','A/B 对比：雨后的城市'],
    ['shot','title','左/右机位','左/右机位'],
    ['project','name','A/B 项目','A/B 项目'],
    ['timeline_clip','name','clips/a.mp4','a.mp4'],
    ['asset','name','clips/a.mp4','a.mp4'],
    ['shot','title','左\\右机位','左\\右机位'],
    ['timeline_clip','name','clips\\a.mp4','a.mp4'],
  ] as const){
    const record={[key]:text},display=projectAgentTaskChangeDisplay(change('other',kind,null,record));
    assert.equal(display.targets[0]?.name,expected);assert.ok(agentTaskDisplaySchema.safeParse(display).success);
    const id=randomUUID(),planned=projectAgentTaskStepDisplay(step('other',{}, {kind,id}),()=>record);
    assert.equal(planned?.targets[0]?.name,expected);assert.ok(agentTaskDisplaySchema.safeParse(planned).success);
  }
});
test('clip display exposes only changed timing, transform, audio values and a basename without mutating retained evidence',()=>{
  const original=change('timeline.clip.update','timeline_clip',{name:'/private/project/source.mp4',durationFrames:90,sourceInFrame:10,startFrame:30,gain:1,fadeInFrames:0,fadeOutFrames:0,rect:{x:0,y:0,width:1080,height:1920},path:'DO_NOT_EXPOSE_SOURCE_PATH',colour:{prompt:'DO_NOT_EXPOSE_COLOUR'}},{name:'/private/project/source.mp4',durationFrames:60,sourceInFrame:20,startFrame:0,gain:0.5,fadeInFrames:5,fadeOutFrames:10,rect:{x:10,y:20,width:720,height:1280},apiKey:'DO_NOT_EXPOSE_CREDENTIAL'}),copy=structuredClone(original);
  const display=projectAgentTaskChangeDisplay(original);assert.ok(agentTaskDisplaySchema.safeParse(display).success);assert.equal(display.targets[0]?.name,'source.mp4');
  const fields=Object.fromEntries(display.fields.map(field=>[field.property,field]));
  assert.deepEqual(fields.sourceOutFrame,{targetIndex:0,property:'sourceOutFrame',unit:'frames',before:100,after:80});
  assert.deepEqual(fields.gainDb,{targetIndex:0,property:'gainDb',unit:'db',before:0,after:20*Math.log10(0.5)});
  assert.equal(fields.startFrame?.after,0);assert.equal(fields.positionX?.unit,'pixels');assert.equal(fields.positionY?.after,20);assert.equal(fields.width?.after,720);assert.equal(fields.fadeOutFrames?.after,10);
  assert.doesNotMatch(JSON.stringify(display),/DO_NOT_EXPOSE|PRIVATE_TABLE|MODEL_SUMMARY|UNDO_MUST|private\/project/u);assert.deepEqual(original,copy);
  const muted=projectAgentTaskChangeDisplay(change('timeline.clip.update','timeline_clip',{gain:1},{gain:0}));assert.equal(muted.fields[0]?.after,'muted');
  const tiny=projectAgentTaskChangeDisplay(change('timeline.clip.update','timeline_clip',{gain:1},{gain:1.0001}));assert.equal(tiny.fields.length,1);assert.notEqual(tiny.fields[0]?.before,tiny.fields[0]?.after);
});
test('shot description and subtitle are the only prose fields, normalized and bounded; other operations have no field values',()=>{
  const targetId=randomUUID(),prose=`A scene\u202e /private/hidden.mov ${targetId} bearer SYNTHETIC_LONG_VALUE apiKey=SYNTHETIC_VALUE ${'景'.repeat(300)}`;
  const shot=projectAgentTaskChangeDisplay(change('shot.update','shot',{title:targetId,prompt:'before',duration:2,aspectRatio:'9:16'},{title:targetId,prompt:prose,duration:4,aspectRatio:'16:9',description:'ARBITRARY_DESCRIPTION_FIELD',text:'UNREVIEWED_TEXT'}));
  const description=shot.fields.find(field=>field.property==='description');assert.equal(typeof description?.after,'string');assert.ok(String(description?.after).length<=240);assert.ok(String(description?.after).startsWith(`A scene /private/hidden.mov ${targetId} bearer SYNTHETIC_LONG_VALUE apiKey=SYNTHETIC_VALUE `));assert.doesNotMatch(String(description?.after),/\u202e/u);assert.equal(shot.targets[0]?.name,targetId);assert.ok(agentTaskDisplaySchema.safeParse(shot).success);
  const subtitle=projectAgentTaskChangeDisplay(change('timeline.subtitle.update','timeline_subtitle',{text:'旧字幕'},{text:'新字幕',prompt:'UNREVIEWED_SUBTITLE_PROMPT'}));assert.deepEqual(subtitle.fields.map(field=>[field.property,field.before,field.after]),[['subtitleText','旧字幕','新字幕']]);
  const fallback=projectAgentTaskChangeDisplay(change('node.update','node',{label:'Document',text:'PRIVATE_BEFORE'},{label:'Document',text:'PRIVATE_AFTER',gain:0.3,prompt:'PRIVATE_PROMPT'}));assert.equal(fallback.operation,'node.update');assert.equal(fallback.targets[0]?.name,'Document');assert.deepEqual(fallback.fields,[]);assert.doesNotMatch(JSON.stringify(fallback),/PRIVATE_/u);
});
for(const text of ['镜头从左/右两侧推进','A/B 对比','16/9 画幅','慢慢推近 1/2 速度','台词：密码：芝麻开门'])test(`whitelisted description and subtitle retain the exact user text: ${text}`,()=>{
  for(const [operation,kind,property,inputKey] of [['shot.update','shot','description','prompt'],['timeline.subtitle.update','timeline_subtitle','subtitleText','text']] as const){
    const display=projectAgentTaskChangeDisplay(change(operation,kind,{[inputKey]:'previous'},{[inputKey]:text}));assert.equal(display.fields.find(field=>field.property===property)?.after,text);assert.ok(agentTaskDisplaySchema.safeParse(display).success);
    const id=randomUUID(),args:AgentTaskJson=operation==='shot.update'?{shotId:id,patch:{prompt:text}}:{cueId:id,text},planned=projectAgentTaskStepDisplay(step(`mioon_${operation.replaceAll('.','_')}`,args,{kind,id}),()=>({[inputKey]:text}),true);
    assert.ok(planned);const field=planned.fields.find(item=>item.property===property);assert.equal(field?.after,text);assert.equal(field?.current,text);assert.ok(agentTaskDisplaySchema.safeParse(planned).success);
  }
});
test('whitelisted prose keeps URLs, paths, UUIDs, identity prefixes and credential-like story text',()=>{
  for(const text of ['https://example.com/story/reference','/Scenes/Opening and C:\\Media\\story.mov',randomUUID(),'shot_opening_12345678','The password is sesame; apiKey=fictional-prop and Bearer SYNTHETIC_STORY_WORDS']){
    const display=projectAgentTaskChangeDisplay(change('shot.update','shot',null,{prompt:text}));assert.equal(display.fields.find(field=>field.property==='description')?.after,text);assert.ok(agentTaskDisplaySchema.safeParse(display).success);
  }
  for(const name of ['/Scenes/source.mp4','C:\\Media\\source.mp4','https://example.com/story/source.mp4'])assert.equal(projectAgentTaskChangeDisplay(change('timeline.clip.update','timeline_clip',null,{name,durationFrames:1})).targets[0]?.name,'source.mp4');
});
test('display text normalizes C0/C1 and every directional control while retaining ordinary Unicode text',()=>{
  const controls=['\u0000','\u001f','\u007f','\u0080','\u009f','\u061c','\u200e','\u200f','\u202a','\u202b','\u202c','\u202d','\u202e','\u2066','\u2067','\u2068','\u2069'];
  for(const control of controls){const display=projectAgentTaskChangeDisplay(change('shot.update','shot',null,{prompt:` \talpha${control}beta\n  gamma  `}));assert.equal(display.fields.find(field=>field.property==='description')?.after,'alpha beta gamma');}
  const text='雨 👩‍🎨 cafe\u0301',display=projectAgentTaskChangeDisplay(change('timeline.subtitle.update','timeline_subtitle',null,{text}));assert.equal(display.fields.find(field=>field.property==='subtitleText')?.after,text);
});
test('display truncation preserves complete Unicode characters within existing UTF-16 schema limits',()=>{
  for(const [text,expected] of [['景'.repeat(238)+'😀tail','景'.repeat(238)+'😀'],['景'.repeat(239)+'😀','景'.repeat(239)],['\n'.repeat(8190)+'😀tail','😀']] as const){
    const display=projectAgentTaskChangeDisplay(change('shot.update','shot',null,{prompt:text}));assert.equal(display.fields.find(field=>field.property==='description')?.after,expected);assert.ok(agentTaskDisplaySchema.safeParse(display).success);
  }
  const noPartial=projectAgentTaskChangeDisplay(change('shot.update','shot',null,{prompt:'\n'.repeat(8191)+'😀'}));assert.equal(noPartial.fields.find(field=>field.property==='description'),undefined);
  for(const [name,expected] of [['a'.repeat(78)+'😀tail','a'.repeat(78)+'😀'],['a'.repeat(79)+'😀','a'.repeat(79)]] as const){const display=projectAgentTaskChangeDisplay(change('shot.update','shot',null,{title:name}));assert.equal(display.targets[0]?.name,expected);assert.ok(agentTaskDisplaySchema.safeParse(display).success);}
});
test('generation changes project typed frozen parameters, image input and completed version number without prompts or authority',()=>{
  const video=projectAgentTaskChangeDisplay(change('generation.submit','job',null,{providerId:'mock',model:'mock-video',snapshot:{prompt:'PRIVATE_GENERATION_PROMPT',duration:6,aspectRatio:'16:9',referenceAssetIds:[],parameters:{resolution:'1080p',generateAudio:true,seed:123,scenario:'PRIVATE_SCENARIO'},referenceAssets:[{relativePath:'PRIVATE_MEDIA_PATH'}]},configuration:{secret:'PRIVATE_SECRET'}}));
  assert.deepEqual(video.fields.map(field=>field.property),['provider','model','aspectRatio','durationSeconds','mode','resolution','generateAudio','seed']);assert.equal(video.fields.find(field=>field.property==='mode')?.after,'text_to_video');assert.doesNotMatch(JSON.stringify(video),/PRIVATE_|snapshot|configuration|referenceAssets/u);
  const image=projectAgentTaskChangeDisplay(change('image.generate','image_task',null,{input:JSON.stringify({providerId:'mock',model:'mock-image',purpose:'generate',prompt:'PRIVATE_IMAGE_PROMPT',options:{size:'1024x1024',n:1,quality:'low',outputFormat:'png',background:'opaque'}})}));
  assert.equal(image.fields.find(field=>field.property==='resolution')?.after,'1024x1024');assert.equal(image.fields.find(field=>field.property==='mode')?.after,'text_to_image');assert.equal(image.fields.find(field=>field.property==='count')?.after,1);assert.doesNotMatch(JSON.stringify(image),/PRIVATE_IMAGE|prompt|input/u);
  const version=projectAgentTaskChangeDisplay(change('generation.submit','version',null,{number:3,providerId:'mock',model:'mock-video'}));assert.equal(version.fields.find(field=>field.property==='versionNumber')?.after,3);
  const model=randomUUID(),identity=projectAgentTaskChangeDisplay(change('generation.submit','job',null,{providerId:'mock',model}));assert.equal(identity.fields.find(field=>field.property==='model')?.after,model);
});
test('approval target names remain project-local and metadata lookup is read-only, including unknown historical kinds',()=>{
  const root=mkdtempSync(join(realpathSync(tmpdir()),'mioon-task-display-')),store=openStore(root),projectId=randomUUID(),foreignProject=randomUUID(),id=randomUUID(),foreignId=randomUUID();
  try{
    for(const project of [projectId,foreignProject])store.put('projects',{id:project,name:'Project',revision:1,createdAt:now,updatedAt:now});
    store.put('shots',{id,projectId,title:'Current scene',revision:1,createdAt:now,updatedAt:now});store.put('shots',{id:foreignId,projectId:foreignProject,title:'PRIVATE_FOREIGN_TARGET',revision:1,createdAt:now,updatedAt:now});
    const read=agentTaskDisplayTargetReader(store,projectId),changes=store.db.prepare('SELECT total_changes() AS n').get()?.n;
    assert.equal(read({kind:'shot',id})?.title,'Current scene');assert.equal(read({kind:'shot',id:foreignId}),undefined);assert.equal(read({kind:'project',id:foreignProject}),undefined);assert.equal(read({kind:'constructor',id}),undefined);assert.equal(read({kind:'shot',id:'/private/path'}),undefined);
    const foreign=projectAgentTaskStepDisplay(step('mioon_shot_update',{shotId:foreignId,patch:{duration:3}},{kind:'shot',id:foreignId}),read);assert.equal(foreign?.targets[0]?.name,undefined);assert.doesNotMatch(JSON.stringify(foreign),/PRIVATE_FOREIGN_TARGET/u);assert.equal(store.db.prepare('SELECT total_changes() AS n').get()?.n,changes);
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
test('pending tools use exact retained arguments, one-sided global creation parameters and revision-checked generation metadata',()=>{
  const id=randomUUID(),pending=step('mioon_timeline_clip_update',{clipId:id,patch:{gain:0.5,startFrame:90,rect:{x:20,y:30,width:640,height:360},path:'PRIVATE_PATH'}},{kind:'timeline_clip',id});
  const display=projectAgentTaskStepDisplay(pending,()=>({name:'Preview.mp4'}));assert.ok(display);assert.equal(display.targets[0]?.name,'Preview.mp4');assert.ok(display.fields.every(field=>!Object.hasOwn(field,'before')));assert.equal(display.fields.find(field=>field.property==='gainDb')?.after,20*Math.log10(0.5));assert.doesNotMatch(JSON.stringify(display),/PRIVATE_PATH|patch/u);
  const current=projectAgentTaskStepDisplay(pending,()=>({name:'Preview.mp4',gain:1,startFrame:30,durationFrames:120,rect:{x:10,y:15,width:1920,height:1080},private:'PRIVATE_CURRENT'}),true);assert.ok(current);assert.equal(current.fields.find(field=>field.property==='gainDb')?.current,0);assert.equal(current.fields.find(field=>field.property==='startFrame')?.current,30);assert.equal(current.fields.find(field=>field.property==='durationFrames'),undefined);assert.ok(current.fields.every(field=>field.before===undefined));assert.doesNotMatch(JSON.stringify(current),/PRIVATE_CURRENT/u);assert.ok(display.fields.every(field=>field.current===undefined));
  const prose=projectAgentTaskStepDisplay(step('mioon_shot_update',{shotId:id,patch:{prompt:'planned'}},{kind:'shot',id}),()=>({prompt:'Saved description /private/secret bearer SYNTHETIC_SAVED_VALUE',duration:9}),true);assert.ok(prose);assert.equal(prose.fields.length,1);assert.equal(prose.fields[0]?.current,'Saved description /private/secret bearer SYNTHETIC_SAVED_VALUE');
  const image=projectAgentTaskStepDisplay(step('mioon_image_generate',{providerId:'mock',model:'mock-image',purpose:'generate',prompt:'PRIVATE_PROMPT',options:{size:'1024x1024',n:1,quality:'low',outputFormat:'png',background:'opaque'}}));assert.ok(image);assert.equal(image.targets.length,0);assert.ok(image.fields.length>0);assert.ok(image.fields.every(field=>field.targetIndex===undefined));assert.ok(agentTaskDisplaySchema.safeParse(image).success);
  const submitted=step('mioon_generation_submit',{shotId:id,expectedRevision:2,providerId:'mock',model:'mock-video',parameters:{resolution:'1080p'}},{kind:'shot',id});
  const fresh=projectAgentTaskStepDisplay(submitted,()=>({title:'Scene',revision:2,duration:4,aspectRatio:'9:16',referenceAssetIds:[randomUUID()]}));assert.equal(fresh?.fields.find(field=>field.property==='mode')?.after,'image_to_video');assert.equal(fresh?.fields.find(field=>field.property==='durationSeconds')?.after,4);assert.equal(fresh?.fields.find(field=>field.property==='versionNumber'),undefined);
  const stale=projectAgentTaskStepDisplay(submitted,()=>({title:'Scene',revision:3,duration:8,aspectRatio:'16:9',referenceAssetIds:[]}));assert.ok(stale);assert.equal(stale.fields.find(field=>field.property==='durationSeconds'),undefined);assert.equal(stale.fields.find(field=>field.property==='mode'),undefined);
});
test('strict shared display schema rejects arbitrary properties, object values, invalid targets and oversized or nonfinite values',()=>{
  const valid=projectAgentTaskChangeDisplay(change('shot.update','shot',{duration:2},{duration:3}));assert.ok(agentTaskDisplaySchema.safeParse(valid).success);assert.ok(agentTaskDisplaySchema.safeParse({...valid,conflict:true}).success);assert.equal(agentTaskDisplaySchema.safeParse({...valid,conflict:false}).success,false);assert.equal(projectAgentTaskStepDisplay(step('mioon_shot_update',{conflict:true}))?.conflict,undefined);
  for(const altered of [{...valid,snapshot:{}},{...valid,fields:[{...valid.fields[0],property:'prompt'}]},{...valid,fields:[{...valid.fields[0],after:{secret:true}}]},{...valid,fields:[{...valid.fields[0],after:Infinity}]},{...valid,fields:[{...valid.fields[0],current:Infinity}]},{...valid,fields:[{...valid.fields[0],current:'x'.repeat(241)}]},{...valid,fields:[{...valid.fields[0],current:{private:true}}]},{...valid,fields:[{...valid.fields[0],after:'x'.repeat(241)}]},{...valid,fields:[{...valid.fields[0],targetIndex:1}]},{...valid,targets:[{kind:'shot',id:'/private/path'}]}])assert.equal(agentTaskDisplaySchema.safeParse(altered).success,false);
  const emoji=projectAgentTaskChangeDisplay(change('shot.update','shot',null,{prompt:'😀'.repeat(200)}));assert.ok(agentTaskDisplaySchema.safeParse(emoji).success);
});
