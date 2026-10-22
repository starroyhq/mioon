import test from 'node:test';
import assert from 'node:assert/strict';
import type {AgentTaskDisplay,AgentTaskDisplayField,AgentTaskStep} from '../packages/contracts/src/agent-tasks-v2.ts';
import {LOCALES,translate,validateCatalogs} from '../packages/i18n/src/index.ts';
import {mioPanelMessages} from '../packages/i18n/src/catalogs/mio-panel.ts';
import {taskCurrentEntries,taskBackgroundLocation,taskDisplayEntries,taskDisplayLines,taskDisplayTargets,taskDurationSeconds,taskOperationTitle,taskStepStatusKey,taskStepTitle} from '../apps/web/src/agent-task-presentation.ts';

const first='00000000-0000-4000-8000-000000000001',second='00000000-0000-4000-8000-000000000002';
function display(operation='timeline.clip.update',fields:AgentTaskDisplayField[]=[]):AgentTaskDisplay {
  return {operation,targets:[{kind:'timeline_clip',id:first,name:'scene-b.mp4'}],targetCount:1,fields};
}
function step(extra:Partial<AgentTaskStep>={}):AgentTaskStep {
  return {id:first,runId:second,position:1,kind:'tool',status:'completed',createdAt:'2026-10-21T12:00:00.000Z',updatedAt:'2026-10-21T12:00:01.200Z',toolCall:{id:'call-1',name:'mioon_timeline_clip_update',arguments:{private:'not for presentation'}},...extra};
}

test('Mio presentation catalog has four languages and matching parameters',()=>{
  assert.deepEqual(validateCatalogs(mioPanelMessages),[]);
  for(const locale of LOCALES){
    assert.ok(translate(locale,'agent.panel.authorizationContent').length>40);
    assert.ok(translate(locale,'agent.panel.authorizationExcluded').length>15);
    assert.equal(translate(locale,'agent.panel.steps',{count:3}).includes('3'),true);
    for(const entry of Object.values(mioPanelMessages))assert.doesNotMatch(entry[locale],/ミオ|编辑保护|編輯保護|\bintent\b|dispatch_started/u);
  }
  assert.match(translate('zh-Hans','agent.panel.authorizationContent'),/创作方向.*素材标注与备注.*主体库.*生成记录/u);
  assert.match(translate('zh-Hans','agent.panel.authorizationExcluded'),/向此助理模型/u);
});

test('step fallback titles use short localized labels without internal tool names',()=>{
  for(const locale of LOCALES){
    assert.equal(taskStepTitle(step({kind:'model',text:'Do not use a model-authored title here'}),locale),translate(locale,'agent.display.model'));
    assert.equal(taskStepTitle(step({kind:'wait'}),locale),translate(locale,'agent.display.wait'));
    assert.equal(taskOperationTitle('mioon_generation_submit',locale),taskOperationTitle('generation.submit',locale));
    assert.equal(taskOperationTitle('invented.operation',locale),translate(locale,'agent.display.fallback'));
    assert.equal(taskOperationTitle('__proto__',locale),translate(locale,'agent.display.fallback'));
    assert.equal(taskStepTitle(step({display:display()}),locale),`${taskOperationTitle('timeline.clip.update',locale)} · ${taskDisplayTargets(display(),locale)}`);
    assert.doesNotMatch(taskStepTitle(step(),locale),/mioon_|timeline\.|revision|版本返回冲突/u);
    assert.ok(taskOperationTitle('timeline.clip.update',locale).length<30);
  }
  assert.equal(taskStepTitle(step({text:'调整背景音乐音量'}),'zh-Hans'),'调整背景音乐音量');
});

test('unsafe or malformed tool explanations fall back without reflecting identities, paths or credentials',()=>{
  const fallback=taskOperationTitle('timeline.clip.update','en');
  for(const text of ['x'.repeat(41),'line one\nline two','<img src=x>',first,'/Users/private/project.mov','C:\\private\\key','apiKey: synthetic-only','Bearer synthetic-only','mioon_timeline_clip_update','Adjust mioon_shot_update now','Read projectId now','dispatch_started','completed','failed','unknown','denied','rejected','{"operation":"edit"}','\u202Ehidden','zero\u200Bwidth']){
    assert.equal(taskStepTitle(step({text}),'en'),fallback,text);
  }
  assert.equal(taskStepTitle(step({toolCall:{id:'x',name:'mioon_unknown_private_tool',arguments:{secret:'synthetic-only'}}}),'en'),translate('en','agent.display.fallback'));
});

