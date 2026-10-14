import type {IncomingMessage,ServerResponse} from 'node:http';
import {audioPreviewSourceInputSchema,AUDIO_PREVIEW_PROFILE} from '@mioon/contracts/timeline-audio-preview';
import type {AudioPreviewSourceInput} from '@mioon/contracts/timeline-audio-preview';
import type {TimelineAudioPreviewConsumeContext} from '@mioon/business/timeline-audio-preview';

export interface AudioPreviewHttpService {
  consumeSource(input:unknown,options:{signal?:AbortSignal;consume:(decoded:{readonly pcm:Buffer},context:TimelineAudioPreviewConsumeContext)=>Promise<void>}):Promise<unknown>;
}
const fail=(code:string,status=400):Error&{code:string;status:number}=>Object.assign(new Error('声音试听请求未完成，请核对当前项目和区间后重试。'),{code,status});
const send=(res:ServerResponse,status:number,code:string):void=>{
  if(res.destroyed||res.writableEnded)return;
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
  res.end(JSON.stringify({ok:false,error:{code,message:'声音试听请求未完成，请核对当前项目和区间后重试。',details:{},retryable:false}}));
};
function inputFromUrl(url:URL):AudioPreviewSourceInput {
  const allowed=['projectId','timelineId','expectedRevision','startFrame','clipId','sourceHash','planHash'];
  const keys=[...url.searchParams.keys()];
  if(keys.length!==allowed.length||new Set(keys).size!==keys.length||keys.some(key=>!allowed.includes(key)))throw fail('AUDIO_PREVIEW_INVALID_INPUT');
  const raw=Object.fromEntries(url.searchParams);
  for(const name of ['expectedRevision','startFrame'])if(!/^(?:0|[1-9][0-9]*)$/u.test(raw[name]??''))throw fail('AUDIO_PREVIEW_INVALID_INPUT');
  const parsed=audioPreviewSourceInputSchema.safeParse({...raw,expectedRevision:Number(raw.expectedRevision),startFrame:Number(raw.startFrame)});
  if(!parsed.success)throw fail('AUDIO_PREVIEW_INVALID_INPUT');
  return parsed.data;
}

/** Fixed authenticated same-origin resource, called only after the existing
 * Host/Origin/session checks. The service owns source selection, admission,
 * hashes and process cleanup; the HTTP consumer owns only this response. */
export function createTimelineAudioPreviewHttp({service,signal,assertAvailable}:{service:AudioPreviewHttpService;signal?:AbortSignal;assertAvailable:()=>void}){
  return async(req:IncomingMessage,res:ServerResponse,url:URL):Promise<boolean>=>{
    if(!/^\/api\/timeline-audio-preview(?:\/|$)/u.test(url.pathname))return false;
    const controller=new AbortController();
    const abort=():void=>{controller.abort();};
    const closed=():void=>{if(!res.writableFinished)abort();};
    const combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
    req.once('aborted',abort);res.once('close',closed);
    try{
      // Restored profiles reject before query inspection or media access.
      assertAvailable();
      if(url.pathname!=='/api/timeline-audio-preview/pcm')throw fail('NOT_FOUND',404);
      if(req.method!=='GET'){res.setHeader('Allow','GET');throw fail('METHOD_NOT_ALLOWED',405);}
      if(Buffer.byteLength(req.url??'')>2048||req.headers['transfer-encoding']||
          req.headers['content-length']!==undefined&&req.headers['content-length']!=='0')throw fail('AUDIO_PREVIEW_INVALID_INPUT');
      const input=inputFromUrl(url);
      await service.consumeSource(input,{signal:combined,consume:async({pcm},{plan,source,signal:attemptSignal,beforeEffect})=>{
        beforeEffect();
        if(attemptSignal.aborted||res.destroyed||res.writableEnded)throw fail('AUDIO_PREVIEW_ABORTED',409);
        if(plan.profileId!==AUDIO_PREVIEW_PROFILE||plan.planHash!==input.planHash||source.clipId!==input.clipId||
            source.sourceHash!==input.sourceHash||!Buffer.isBuffer(pcm)||pcm.byteLength!==source.pcmBytes)throw fail('AUDIO_PREVIEW_INVALID_PCM',409);
        // Buffer ownership is retained until finish/close. No concat, base64,
        // file cache or unbounded producer is introduced by this adapter.
        await new Promise<void>((resolve,reject)=>{
          let settled=false, transportFailure:Error|undefined;
          const finish=(error?:Error):void=>{
            if(settled)return;settled=true;
            res.off('finish',complete);res.off('close',lost);res.off('error',failed);attemptSignal.removeEventListener('abort',cancel);
            if(error)reject(error);else resolve();
          };
          const complete=():void=>finish(transportFailure);
          const lost=():void=>finish(transportFailure??fail('AUDIO_PREVIEW_ABORTED',409));
          const failed=():void=>{transportFailure=fail('AUDIO_PREVIEW_ABORTED',409);res.destroy();};
          const cancel=():void=>{transportFailure=fail('AUDIO_PREVIEW_ABORTED',409);res.destroy();};
          res.once('finish',complete);res.once('close',lost);res.once('error',failed);attemptSignal.addEventListener('abort',cancel,{once:true});
          if(attemptSignal.aborted){cancel();return;}
          try{beforeEffect();
          res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':String(pcm.byteLength),'Cache-Control':'no-store',
            'X-Mioon-Audio-Profile':plan.profileId,'X-Mioon-Audio-Plan-Hash':plan.planHash,
            'X-Mioon-Audio-Source-Hash':source.sourceHash,'X-Mioon-Audio-Clip-Id':source.clipId,
            'X-Mioon-Audio-Sample-Frames':String(source.sampleFrames)});
          res.end(pcm);
          }catch{transportFailure=fail('AUDIO_PREVIEW_ABORTED',409);res.destroy();}
        });
        beforeEffect();
      }});
    }catch(error){
      if(res.headersSent)res.destroy();
      else{
        const value=error as {code?:unknown;status?:unknown};
        const code=typeof value?.code==='string'&&/^(?:AUDIO_PREVIEW_[A-Z_]+|RESTORE_OPERATION_UNAVAILABLE|NOT_FOUND|METHOD_NOT_ALLOWED)$/u.test(value.code)?value.code:'AUDIO_PREVIEW_UNAVAILABLE';
        const status=typeof value?.status==='number'&&[400,403,404,405,409,413,429,503].includes(value.status)?value.status:409;
        send(res,status,code);
      }
    }finally{req.off('aborted',abort);res.off('close',closed);}
    return true;
  };
}
