/**
 * Stateless Streamable HTTP MCP relay for Cloudflare Workers.
 * Transport PoC only. No OAuth handoff, persistence, or audited authorization.
 */
const MAX_REQUEST_BYTES = 262_144;
const ALLOWED_METHODS = new Set([
  'initialize', 'notifications/initialized', 'notifications/cancelled',
  'ping', 'tools/list', 'tools/call',
]);
const REQUEST_HEADERS = [
  'accept', 'content-type', 'mcp-protocol-version',
  'mcp-session-id', 'last-event-id',
];
const RESPONSE_HEADERS = [
  'content-type', 'mcp-session-id', 'mcp-protocol-version',
  'retry-after', 'cache-control',
];

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'},
  });
}

async function equalSecret(received, expected) {
  if (typeof expected !== 'string' || expected.length < 32) return false;
  if (typeof received !== 'string' || received.length !== expected.length) return false;
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(received)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function rpcError(payload, message) {
  return json({jsonrpc:'2.0', id: payload?.id ?? null,
    error: {code: -32001, message}}, 403);
}

function upstreamCredentialValid(value) {
  return typeof value === 'string' && /^(Bearer|Basic) [^\r\n]{10,}$/.test(value);
}

/**
 * @param {{name: string, upstreamUrl: string, allowedTools: string[]}} config
 * The upstreamUrl must be hard-coded HTTPS, never selected from user input.
 */
export function createMcpRelay(config) {
  const upstream = new URL(config.upstreamUrl);
  if (upstream.protocol !== 'https:' || upstream.username || upstream.password || upstream.hash) {
    throw new Error('upstreamUrl must be a fixed HTTPS URL');
  }
  const tools = new Set(config.allowedTools);
  const serviceName = config.name;

  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      if (url.pathname === '/health' && request.method === 'GET') {
        return json({service: serviceName, phase: 'transport-only', status: 'alive',
          upstreamConnection: 'not_verified'});
      }
      if (url.pathname !== '/mcp') return json({error:'not_found'}, 404);
      if (!['GET','POST','DELETE'].includes(request.method)) return json({error:'method_not_allowed'},405);

      const supplied = request.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1];
      if (!(await equalSecret(supplied, env.PORTAL_BEARER_TOKEN))) {
        return json({error:'unauthorized'}, 401);
      }
      if (!upstreamCredentialValid(env.UPSTREAM_AUTHORIZATION)) {
        return json({error:'upstream_not_configured'}, 503);
      }

      let requestBody;
      if (request.method === 'POST') {
        if (!request.headers.get('content-type')?.toLowerCase().includes('application/json')) {
          return json({error:'unsupported_media_type'},415);
        }
        const declaredLength = Number(request.headers.get('content-length'));
        if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
          return json({error:'payload_too_large'},413);
        }
        // Limit payload bytes independent of Content-Length.
        const chunks = [];
        let total = 0;
        const reader = request.body?.getReader();
        if (!reader) return json({error:'invalid_json'},400);
        try {
          while (true) {
            const {done,value} = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > MAX_REQUEST_BYTES) {
              await reader.cancel();
              return json({error:'payload_too_large'},413);
            }
            chunks.push(value);
          }
        } catch {
          return json({error:'invalid_json'},400);
        }
        const bytes = new Uint8Array(total);
        let position = 0;
        for (const chunk of chunks) {bytes.set(chunk,position);position += chunk.byteLength;}
        let payload;
        try { payload = JSON.parse(new TextDecoder().decode(bytes)); }
        catch { return json({error:'invalid_json'},400); }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
            payload.jsonrpc !== '2.0' || !ALLOWED_METHODS.has(payload.method)) {
          return rpcError(payload,'MCP method is not allowed');
        }
        if (payload.method === 'tools/call' && !tools.has(payload.params?.name)) {
          return rpcError(payload,'MCP tool is not on the allowlist');
        }
        requestBody = bytes;
      }

      const headers = new Headers();
      for (const key of REQUEST_HEADERS) {
        const value = request.headers.get(key);
        if (value !== null) headers.set(key,value);
      }
      headers.set('authorization',env.UPSTREAM_AUTHORIZATION);
      if (!headers.has('accept')) headers.set('accept','application/json, text/event-stream');
      try {
        // Fixed URL; never forward caller-provided query strings or redirects.
        const response = await fetch(upstream.toString(), {
          method: request.method, headers,
          ...(request.method === 'POST' ? {body: requestBody} : {}),
          redirect:'manual',
        });
        if (response.status === 401 || response.status === 403) {
          await response.body?.cancel();
          return json({error:'upstream_authorization_failed'},502);
        }
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel();
          return json({error:'unexpected_upstream_redirect'},502);
        }
        const responseHeaders = new Headers();
        for (const key of RESPONSE_HEADERS) {
          const value = response.headers.get(key);
          if (value !== null) responseHeaders.set(key,value);
        }
        responseHeaders.set('cache-control','no-store');
        return new Response(response.body,{status:response.status,headers:responseHeaders});
      } catch {
        return json({error:'upstream_unavailable'},502);
      }
    },
  };
}
