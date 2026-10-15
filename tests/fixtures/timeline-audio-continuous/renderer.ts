import {createContinuousAudioPreviewClient,type ContinuousAudioClientSession} from '../../../apps/web/src/timeline-audio-continuous-client.ts';
import {createContinuousTimelineAudioTransport,type ContinuousAudioTransportState} from '../../../apps/web/src/timeline-audio-continuous-engine.ts';
import {createNativeAudioPreviewAdmission,type NativeAudioContinuousAttempt} from '../../../apps/web/src/native-audio-preview-adapter.ts';
import type {NativeAudioPreviewBridge} from '../../../packages/contracts/src/native-audio-preview.ts';
import type {ContinuousAudioPlanInput} from '../../../packages/contracts/src/timeline-audio-continuous.ts';

interface Case {name:string;input:ContinuousAudioPlanInput;durationFrames:number;mode:'realtime'|'offline'|'performance';oraclePrefix:string;boundaries:number[]}
interface Fixture {config():Promise<Case>;report(value:unknown):Promise<void>;capture(value:unknown):Promise<void>}
const fixture=(globalThis as unknown as {__continuousFixture:Fixture}).__continuousFixture;
const bridge=(globalThis as unknown as {__mioonNativeAudioPreview:NativeAudioPreviewBridge}).__mioonNativeAudioPreview;
const assert=(value:unknown,label:string):asserts value=>{if(!value)throw Error(label);};
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const percentile=(values:number[],p:number):number=>{const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.min(sorted.length-1,Math.ceil(p*sorted.length)-1)]!;};
const client=createContinuousAudioPreviewClient({readPlan:async(input,{signal})=>{
  const response=await fetch('/api/rpc',{method:'POST',credentials:'same-origin',signal,headers:{'content-type':'application/json'},body:JSON.stringify({operation:'timeline.audioPreview.continuousPlan',input})});
  const reply=await response.json();assert(response.ok&&reply.ok,'Production metadata RPC failed');return reply.data;
}});
async function prepare(item:Case,context:AudioContext|OfflineAudioContext){
  const abort=new AbortController();let resource=Promise.resolve();
  const native=createNativeAudioPreviewAdmission(bridge).beginContinuous({onRevoke:()=>abort.abort(),onWaiting:()=>{}});
  const started=performance.now();
  const session=await client.prepare(item.input,{context,signal:abort.signal,reserveNative:(plan,sessionId,signal)=>native.acquireContinuous(plan,sessionId,signal),onResourceSettlement:value=>{resource=value;}});
  return {session,native,abort,resource,preparationMs:performance.now()-started};
}
async function retire(owned:{session:ContinuousAudioClientSession;native:NativeAudioContinuousAttempt;resource:Promise<void>},close:Promise<void>):Promise<void>{
  const resources=Promise.all([owned.session.dispose(),owned.resource,close]).then(()=>{});owned.native.retire(resources);await resources;
}
interface Difference {samples:number;maximumAbsoluteError:number;sumSquared:number;nonzeroExpected:number;nonzeroActual:number;maximumErrorAtSample:number;maximumErrorChannel:number;maximumErrorActual:number;maximumErrorExpected:number;mismatchedSamples:number;firstMismatch:number|null}
const fresh=():Difference=>({samples:0,maximumAbsoluteError:0,sumSquared:0,nonzeroExpected:0,nonzeroActual:0,maximumErrorAtSample:0,maximumErrorChannel:0,maximumErrorActual:0,maximumErrorExpected:0,mismatchedSamples:0,firstMismatch:null});
function compare(actual:[Float32Array,Float32Array],expected:DataView,accumulated:Difference,actualOffset=0):void{
  const frames=expected.byteLength/8,baseSample=accumulated.samples/2;
  assert(frames===Math.floor(frames)&&actual[0].length>=frames+actualOffset,'Exact comparison sample count');
  for(let at=0;at<frames;at++)for(let channel=0;channel<2;channel++){
    const a=actual[channel]![at+actualOffset]!,b=expected.getFloat32(at*8+channel*4,true);assert(Number.isFinite(a)&&Number.isFinite(b),'Every sample must be finite');
    const difference=Math.abs(a-b);
    if(difference>accumulated.maximumAbsoluteError){accumulated.maximumAbsoluteError=difference;accumulated.maximumErrorAtSample=baseSample+at;accumulated.maximumErrorChannel=channel;accumulated.maximumErrorActual=a;accumulated.maximumErrorExpected=b;}
    if(difference>2e-6){accumulated.mismatchedSamples++;accumulated.firstMismatch??=baseSample+at;}
    accumulated.sumSquared+=difference*difference;
    accumulated.samples++;if(a!==0)accumulated.nonzeroActual++;if(b!==0)accumulated.nonzeroExpected++;
  }
}
const result=(difference:Difference)=>({...difference,rootMeanSquareError:Math.sqrt(difference.sumSquared/difference.samples)});
async function oracle(item:Case,startFrame:number):Promise<DataView>{
  const response=await fetch(`${item.oraclePrefix}/${String(startFrame).padStart(5,'0')}.f32`);assert(response.ok,'Missing independent FFmpeg block');return new DataView(await response.arrayBuffer());
}
async function offline(item:Case){
  const context=new OfflineAudioContext(2,128,48000),owned=await prepare(item,context),difference=fresh(),boundaries=[];
  let block=owned.session.takeInitialBlock(),blocks=0,peakClientPayloadBytes=0;
  try{
    for(let frame=item.input.startFrame;frame<item.durationFrames;){
      assert(block.startFrame===frame,'No skipped or duplicated block');const reference=await oracle(item,frame);
      compare([block.buffer.getChannelData(0),block.buffer.getChannelData(1)],reference,difference);
      peakClientPayloadBytes=Math.max(peakClientPayloadBytes,block.buffer.length*8*2);blocks++;boundaries.push({startFrame:frame,endFrame:block.endFrame,sampleFrames:block.buffer.length});
      frame=block.endFrame;if(frame<item.durationFrames)block=await owned.session.loadBlock(frame,owned.abort.signal);
    }
    assert(difference.maximumAbsoluteError<=2e-6,`Independent reference max error ${difference.maximumAbsoluteError}`);
    return {name:item.name,status:'passed',mode:'production-client-streamed-block-comparison',sampleFrames:difference.samples/2,blocks,boundaries,...result(difference),absoluteTolerance:2e-6,
      firstPreparedBlockMs:owned.preparationMs,peakClientPayloadAndAcquisitionBytes:peakClientPayloadBytes,productionAdmissionBytes:96*1024*1024,
      note:'The complete long timeline is compared block by block; neither production client nor test retains whole-timeline PCM.'};
  }finally{await retire(owned,Promise.resolve());}
}
interface Capture {kind:'capture';frames:number;startFrame:number;firstSignal:number|null;overflow:boolean;left:Float32Array;right:Float32Array}
async function realtime(item:Case){
  const context=new AudioContext({sampleRate:48000});
  const schedules:Array<{when:number;offset:number;duration:number|undefined;contextSample:number}>=[];
  const createSource=context.createBufferSource.bind(context);
  // Observe the exact production call without changing its arguments or
  // clock. A theoretical zero first sample can contain a tiny interpolation
  // residual at a binary-fractional start time; content is not a clock anchor.
  context.createBufferSource=()=>{
    const source=createSource(),start=source.start.bind(source);
    source.start=(when=0,offset=0,duration?:number)=>{
      schedules.push({when,offset,duration,contextSample:Math.round(when*48000)});
      if(duration===undefined)start(when,offset);else start(when,offset,duration);
    };return source;
  };
  await context.audioWorklet.addModule('/capture-worklet.js');
  const captureCapacity=(item.durationFrames/30+3)*48000;
  const recorder=new AudioWorkletNode(context,'continuous-synthetic-capture',{channelCount:2,channelCountMode:'explicit',channelInterpretation:'discrete',numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[2],processorOptions:{frames:captureCapacity}});
  recorder.connect(context.destination);
  let firstSignalWall:number|null=null,playingWall:number|null=null,playingAudio:number|null=null,endedWall=0,endedAudio=0,state:ContinuousAudioTransportState|null=null;
  const changes:Array<{status:string;frame:number;time:number}>=[],loads:Array<Record<string,number|string>>=[];
  let captureResolve!:(capture:Capture)=>void;const captured=new Promise<Capture>(resolve=>{captureResolve=resolve;});
  const preparationStarted=performance.now();
  recorder.port.onmessage=event=>{if(event.data.kind==='first-signal')firstSignalWall=performance.now();else if(event.data.kind==='capture')captureResolve(event.data as Capture);};
  const owned=await prepare(item,context),ended=Promise.withResolvers<void>();
  const transport=createContinuousTimelineAudioTransport({context,plan:owned.session.plan,initialBlock:owned.session.takeInitialBlock(),loadBlock:async(frame,signal)=>{
    loads.push({stage:'start',frame,time:context.currentTime});try{const block=await owned.session.loadBlock(frame,signal);loads.push({stage:'loaded',frame,time:context.currentTime});return block;}catch(error){loads.push({stage:'failed',frame,time:context.currentTime,error:String(error)});throw error;}
  },onReset:owned.session.reset,destination:recorder,onChange:next=>{
    if(!state||state.status!==next.status||Math.floor(state.frame/60)!==Math.floor(next.frame/60))changes.push({status:next.status,frame:next.frame,time:context.currentTime});
    state=next;if(next.status==='playing'&&playingWall===null){playingWall=performance.now();playingAudio=context.currentTime;}
    if(next.status==='ended'){endedWall=performance.now();endedAudio=context.currentTime;ended.resolve();}
    if(next.status==='stopped')ended.reject(Error(`Transport stopped: ${next.reason}/${next.errorCode}`));
  }});
  try{
    assert(await transport.play(),'Actual AudioContext start failed');
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{await Promise.race([ended.promise,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(Error(`Real-time playback deadline: ${JSON.stringify({state:transport.getState(),contextTime:context.currentTime,changes,loads})}`)),45000);})]);}finally{clearTimeout(timer);}
    await sleep(80);recorder.port.postMessage('capture');
    const capture=await captured;assert(!capture.overflow&&capture.firstSignal!==null,'Bounded actual worklet capture completed');
    const totalSamples=item.durationFrames*1600,difference=fresh(),boundaries=[];
    const firstReference=await oracle(item,0),firstSchedule=schedules[0];assert(firstSchedule!==undefined,'Actual production source scheduling was observed');
    assert(Math.abs(firstSchedule.when*48000-firstSchedule.contextSample)<1e-6,'Production schedule has an integral sample origin');
    const capturedOffset=firstSchedule.contextSample-capture.startFrame;assert(capturedOffset>=0&&capturedOffset+totalSamples<=capture.frames,'Complete exact output range was captured');
    for(let frame=0;frame<item.durationFrames;frame+=60){const reference=frame===0?firstReference:await oracle(item,frame);compare([capture.left,capture.right],reference,difference,capturedOffset+frame*1600);boundaries.push({frame,sample:frame*1600,captureSample:capturedOffset+frame*1600});}
    if(difference.maximumAbsoluteError>2e-6){
      await fixture.capture({...capture,capturedOffset,totalSamples,schedules});
      throw Error(`Realtime output comparison failed: ${JSON.stringify({difference:result(difference),state:transport.getState(),capturedOffset,changes,loads,schedules})}`);
    }
    assert(state!==null,'Ended state available');const final=transport.getState();assert(final.status==='ended'&&final.sample===totalSamples,'Clock reached exact saved end');assert(final.underruns===0,'Continuous reference fixture cannot underrun');
    return {name:item.name,status:'passed',mode:'actual-Electron-AudioContext-worklet-pre-destination',sampleFrames:totalSamples,captureFrames:capture.frames,captureStartFrame:capture.startFrame,capturedOffset,boundaries,schedules,alignment:'Observed production AudioBufferSource.start absolute sample origin; no content-derived offset or tolerance-based search.',
      ...result(difference),absoluteTolerance:2e-6,underruns:final.underruns,peakHeldBytes:final.peakHeldBytes,heldBytesAtEnd:final.heldBytes,
      firstPreparedBlockMs:owned.preparationMs,firstSignalMs:firstSignalWall===null?null:firstSignalWall-preparationStarted,
      realtimeWallSeconds:(endedWall-(playingWall??endedWall))/1000,audioClockSeconds:endedAudio-(playingAudio??endedAudio),
      endCallbackDriftSeconds:endedAudio-(playingAudio??endedAudio)-item.durationFrames/30-.02,
      wallMinusAudioSeconds:(endedWall-(playingWall??endedWall))/1000-(endedAudio-(playingAudio??endedAudio)),
      baseLatencySeconds:context.baseLatency,outputLatencySeconds:context.outputLatency,
      captureReservedBytes:captureCapacity*8,productionAdmissionBytes:96*1024*1024,
      note:'Additional test capture is bounded separately. AudioWorklet emits silence downstream; no physical-output or listening claim.'};
  }finally{await retire(owned,transport.dispose());recorder.disconnect();recorder.port.close();}
}
async function performanceChecks(item:Case){
  const prepareTimes:number[]=[],bufferedSeek:number[]=[],unbufferedSeek:number[]=[];
  for(let round=0;round<5;round++){
    const context=new AudioContext({sampleRate:48000}),owned=await prepare(item,context);
    const transport=createContinuousTimelineAudioTransport({context,plan:owned.session.plan,initialBlock:owned.session.takeInitialBlock(),loadBlock:owned.session.loadBlock,onReset:owned.session.reset});
    try{
      prepareTimes.push(owned.preparationMs);let start=performance.now();assert(await transport.seek(1),'Buffered paused seek failed');bufferedSeek.push(performance.now()-start);
      start=performance.now();assert(await transport.seek(650),'Unbuffered paused seek failed');unbufferedSeek.push(performance.now()-start);
      // Every call exercises the production generation fences and exact local
      // graph retirement. Paused checks avoid any physical output claim.
      for(let index=0;index<10;index++){assert(await transport.play(),'Repeated play');transport.pause();}
    }finally{await retire(owned,transport.dispose());}
  }
  const summarize=(samples:number[])=>({samples,p50:percentile(samples,.5),p95:percentile(samples,.95)});
  return {name:item.name,status:'passed',mode:'actual-Electron-native-client-controls',coldFirstPreparedBlockMs:prepareTimes[0],warmFirstPreparedBlockMs:summarize(prepareTimes.slice(1)),bufferedPausedSeekMs:summarize(bufferedSeek),unbufferedPausedSeekMs:summarize(unbufferedSeek),playPauseRounds:50,
    note:'Preparation/paused-seek latency measures application readiness; it excludes output-device latency and is not a guaranteed first-audible-device target.'};
}
(async()=>{
  let report:unknown;
  try{const item=await fixture.config();report=await(item.mode==='realtime'?realtime(item):item.mode==='offline'?offline(item):performanceChecks(item));}
  catch(error){report={status:'failed',error:String(error instanceof Error?error.stack:error)};}
  document.body.textContent=JSON.stringify(report,null,2);await fixture.report(report);
})();
