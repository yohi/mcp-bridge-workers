/**
 * Stateless MCP relay for Cloudflare Workers. Supports direct upstream or
 * authenticated local relay over an Access-protected Cloudflare Tunnel.
 * No OAuth tokens are copied into Workers; local mcp-remote owns its cache.
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

// Legacy HTTP relay uses Access-protected public Tunnel; VPC relay uses
// the fixed private Service Binding. Selection comes only from Worker vars.
// A failed VPC request MUST NOT silently fall back to the public hostname.
function getRoute(env,fixedUpstream) {
  const mode=env.ATLASSIAN_UPSTREAM_MODE ?? 'direct';
  if(mode==='direct') {
    if(!upstreamCredentialValid(env.UPSTREAM_AUTHORIZATION)) return null;
    return {url:fixedUpstream,authorization:env.UPSTREAM_AUTHORIZATION,access:null};
  }
  if(mode!=='local_relay' && mode!=='local_relay_vpc')return null;
  if(typeof env.LOCAL_RELAY_BEARER_TOKEN!=='string' ||
     env.LOCAL_RELAY_BEARER_TOKEN.length<32) return null;
  if(mode==='local_relay_vpc') {
    if(!env.ATLASSIAN_RELAY_VPC ||
        typeof env.ATLASSIAN_RELAY_VPC.fetch!=='function') return null;
    return {url:new URL('http://127.0.0.1/mcp'),
      authorization:'Bearer '+env.LOCAL_RELAY_BEARER_TOKEN,
      access:null, transport:'vpc'};
  }
  if(typeof env.CF_ACCESS_CLIENT_ID!=='string' ||
     !env.CF_ACCESS_CLIENT_ID ||
     typeof env.CF_ACCESS_CLIENT_SECRET!=='string' ||
     env.CF_ACCESS_CLIENT_SECRET.length<32) return null;
  let url;
  try {
    url=new URL(env.LOCAL_RELAY_ORIGIN);
    if(url.protocol!=='https:'||!url.hostname.includes('.')||
       /^\d+(?:\.\d+){3}$/.test(url.hostname)||url.hostname==='localhost'||
       url.username||url.password||url.search||url.hash||
       url.pathname!=='/'||url.port) return null;
  }catch{return null;}
  return {url:new URL('/mcp',url),authorization:'Bearer '+env.LOCAL_RELAY_BEARER_TOKEN,
    access:{id:env.CF_ACCESS_CLIENT_ID,secret:env.CF_ACCESS_CLIENT_SECRET}};
}


const MAX_DENIAL_INSPECTION_BYTES = 65_536;

/**
 * TEMPORARY, opt-in 401/403 classification for an Access-protected upstream.
 * The body is inspected in memory up to a fixed limit, never logged, returned,
 * or persisted. No credential, hostname, incoming JSON-RPC value or arbitrary
 * response header value is included in the diagnostic event.
 */
async function diagnoseUpstreamDenial(response) {
  const type = response.headers.get('content-type') ?? '';
  const diagnostic = {
    event:'upstream_authorization_denied',
    status:response.status,
    media_type:/^text\/html(?:\s*;|$)/i.test(type) ? 'html' :
      /^(application\/json|[^;]+\+json)(?:\s*;|$)/i.test(type) ? 'json' : 'other',
    cf_mitigated_challenge:response.headers.get('cf-mitigated') === 'challenge',
    cf_ray_present:response.headers.has('cf-ray'),
    access_marker:false,
    challenge_marker:false,
    error_1020:false,
    error_1042:false,
    inspected_bytes:0,
    inspection_limit_reached:false,
    read_failed:false,
  };
  const reader = response.body?.getReader();
  if (reader) {
    const chunks = [];
    let length = 0;
    try {
      while (length < MAX_DENIAL_INSPECTION_BYTES) {
        const {done,value} = await reader.read();
        if (done) break;
        const take = Math.min(value.byteLength,MAX_DENIAL_INSPECTION_BYTES-length);
        if (take) chunks.push(value.slice(0,take));
        length += take;
        if (take < value.byteLength || length === MAX_DENIAL_INSPECTION_BYTES) {
          diagnostic.inspection_limit_reached = true;
          break;
        }
      }
      const bytes = new Uint8Array(length);
      let pos = 0;
      for (const chunk of chunks) {bytes.set(chunk,pos);pos += chunk.length;}
      const text = new TextDecoder().decode(bytes).toLowerCase();
      diagnostic.inspected_bytes = length;
      diagnostic.access_marker = text.includes('cloudflare access') ||
        text.includes('/cdn-cgi/access/') || text.includes('cloudflareaccess.com');
      diagnostic.challenge_marker = text.includes('challenge-platform') ||
        text.includes('attention required') || text.includes('just a moment');
      diagnostic.error_1020 = /\berror\s*(?:code\s*:)?\s*1020\b/.test(text);
      diagnostic.error_1042 = /\berror\s*(?:code\s*:)?\s*1042\b/.test(text);
    } catch {
      diagnostic.read_failed = true;
    } finally {
      try {await reader.cancel();} catch { /* best effort only */ }
    }
  }
  console.warn('MCP_UPSTREAM_DENIAL ' + JSON.stringify(diagnostic));
}

