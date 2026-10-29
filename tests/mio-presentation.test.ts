import test from 'node:test';
import assert from 'node:assert/strict';
import type {AgentTaskDisplay,AgentTaskDisplayField,AgentTaskStep} from '../packages/contracts/src/agent-tasks-v2.ts';
import {LOCALES,translate,validateCatalogs} from '../packages/i18n/src/index.ts';
import {mioPanelMessages} from '../packages/i18n/src/catalogs/mio-panel.ts';
import {taskCurrentEntries,taskBackgroundLocation,taskChangeSummary,taskDisplayEntries,taskDisplayLines,taskDisplayTargets,taskDurationSeconds,taskOperationTitle,taskStepStatusKey,taskStepTitle} from '../apps/web/src/agent-task-presentation.ts';

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

test('display target names normalize project content and strip only media path prefixes',()=>{
  const value=display();
  assert.equal(taskDisplayTargets(value,'en',()=> 'Current scene.mp4'),'Clip · Current scene.mp4');
  assert.equal(taskDisplayTargets(value,'en',()=> 'clips/a.mp4'),'Clip · a.mp4');
  value.targets[0]!.name='/Users/private/scene.mp4';
  assert.equal(taskDisplayTargets(value,'en'),'Clip · scene.mp4');
  value.targets[0]!.name='scene.mp4';value.targetCount=3;
  assert.equal(taskDisplayTargets(value,'en'),'Clip · scene.mp4、2 more');
  assert.equal(taskDisplayTargets(undefined,'ja'),translate('ja','agent.display.target.unknown'));
  const cases=[
    {kind:'timeline_subtitle',operation:'timeline.subtitle.add',name:'A/B 对比：雨后的城市',shown:'A/B 对比：雨后的城市'},
    {kind:'shot',operation:'shot.create',name:'左/右机位',shown:'左/右机位'},
    {kind:'timeline_clip',operation:'timeline.clip.add',name:'clips/a.mp4',shown:'a.mp4'},
    {kind:'asset',operation:'asset.update',name:'clips\\a.mp4',shown:'a.mp4'},
    {kind:'project',operation:'project.update',name:'项目 A/B \\ 版本',shown:'项目 A/B \\ 版本'},
  ] as const;
  for(const locale of LOCALES)for(const item of cases){
    const projection:AgentTaskDisplay={operation:item.operation,targets:[{kind:item.kind,id:first,name:item.name}],targetCount:1,fields:[]};
    assert.equal(taskDisplayTargets(projection,locale),`${translate(locale,`agent.display.target.${item.kind}`)} · ${item.shown}`);
    assert.equal(taskDisplayTargets({...projection,targets:[{kind:item.kind,id:first}]},locale,()=>item.name),taskDisplayTargets(projection,locale));
    if(['shot.create','timeline.subtitle.add','timeline.clip.add'].includes(item.operation))assert.ok(taskChangeSummary(projection,locale).includes(item.shown));
  }
  const project:AgentTaskDisplay={operation:'project.update',targets:[{kind:'project',id:first,name:'  A\u202E/B\n  \\ C  '}],targetCount:1,fields:[]};
  assert.equal(taskDisplayTargets(project,'en'),'Project · A /B \\ C');
  for(const name of ['apiKey: synthetic-only',first,'https://example.invalid/own-title']){
    project.targets[0]!.name=name;assert.equal(taskDisplayTargets(project,'en'),`Project · ${name}`);
  }
  project.targets[0]!.name='🌃'.repeat(50);assert.equal(taskDisplayTargets(project,'en'),`Project · ${'🌃'.repeat(40)}`);
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
    {label:'片段 · sound-bed.wav · 音量',value:'0.0 dB → -8.0 dB'},
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
  assert.deepEqual(entries,[{label:'服务商',value:'mock'},{label:'方式',value:'图生视频 · 首帧参考'},{label:'比例',value:'9:16'},{label:'时长',value:'5.0 秒'},{label:'生成声音',value:'关闭'},{label:'版本',value:'V2'}]);
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
  assert.deepEqual(taskCurrentEntries(planned,'en'),[{label:'Clip · First clip · Volume',value:'0.0 dB'},{label:'Clip · Second clip · Timeline position',value:'30 frames'},{label:'Clip · First clip · Out-point',value:'100 frames'},{label:'Clip · First clip · Horizontal position',value:'2 px'}]);
  assert.deepEqual(planned,snapshot);assert.deepEqual(taskCurrentEntries({...planned,fields:planned.fields.map(({current,...field})=>field)},'en'),[]);
  assert.deepEqual(taskCurrentEntries(undefined,'en'),[]);
});
test('server current shot and subtitle values remain bounded and safe; absent and unassociated attributes stay absent',()=>{
  const shot:AgentTaskDisplay={operation:'shot.update',targets:[{kind:'shot',id:first,name:'Scene'}],targetCount:1,fields:[{targetIndex:0,property:'description',unit:'text',after:'plan',current:'A saved description'},{targetIndex:0,property:'durationSeconds',unit:'seconds',after:4,current:2},{targetIndex:0,property:'aspectRatio',unit:'ratio',after:'9:16',current:'16:9'}]};
  assert.deepEqual(taskCurrentEntries(shot,'en'),[{label:'Description',value:'A saved description'},{label:'Duration',value:'2.0 s'},{label:'Aspect ratio',value:'16:9'}]);
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

test('change frames use the current timeline fps and seconds and decibels keep one decimal',()=>{
  const value=display('timeline.clip.update',[
    {targetIndex:0,property:'durationFrames',unit:'frames',before:180,after:135},
    {targetIndex:0,property:'gainDb',unit:'db',before:0,after:-8.25},
    {targetIndex:0,property:'fadeInFrames',unit:'frames',before:null,after:6},
  ]);
  assert.deepEqual(taskDisplayLines(value,'zh-Hans',{fps:30}),['时长 6.0 秒 → 4.5 秒','音量 0.0 dB → -8.3 dB','淡入 0.2 秒']);
  assert.equal(taskChangeSummary(value,'zh-Hans',{fps:30}),'时长 6.0 秒 → 4.5 秒 · 音量 0.0 dB → -8.3 dB · 等 1 项');
  for(const locale of LOCALES){
    assert.ok(taskDisplayLines(value,locale,{fps:30})[0]?.includes('6.0'));
    assert.ok(taskDisplayLines(value,locale,{fps:30})[0]?.includes('4.5'));
    assert.ok(taskDisplayLines(value,locale,{fps:30})[1]?.includes('-8.3 dB'));
  }
  value.fields=[{property:'durationFrames',unit:'frames',after:2997},{property:'gainDb',unit:'db',after:-0.001}];
  assert.deepEqual(taskDisplayEntries(value,'en',{fps:29.97}),[{label:'Duration',value:'100.0 s'},{label:'Volume',value:'0.0 dB'}]);
  value.fields=[{property:'gainDb',unit:'db',before:0,after:'muted'}];
  for(const locale of LOCALES)assert.equal(taskDisplayEntries(value,locale)[0]?.value,`0.0 dB → ${translate(locale,'agent.display.muted')}`);
});

test('unavailable or unusable timeline fps falls back to frames',()=>{
  const value=display('timeline.clip.update',[{property:'durationFrames',unit:'frames',before:180,after:135}]);
  for(const fps of [undefined,0,-30,NaN,Infinity,Number.MIN_VALUE])assert.equal(taskDisplayLines(value,'en',{fps})[0],'Duration 180 frames → 135 frames');
});

test('derived out-point is omitted for the same target range change without requiring unchanged inputs',()=>{
  const value=display('timeline.clip.update',[
    {targetIndex:0,property:'sourceInFrame',unit:'frames',before:0,after:30},
    {targetIndex:0,property:'durationFrames',unit:'frames',before:180,after:135},
    {targetIndex:0,property:'sourceOutFrame',unit:'frames',before:180,after:165},
    {targetIndex:1,property:'sourceOutFrame',unit:'frames',before:30,after:60},
  ]);
  value.targets.push({kind:'timeline_clip',id:second,name:'another.mp4'});value.targetCount=2;
  const entries=taskDisplayEntries(value,'en',{fps:30});
  assert.equal(entries.length,3);assert.ok(entries[0]?.label.includes('In-point'));assert.ok(entries[1]?.label.includes('Duration'));assert.equal(entries[2]?.value,'1.0 s → 2.0 s');assert.ok(entries[2]?.label.includes('another.mp4'));
  value.fields[0]!.before=Infinity;value.fields[0]!.after=Infinity;value.fields[1]!.before=Infinity;value.fields[1]!.after=Infinity;
  assert.ok(taskDisplayEntries(value,'en',{fps:30}).some(entry=>entry.label.includes('scene-b.mp4')&&entry.label.includes('Out-point')));
  for(const property of ['sourceInFrame','durationFrames'] as const){
    const changed=display('timeline.clip.update',[{targetIndex:0,property,unit:'frames',before:180,after:135},{targetIndex:0,property:'sourceOutFrame',unit:'frames',before:180,after:135}]);
    assert.equal(taskDisplayEntries(changed,'en',{fps:30}).length,1);
    assert.ok(!taskDisplayLines(changed,'en',{fps:30}).join('').includes('Out-point'));
  }
});

test('compact changes show two properties with an exact remainder and keep the full details list',()=>{
  const value=display('timeline.clip.update',[
    {targetIndex:0,property:'durationFrames',unit:'frames',before:180,after:135},
    {targetIndex:0,property:'sourceInFrame',unit:'frames',before:0,after:30},
    {targetIndex:0,property:'sourceOutFrame',unit:'frames',before:180,after:165},
    {targetIndex:0,property:'gainDb',unit:'db',before:0,after:-6},
    {targetIndex:0,property:'fadeInFrames',unit:'frames',before:0,after:6},
    {targetIndex:0,property:'fadeOutFrames',unit:'frames',before:0,after:12},
  ]);
  for(const locale of LOCALES){
    const details=taskDisplayLines(value,locale,{fps:30}),summary=taskChangeSummary(value,locale,{fps:30});
    assert.equal(details.length,5);assert.ok(summary.includes(details[0]!));assert.ok(summary.includes(details[1]!));assert.ok(summary.endsWith(translate(locale,'agent.display.moreFields',{count:3})));
    assert.ok(!summary.includes(details[2]!));assert.ok(!summary.includes(details[3]!));assert.ok(!summary.includes(details[4]!));
  }
});

test('setting an empty value uses action copy and does not invent an empty-to-value change',()=>{
  const value=display('timeline.clip.update',[{targetIndex:0,property:'fadeInFrames',unit:'frames',before:null,after:6}]);
  assert.equal(taskChangeSummary(value,'zh-Hans',{fps:30}),'设置淡入 0.2 秒');
  for(const locale of LOCALES){
    const entry=taskDisplayEntries(value,locale,{fps:30})[0]!;
    assert.equal(taskChangeSummary(value,locale,{fps:30}),translate(locale,'agent.display.setField',{field:entry.label,value:entry.value}));
    assert.doesNotMatch(taskChangeSummary(value,locale,{fps:30}),/→/u);
  }
  value.fields[0]!.before=0;assert.equal(taskChangeSummary(value,'en',{fps:30}),'Fade in 0.0 s → 0.2 s');
  const shot:AgentTaskDisplay={operation:'shot.update',targets:[],targetCount:0,fields:[{property:'description',unit:'text',before:'',after:'A/B 对比'}]};
  assert.equal(taskChangeSummary(shot,'zh-Hans'),'设置画面描述 A/B 对比');
});

test('subtitle clip and shot creation uses localized add copy without empty arrows',()=>{
  const subtitle:AgentTaskDisplay={operation:'timeline.subtitle.add',targets:[{kind:'timeline_subtitle',id:first}],targetCount:1,fields:[{targetIndex:0,property:'subtitleText',unit:'text',before:null,after:'台词：密码：芝麻开门'}]};
  assert.equal(taskChangeSummary(subtitle,'zh-Hans'),'添加字幕「台词：密码：芝麻开门」');
  for(const locale of LOCALES)assert.equal(taskChangeSummary(subtitle,locale),translate(locale,'agent.display.add.subtitle',{text:'台词：密码：芝麻开门'}));
  const clip=display('timeline.clip.add',[{targetIndex:0,property:'durationFrames',unit:'frames',before:null,after:120}]);
  const shot:AgentTaskDisplay={operation:'shot.create',targets:[{kind:'shot',id:first,name:'Original title'}],targetCount:1,fields:[{targetIndex:0,property:'durationSeconds',unit:'seconds',before:null,after:4}]};
  for(const locale of LOCALES){
    assert.ok(taskChangeSummary(clip,locale,{fps:30}).startsWith(translate(locale,'agent.display.add.clip',{text:'scene-b.mp4'})));
    assert.ok(taskChangeSummary(shot,locale,{lookup:()=> 'Current title'}).startsWith(translate(locale,'agent.display.add.shot',{text:'Current title'})));
    assert.doesNotMatch(taskChangeSummary(clip,locale,{fps:30})+taskChangeSummary(shot,locale),/→/u);
  }
  subtitle.targets=[];subtitle.targetCount=0;delete subtitle.fields[0]!.targetIndex;
  assert.equal(taskChangeSummary(subtitle,'en'),'Add subtitle “台词：密码：芝麻开门”');
});

test('a previs scene save shows its figure, prop and keyframe counts, and previs tools have short titles',()=>{
  const value:AgentTaskDisplay={operation:'previs.scene.set',targets:[{kind:'node',id:'11111111-1111-4111-8111-111111111111',name:'雨夜街口'}],targetCount:1,fields:[
    {targetIndex:0,property:'figureCount',unit:'count',before:1,after:2},{targetIndex:0,property:'propCount',unit:'count',before:0,after:2},{targetIndex:0,property:'keyframeCount',unit:'count',before:0,after:1}]};
  assert.equal(taskChangeSummary(value,'zh-Hans'),'人偶 1 → 2 · 道具 0 → 2 · 等 1 项');
  assert.deepEqual(taskDisplayLines(value,'en'),['Figures 1 → 2','Props 0 → 2','Keyframes 0 → 1']);
  assert.deepEqual(taskDisplayLines({...value,operation:'node.update'},'en'),[],'the counts belong to the scene save only');
  assert.deepEqual(taskDisplayLines({...value,fields:[{targetIndex:0,property:'figureCount',unit:'text',after:'2'}]},'en'),[]);
  for(const locale of LOCALES)for(const operation of ['previs.inspect','previs.create','previs.scene.set'])assert.notEqual(taskOperationTitle(operation,locale),translate(locale,'agent.display.fallback'),`${locale} ${operation}`);
  assert.deepEqual(['mioon_previs_inspect','mioon_previs_create','mioon_previs_scene_set'].map(name=>taskOperationTitle(name,'zh-Hans')),['查看机位预演','新建机位预演','写入预演场景']);
});
