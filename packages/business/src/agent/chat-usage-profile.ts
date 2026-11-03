import type {AgentConfiguration} from './config.ts';

/** Optional provider controls need both a documented preset and its official
 * endpoint. Compatible proxies do not inherit a preset's usage capability. */
export function chatUsageRequest(configuration:AgentConfiguration):boolean {
  if(configuration.protocol!=='chat_completions')return false;
  const url=new URL(configuration.baseUrl),path=url.pathname.replace(/\/+$/u,'');
  if(configuration.presetId==='openai')return url.origin==='https://api.openai.com'&&path==='/v1';
  if(configuration.presetId==='deepseek')return url.origin==='https://api.deepseek.com'&&['','/v1'].includes(path);
  if(configuration.presetId==='qwen')return ['https://dashscope.aliyuncs.com','https://dashscope-intl.aliyuncs.com'].includes(url.origin)&&path==='/compatible-mode/v1';
  // MiniMax's M3 request parameter table explicitly documents include_usage.
  // Keep platform bindings exact; other models/endpoints are not inferred.
  return configuration.presetId==='minimax'&&configuration.model==='MiniMax-M3'&&path==='/v1'&&
    ((configuration.platformId==='china'&&url.origin==='https://api.minimax.cn')||
      (configuration.platformId==='international'&&url.origin==='https://api.minimax.io'));
}
