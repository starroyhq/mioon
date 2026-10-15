import {createComfyAdmission,COMFY_MODULE_UNAVAILABLE_MESSAGE} from '../../../packages/business/src/comfy/admission.ts';
import {COMFY_SETTINGS_LIMITS, comfyImageCheckRequestSchema, comfyImageCheckResultSchema} from '@mioon/contracts';
import {sanitizeComfySettingsResult, sanitizeComfySettingsError} from '@mioon/business/comfy/settings';
import {comfyError} from '@mioon/business/comfy/profile';

const json = (res, status, value) => {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
  res.end(JSON.stringify(value));
};
const invalid = (status = 400) => Object.assign(new Error('Local ComfyUI request is invalid or too large.'), {code: 'COMFY_HTTP_VALIDATION', status});
function assertActive(signal) { if (signal?.aborted) throw comfyError('COMFY_ABORTED'); }
async function readBody(req, res, signal) {
  assertActive(signal);
  if (!/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?\s*$/i.test(req.headers['content-type'] || '') || (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity')) throw invalid();
  const length = req.headers['content-length'];
  if (length !== undefined && (typeof length !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(length) || !Number.isSafeInteger(Number(length)))) throw invalid();
  const tooLarge = () => { res.setHeader('Connection', 'close'); req.resume(); return invalid(413); };
  if (Number(length) > COMFY_SETTINGS_LIMITS.updateBytes) throw tooLarge();
  const chunks = []; let size = 0;
  for await (const chunk of req.iterator({destroyOnReturn: false})) {
    assertActive(signal);
    size += chunk.length;
    if (size > COMFY_SETTINGS_LIMITS.updateBytes) throw tooLarge();
    chunks.push(chunk);
  }
  assertActive(signal);
  if (length !== undefined && size !== Number(length)) throw invalid();
  try {
    const value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks)));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error();
    return value;
  } catch { throw invalid(); }
}
async function observeCheck(req, res, shutdownSignal, run) {
  const observer = new AbortController();
  const abort = () => observer.abort();
  const disconnected = () => { if (!res.writableFinished) abort(); };
  req.once('aborted', abort); res.once('close', disconnected);
  shutdownSignal?.addEventListener('abort', abort, {once: true});
  try {
    if (req.aborted || res.destroyed || shutdownSignal?.aborted) abort();
    return await run(observer.signal);
  } finally {
    req.removeListener('aborted', abort); res.removeListener('close', disconnected);
    shutdownSignal?.removeEventListener('abort', abort);
  }
}
function safeError(error) {
  if(error?.code==='COMFY_MODULE_UNAVAILABLE')return {code:error.code,message:COMFY_MODULE_UNAVAILABLE_MESSAGE,status:503};
  if (error?.code === 'COMFY_HTTP_VALIDATION') return {code: error.code, message: 'Local ComfyUI request is invalid or too large.', status: error.status === 413 ? 413 : 400};
  if (typeof error?.code === 'string' && error.code.startsWith('COMFY_SETTINGS_')) return sanitizeComfySettingsError(error);
  const safe = comfyError(error?.code);
  const status = ['COMFY_INVALID_REQUEST', 'COMFY_NETWORK_DENIED'].includes(safe.code) ? 400 : safe.code === 'COMFY_ABORTED' ? 499 : safe.code === 'COMFY_TIMEOUT' ? 504 : 502;
  return {code: safe.code, message: safe.message, status};
}

/** Invoke only AFTER the server's existing Host/Origin/session gates, and BEFORE
 * the broader Images route family. No configuration read/save performs I/O.
 * Explicit connection checks are advisory reads and may be aborted on disconnect;
 * settings writes retain their normal durable ownership after client disconnect. */
export function createComfyHttp({settings, connector, availability, signal} = {}) {
  const admission=createComfyAdmission(connector,availability);
  return async (req, res, url) => {
    const settingsRoute = url.pathname === '/api/images/comfy-settings', checkRoute = url.pathname === '/api/images/comfy-check', availabilityRoute = url.pathname === '/api/images/comfy-availability';
    if (!settingsRoute && !checkRoute && !availabilityRoute) return false;
    try {
      assertActive(signal);
      if (typeof req.url !== 'string' || Buffer.byteLength(req.url) > 2048 || req.url !== url.pathname || url.search || url.hash) throw invalid();
      const methods = availabilityRoute ? ['GET'] : settingsRoute ? ['GET', 'PUT'] : ['POST'];
      if (!methods.includes(req.method)) {
        res.setHeader('Allow', methods.join(', '));
        json(res, 405, {ok: false, error: {code: 'METHOD_NOT_ALLOWED', message: 'Local ComfyUI request method is not allowed.', details: {}, retryable: false}});
        return true;
      }
      let result;
      if(availabilityRoute) result=admission.availability;
      else if (settingsRoute) {
        if (req.method === 'GET') result = sanitizeComfySettingsResult(await settings.get());
        else {
          const input = await readBody(req, res, signal);
          assertActive(signal);
          result = sanitizeComfySettingsResult(await settings.put(input));
        }
      } else {
        result = await observeCheck(req, res, signal, async checkSignal => {
          const parsed = comfyImageCheckRequestSchema.safeParse(await readBody(req, res, checkSignal));
          if (!parsed.success) throw invalid();
          assertActive(checkSignal);
          admission.assertAvailable();
          const token = settings.clearCheck(parsed.data.baseUrl);
          const checked = await connector.check({config: parsed.data, signal: checkSignal});
          assertActive(checkSignal);
          const safe = comfyImageCheckResultSchema.safeParse(checked);
          if (!safe.success || safe.data.baseUrl !== parsed.data.baseUrl) throw comfyError('COMFY_RESPONSE_INVALID');
          settings.recordCheck(safe.data, token);
          return safe.data;
        });
      }
      json(res, 200, {ok: true, data: result});
    } catch (error) {
      const safe = safeError(error);
      json(res, safe.status, {ok: false, error: {code: safe.code, message: safe.message, details: {}, retryable: false}});
    }
    return true;
  };
}