test('display targets prefer existing project names and never show target identities or locations',()=>{
  const value=display();
  assert.equal(taskDisplayTargets(value,'en',()=> 'Current scene.mp4'),'Clip · Current scene.mp4');
  assert.equal(taskDisplayTargets(value,'en',()=> 'https://private.example/source'),'Clip · scene-b.mp4');
  value.targets[0]!.name=first;
  assert.equal(taskDisplayTargets(value,'en'),'Clip');
  value.targets[0]!.name='/Users/private/scene.mp4';
  assert.equal(taskDisplayTargets(value,'en'),'Clip · scene.mp4');
  value.targets[0]!.name='apiKey: synthetic-only';
  value.targetCount=3;
  assert.equal(taskDisplayTargets(value,'en'),'Clip、2 more');
  assert.equal(taskDisplayTargets(undefined,'ja'),translate('ja','agent.display.target.unknown'));
});

test('change values retain before and after units and target association',()=>{
  const value=display('timeline.clip.update',[
    {targetIndex:0,property:'durationFrames',unit:'frames',before:180,after:135},
    {targetIndex:1,property:'gainDb',unit:'db',before:0,after:-8},
    {targetIndex:1,property:'fadeInFrames',unit:'frames',after:12},
  ]);
  value.targets.push({kind:'timeline_clip',id:second,name:'sound-bed.wav'});value.targetCount=2;
  assert.deepEqual(taskDisplayEntries(value,'zh-Hans'),[
    {label:'片段 · scene-b.mp4 · 时长',value:'180 帧 → 135 帧'},
    {label:'片段 · sound-bed.wav · 音量',value:'0 dB → -8 dB'},
    {label:'片段 · sound-bed.wav · 淡入',value:'12 帧'},
  ]);
  for(const locale of LOCALES){
    const lines=taskDisplayLines(value,locale);
    assert.equal(lines.length,3);assert.ok(lines[0]!.includes('scene-b.mp4'));assert.ok(lines[1]!.includes('sound-bed.wav'));
    assert.doesNotMatch(lines.join(' '),/targetIndex|durationFrames|gainDb|00000000/u);
  }
});

test('generation previews localize finite enum values and allow fields with no target index',()=>{
  const value:AgentTaskDisplay={operation:'generation.submit',targets:[],targetCount:0,fields:[
    {property:'provider',unit:'enum',after:'mock'},
    {property:'mode',unit:'enum',after:'image_to_video'},
    {property:'aspectRatio',unit:'ratio',after:'9:16'},
    {property:'durationSeconds',unit:'seconds',after:5},
    {property:'generateAudio',unit:'boolean',after:false},
    {property:'versionNumber',unit:'count',after:2},
  ]};
  const entries=taskDisplayEntries(value,'zh-Hans');
  assert.deepEqual(entries,[{label:'服务商',value:'mock'},{label:'方式',value:'图生视频 · 首帧参考'},{label:'比例',value:'9:16'},{label:'时长',value:'5 秒'},{label:'生成声音',value:'关闭'},{label:'版本',value:'V2'}]);
  assert.match(taskDisplayLines(value,'ja')[1]!,/最初のフレーム/u);
});

test('position values retain finite negative and fractional coordinates while dimensions remain bounded',()=>{
  const value=display('timeline.clip.update',[
    {property:'positionX',unit:'pixels',before:-1.25,after:4.5},
    {property:'positionY',unit:'pixels',after:-8.5},
    {property:'width',unit:'pixels',after:-2},
    {property:'height',unit:'pixels',after:1.5},
  ]);
  assert.deepEqual(taskDisplayEntries(value,'en'),[{label:'Horizontal position',value:'-1.25 px → 4.5 px'},{label:'Vertical position',value:'-8.5 px'}]);
});

