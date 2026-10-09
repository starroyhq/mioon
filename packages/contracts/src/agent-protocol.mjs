// Browser-safe protocol vocabulary. This module never performs I/O, selects a
// provider, or infers a protocol from a model, URL, or failed request.
export const AGENT_PROTOCOLS = Object.freeze({
  chat_completions: Object.freeze({label: 'Chat Completions', path: '/chat/completions'}),
  responses: Object.freeze({label: 'Responses', path: '/responses'}),
});

/** Derive a fixed request endpoint from already-canonical configuration. This is
 * not destination authorization: backend configuration and network policy must
 * still validate the provider, local scope, DNS answers and connection peer. */
export function deriveAgentEndpoint(configuration) {
  const protocol = configuration?.protocol, baseUrl = configuration?.baseUrl;
  if (typeof protocol !== 'string' || !Object.hasOwn(AGENT_PROTOCOLS, protocol) ||
      typeof baseUrl !== 'string' || !baseUrl || baseUrl.length > 2048 ||
      /[\s\\%?#@\u0000-\u001f\u007f-\u009f]/u.test(baseUrl)) throw new TypeError('Invalid Agent endpoint configuration');
  let url;
  try { url = new URL(baseUrl); } catch { throw new TypeError('Invalid Agent endpoint configuration'); }
  const pathname = url.pathname.replace(/\/+$/, '');
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      (pathname && (!/^\/[A-Za-z0-9/_~.\-]*$/.test(pathname) || /\/{2}|(?:^|\/)\.{1,2}(?:\/|$)/.test(pathname))) ||
      `${url.origin}${pathname}` !== baseUrl) throw new TypeError('Invalid Agent endpoint configuration');
  return `${baseUrl}${AGENT_PROTOCOLS[protocol].path}`;
}