const MAX_TOOL_LIST_RESPONSE_BYTES = 2_097_152;

/**
 * A tools/list response is a security boundary: never relay an unfiltered
 * upstream response, including SSE, malformed JSON and oversized bodies.
 * Keep pagination metadata intact; each tools/list page is filtered.
 */
async function filteredToolListResponse(response, allowedTools) {
  const type = response.headers.get('content-type') ?? '';
  if (response.status !== 200 || !/^application\/json(?:\s*;|$)/i.test(type)) {
    await response.body?.cancel();
    return json({error:'invalid_upstream_tool_list'},502);
  }
  const length = response.headers.get('content-length');
  if (length !== null && Number.isFinite(Number(length)) &&
      Number(length) > MAX_TOOL_LIST_RESPONSE_BYTES) {
    await response.body?.cancel();
    return json({error:'upstream_tool_list_too_large'},502);
  }
  const reader = response.body?.getReader();
  if (!reader) return json({error:'invalid_upstream_tool_list'},502);
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const {done,value} = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_TOOL_LIST_RESPONSE_BYTES) {
        await reader.cancel();
        return json({error:'upstream_tool_list_too_large'},502);
      }
      chunks.push(value);
    }
  } catch {
    return json({error:'invalid_upstream_tool_list'},502);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {bytes.set(chunk,offset);offset += chunk.byteLength;}
  let body;
  try {body = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
  catch {return json({error:'invalid_upstream_tool_list'},502);}
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      body.jsonrpc !== '2.0' ||
      !(typeof body.id === 'number' || typeof body.id === 'string') ||
      !body.result || typeof body.result !== 'object' ||
      Array.isArray(body.result) || !Array.isArray(body.result.tools)) {
    return json({error:'invalid_upstream_tool_list'},502);
  }
  const filtered = {
    ...body, result: {...body.result,
      tools: body.result.tools.filter(t =>
        t !== null && typeof t === 'object' &&
        typeof t.name === 'string' && allowedTools.has(t.name)),
    },
  };
  const headers = new Headers({
    'content-type':'application/json; charset=utf-8','cache-control':'no-store',
  });
  for (const name of ['mcp-session-id','mcp-protocol-version']) {
    const value = response.headers.get(name);
    if (value !== null) headers.set(name,value);
  }
  return new Response(JSON.stringify(filtered),{status:200,headers});
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
      // Independent private-route liveness probe. It never switches /mcp,
      // forwards credentials, or exposes the relay's response body.
      if (url.pathname !== '/mcp' && url.pathname !== '/health/vpc' &&
          url.pathname !== '/mcp/vpc') {
        return json({error:'not_found'},404);
      }
      if (!['GET','POST','DELETE'].includes(request.method)) {
        return json({error:'method_not_allowed'},405);
      }
      const supplied = request.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1];
      if (!(await equalSecret(supplied, env.PORTAL_BEARER_TOKEN))) {
        return json({error:'unauthorized'},401);
      }
      if (url.pathname === '/health/vpc') {
        if (request.method !== 'GET') return json({error:'method_not_allowed'},405);
        if (!env.ATLASSIAN_RELAY_VPC ||
            typeof env.ATLASSIAN_RELAY_VPC.fetch !== 'function') {
          return json({error:'vpc_binding_not_configured'},503);
        }
        try {
          // VPC Service fixes the destination to 127.0.0.1:18787; the URL
          // supplies the scheme, Host header, and /health path only.
          const response = await env.ATLASSIAN_RELAY_VPC.fetch(
            'http://127.0.0.1/health', {
              method:'GET',redirect:'manual',
              headers:{accept:'application/json'},
              signal:AbortSignal.timeout(8000),
            });
          try {await response.body?.cancel();} catch { /* no body forwarded */ }
          if (response.status !== 200) return json({error:'vpc_health_unavailable'},502);
          return json({service:serviceName,phase:'vpc-transport-only',
            status:'reachable',upstreamConnection:'not_verified'});
        } catch {
          return json({error:'vpc_health_unavailable'},502);
        }
      }
      const isVpcMcpProbe = url.pathname === '/mcp/vpc';
      if (isVpcMcpProbe && request.method !== 'POST') {
        return json({error:'method_not_allowed'},405);
      }
      // The probe is deliberately restricted to two side-effect-free MCP
      // operations. /mcp continues to use the legacy public Access route.
      const route = isVpcMcpProbe
        ? (env.ATLASSIAN_RELAY_VPC &&
           typeof env.ATLASSIAN_RELAY_VPC.fetch === 'function' &&
           typeof env.LOCAL_RELAY_BEARER_TOKEN === 'string' &&
           env.LOCAL_RELAY_BEARER_TOKEN.length >= 32
          ? {url:new URL('http://127.0.0.1/mcp'),
             authorization:'Bearer '+env.LOCAL_RELAY_BEARER_TOKEN,
             access:null}
          : null)
        : getRoute(env,upstream);
      if (!route) return json({error:'upstream_not_configured'},503);

      let requestBody;
      let isToolList = false;
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
        // MCP 2026-era clients probe server/discover before attempting the
        // legacy 2025 initialize handshake. This bridge only implements
        // legacy MCP: return a standard JSON-RPC Method not found response
        // (HTTP 200) so clients can negotiate the supported older era.
        // Never forward the probe to the OAuth-backed stdio relay, and never
        // treat it as permission to invoke any additional MCP methods.
        if (payload && typeof payload === 'object' && !Array.isArray(payload) &&
            payload.jsonrpc === '2.0' && !isVpcMcpProbe &&
            payload.method === 'server/discover' &&
            (typeof payload.id === 'string' || typeof payload.id === 'number')) {
          return json({jsonrpc:'2.0', id:payload.id,
            error:{code:-32601, message:'Method not found'}});
        }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
            payload.jsonrpc !== '2.0' || !ALLOWED_METHODS.has(payload.method)) {
          return rpcError(payload,'MCP method is not allowed');
        }
        if (isVpcMcpProbe) {
          const args = payload.params?.arguments;
          const emptyArgs = args && typeof args === 'object' &&
            !Array.isArray(args) && Object.keys(args).length === 0;
          const paramsKeys = payload.params &&
            typeof payload.params === 'object' && !Array.isArray(payload.params)
            ? Object.keys(payload.params) : [];
          const probePing = payload.method === 'ping' &&
            (payload.params === undefined ||
             (payload.params && typeof payload.params === 'object' &&
              !Array.isArray(payload.params) && paramsKeys.length === 0));
          const probeRead = payload.method === 'tools/call' &&
            payload.params?.name === 'getAccessibleAtlassianResources' &&
            emptyArgs && paramsKeys.length === 2 &&
            paramsKeys.includes('name') && paramsKeys.includes('arguments');
          if (!(typeof payload.id === 'number' || typeof payload.id === 'string') ||
              (!probePing && !probeRead)) {
            return rpcError(payload,'VPC diagnostic method is not allowed');
          }
        }
        if (payload.method === 'tools/call' && !tools.has(payload.params?.name)) {
          return rpcError(payload,'MCP tool is not on the allowlist');
        }
        isToolList = payload.method === 'tools/list';
        requestBody = bytes;
      }

      const headers = new Headers();
      for (const key of REQUEST_HEADERS) {
        const value = request.headers.get(key);
        if (value !== null) headers.set(key,value);
      }
      headers.set('authorization',route.authorization);
      if(route.access) {
        headers.set('cf-access-client-id',route.access.id);
        headers.set('cf-access-client-secret',route.access.secret);
      }
      if (!headers.has('accept')) headers.set('accept','application/json, text/event-stream');
      try {
        // Fixed URL; never forward caller-provided query strings or redirects.
        const fetchOptions = {
          method: request.method, headers,
          ...(request.method === 'POST' ? {body: requestBody} : {}),
          redirect:'manual',
        };
        const response = isVpcMcpProbe || route.transport === 'vpc'
          ? await env.ATLASSIAN_RELAY_VPC.fetch(route.url.toString(),fetchOptions)
          : await fetch(route.url.toString(),fetchOptions);
        if (response.status === 401 || response.status === 403) {
          if (env.UPSTREAM_DENIAL_DIAGNOSTICS === 'on') {
            try {await diagnoseUpstreamDenial(response);}
            catch {try {await response.body?.cancel();} catch { /* best effort */ }}
          } else {
            await response.body?.cancel();
          }
          return json({error:'upstream_authorization_failed'},502);
        }
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel();
          return json({error:'unexpected_upstream_redirect'},502);
        }
        // Filtering must happen before returning any bytes to the caller.
        if (isToolList) return await filteredToolListResponse(response,tools);
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