test('only whitelisted operation/property/unit combinations can become display lines',()=>{
  const fields:AgentTaskDisplayField[]=[
    {property:'durationFrames',unit:'seconds',before:180,after:135},
    {property:'description',unit:'text',after:'a prompt must not be shown for a clip operation'},
    {targetIndex:10,property:'durationFrames',unit:'frames',after:10},
    {property:'durationFrames',unit:'frames',after:-1},
    {property:'durationFrames',unit:'frames',after:Infinity},
  ];
  assert.deepEqual(taskDisplayLines(display('timeline.clip.update',fields),'en'),[]);
  assert.deepEqual(taskDisplayLines(display('node.update',[{property:'durationFrames',unit:'frames',after:12}]),'en'),[]);
  assert.deepEqual(taskDisplayLines(display('unrecognized.operation',[{property:'durationFrames',unit:'frames',after:12}]),'en'),[]);
  const shot:AgentTaskDisplay={operation:'shot.update',targets:[{kind:'shot',id:first,name:'City'}],targetCount:1,fields:[{property:'description',unit:'text',before:'A city at night',after:'A city at sunrise'}]};
  assert.deepEqual(taskDisplayEntries(shot,'en'),[{label:'Description',value:'A city at night → A city at sunrise'}]);
  for(const content of ['https://example.com/path','/Users/synthetic/project',first,'secret: synthetic-only','<script>']){
    shot.fields[0]!.after=content;assert.deepEqual(taskDisplayEntries(shot,'en'),[{label:'Description',value:`A city at night → ${content}`}]);
  }
});

test('step status and duration helpers return presentation values without inventing time',()=>{
  for(const locale of LOCALES)for(const status of ['intent','awaiting_approval','dispatch_started','completed','denied','rejected','failed','unknown'] as const){
    const label=translate(locale,taskStepStatusKey(status));assert.ok(label);assert.notEqual(label,status);
  }
  assert.equal(taskDurationSeconds('2026-10-21T12:00:00.000Z','2026-10-21T12:00:01.240Z'),1.2);
  assert.equal(taskDurationSeconds('not-a-date','2026-10-21T12:00:01.000Z'),undefined);
  assert.equal(taskDurationSeconds('2026-10-21T12:00:02.000Z','2026-10-21T12:00:01.000Z'),undefined);
});

test('background navigation maps exact existing domain entries without presenting their identities',()=>{
  for(const [kind,expected] of [['job',first],['export',`render:${first}`],['image',`image:${first}`],['frame',`frame:${first}`]] as const){
    const value=step({toolCall:{id:'wait',name:'mioon_task_wait',arguments:{kind,id:first}}});
    const original=JSON.stringify(value);
    assert.equal(taskBackgroundLocation(value),expected);
    assert.equal(JSON.stringify(value),original);
    for(const locale of LOCALES)assert.ok(!taskStepTitle(value,locale).includes(first));
  }
  for(const id of ['https://private.example/job','render:'+first,first+'/extra','not-an-id',' '+first]){
    assert.equal(taskBackgroundLocation(step({toolCall:{id:'wait',name:'mioon_task_wait',arguments:{kind:'job',id}}})),undefined);
  }
  assert.equal(taskBackgroundLocation(step({toolCall:{id:'wait',name:'mioon_unknown_wait',arguments:{kind:'job',id:first}}})),undefined);
});

test('generation navigation requires an unambiguous job reference and never guesses from a shot identity',()=>{
  const generation=step({toolCall:{id:'generate',name:'mioon_generation_submit',arguments:{shotId:second}},result:{id:first,projectId:second,shotId:second},targets:[{kind:'shot',id:second,revision:1}]});
  const original=JSON.stringify(generation);
  assert.equal(taskBackgroundLocation(generation),first);
  assert.equal(JSON.stringify(generation),original);
  assert.equal(taskBackgroundLocation({...generation,result:undefined}),undefined);
  assert.equal(taskBackgroundLocation({...generation,result:{id:second,shotId:second,projectId:first}}),undefined);
  assert.equal(taskBackgroundLocation({...generation,result:{id:first}}),undefined);
  assert.equal(taskBackgroundLocation({...generation,result:undefined,targets:[{kind:'job',id:first,revision:1}]}),first);
  assert.equal(taskBackgroundLocation({...generation,targets:[{kind:'job',id:second,revision:1}]}),undefined);
  assert.equal(taskBackgroundLocation({...generation,result:undefined,toolCall:{id:'image',name:'mioon_image_generate',arguments:{}}}),`image-request:${generation.id}`);
  assert.equal(taskBackgroundLocation({...generation,result:undefined,toolCall:{id:'frame',name:'mioon_frame_extract',arguments:{}}}),`frame-request:${generation.id}`);
  for(const locale of LOCALES)assert.doesNotMatch(taskStepTitle(generation,locale),new RegExp(first+'|'+second));
});


test('conflict current values come only from server fields, retain target association and never substitute planned values',()=>{
  const planned:AgentTaskDisplay={operation:'timeline.clip.update',targets:[{kind:'timeline_clip',id:first,name:'First clip'},{kind:'timeline_clip',id:second,name:'Second clip'}],targetCount:2,fields:[{targetIndex:0,property:'gainDb',unit:'db',after:-6,current:0},{targetIndex:1,property:'startFrame',unit:'frames',after:60,current:30},{targetIndex:0,property:'sourceOutFrame',unit:'frames',after:120,current:100},{targetIndex:0,property:'positionX',unit:'pixels',after:4,current:2}]};
  const snapshot=structuredClone(planned);
  assert.deepEqual(taskCurrentEntries(planned,'en'),[{label:'Clip · First clip · Volume',value:'0 dB'},{label:'Clip · Second clip · Timeline position',value:'30 frames'},{label:'Clip · First clip · Out-point',value:'100 frames'},{label:'Clip · First clip · Horizontal position',value:'2 px'}]);
  assert.deepEqual(planned,snapshot);assert.deepEqual(taskCurrentEntries({...planned,fields:planned.fields.map(({current,...field})=>field)},'en'),[]);
  assert.deepEqual(taskCurrentEntries(undefined,'en'),[]);
});
test('server current shot and subtitle values remain bounded and safe; absent and unassociated attributes stay absent',()=>{
  const shot:AgentTaskDisplay={operation:'shot.update',targets:[{kind:'shot',id:first,name:'Scene'}],targetCount:1,fields:[{targetIndex:0,property:'description',unit:'text',after:'plan',current:'A saved description'},{targetIndex:0,property:'durationSeconds',unit:'seconds',after:4,current:2},{targetIndex:0,property:'aspectRatio',unit:'ratio',after:'9:16',current:'16:9'}]};
  assert.deepEqual(taskCurrentEntries(shot,'en'),[{label:'Description',value:'A saved description'},{label:'Duration',value:'2 s'},{label:'Aspect ratio',value:'16:9'}]);
  assert.deepEqual(taskCurrentEntries({...shot,fields:[{targetIndex:0,property:'description',unit:'text',after:'safe plan',current:'apiKey: synthetic-only'}]},'en'),[{label:'Description',value:'apiKey: synthetic-only'}]);
  const subtitle:AgentTaskDisplay={operation:'timeline.subtitle.update',targets:[{kind:'timeline_subtitle',id:first}],targetCount:1,fields:[{targetIndex:0,property:'subtitleText',unit:'text',after:'plan',current:'Saved subtitle'}]};
  assert.equal(taskCurrentEntries(subtitle,'en')[0]?.value,'Saved subtitle');assert.deepEqual(taskCurrentEntries({...subtitle,fields:[{...subtitle.fields[0]!,current:'/synthetic/source'}]},'en'),[{label:'Subtitle text',value:'/synthetic/source'}]);
  assert.deepEqual(taskCurrentEntries({...shot,fields:[{property:'description',unit:'text',after:'no associated target',current:'must not guess'}]},'en'),[]);
});

test('authorized description and subtitle content survives formatting in all locales',()=>{
  const originals=['镜头从左/右两侧推进','A/B 对比','16/9 画幅','慢慢推近 1/2 速度','台词：密码：芝麻开门'];
  for(const locale of LOCALES)for(const content of originals)for(const property of ['description','subtitleText'] as const){
    const isShot=property==='description';
    const value:AgentTaskDisplay={operation:isShot?'shot.update':'timeline.subtitle.update',targets:[{kind:isShot?'shot':'timeline_subtitle',id:first}],targetCount:1,fields:[{targetIndex:0,property,unit:'text',after:content,current:content}]};
    assert.equal(taskDisplayEntries(value,locale)[0]?.value,content);
    assert.equal(taskCurrentEntries(value,locale)[0]?.value,content);
  }
  const value:AgentTaskDisplay={operation:'shot.update',targets:[],targetCount:0,fields:[{property:'description',unit:'text',after:'  A\u0000\u061c\u200e\u202e\u2067\n B\tC  '}]};
  assert.equal(taskDisplayEntries(value,'en')[0]?.value,'A B C');
  value.fields[0]!.after='😀'.repeat(121);
  assert.equal(taskDisplayEntries(value,'en')[0]?.value,'😀'.repeat(120));
  value.fields[0]!.after='a'.repeat(239)+'😀';
  assert.equal(taskDisplayEntries(value,'en')[0]?.value,'a'.repeat(239));
});
