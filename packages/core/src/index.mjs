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


const MAX_TOOL_LIST_RESPONSE_BYTES = 2_097_152;
const MAX_VIRTUAL_REPLY_BYTES = 262_144;
const MAX_VIRTUAL_OUTPUT_BYTES = 65_536;
const VIRTUAL_TOOL_NAME = 'listBitbucketRepositories';
const VIRTUAL_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

const isObject = x => x !== null && typeof x === 'object' && !Array.isArray(x);
function virtualError(id, status, code, message) {
  return json({jsonrpc:'2.0',id:id ?? null,error:{code,message}},status);
}
function approvedVirtualWorkspace(config, env) {
  const v = config.virtualTool;
  if (!v || v.publicName !== VIRTUAL_TOOL_NAME ||
      v.internalToolName !== 'executeRead' ||
      v.internalOperationName !== VIRTUAL_TOOL_NAME ||
      v.workspaceBinding?.envKey !== 'BITBUCKET_WORKSPACE_SLUG' ||
      !isObject(v.workspaceBinding.approved) ||
      typeof v.workspaceBinding.approved.ownerDecisionRef !== 'string' ||
      !/\/blob\/[a-f0-9]{40}\//.test(v.workspaceBinding.approved.ownerDecisionRef) ||
      !/^[a-f0-9]{64}$/.test(v.workspaceBinding.approved.ownerDecisionSha256) ||
      typeof v.buildInputs !== 'function' || typeof v.normalize !== 'function' ||
      typeof v.description !== 'string' ||
      env.ATLASSIAN_UPSTREAM_MODE !== 'local_relay_vpc' ||
      env.ATLASSIAN_UNVERIFIED_READ_TOOLS !== 'off') return null;
  const slug = v.workspaceBinding.approved.slug;
  if (typeof slug !== 'string' || !VIRTUAL_SLUG_RE.test(slug) ||
      typeof env.BITBUCKET_WORKSPACE_SLUG !== 'string' ||
      !VIRTUAL_SLUG_RE.test(env.BITBUCKET_WORKSPACE_SLUG) ||
      env.BITBUCKET_WORKSPACE_SLUG !== slug) return null;
  return slug;
}
function validateVirtualCall(payload) {
  if (!Object.hasOwn(payload,'id') ||
      !(typeof payload.id === 'string' && payload.id.length > 0 ||
        typeof payload.id === 'number' && Number.isFinite(payload.id))) return false;
  const p = payload.params;
  return isObject(p) && Object.keys(p).length === 2 &&
    p.name === VIRTUAL_TOOL_NAME &&
    isObject(p.arguments) && Object.keys(p.arguments).length === 0;
}
function firstToolListPage(payload) {
  if (!Object.hasOwn(payload,'id') ||
      !(typeof payload.id === 'string' || typeof payload.id === 'number')) return false;
  if (payload.params === undefined) return true;
  return isObject(payload.params) && Object.keys(payload.params).length === 0;
}
function virtualDescriptor(v) {
  return {name:VIRTUAL_TOOL_NAME,description:v.description,
    inputSchema:{type:'object',properties:{},additionalProperties:false}};
}
async function readBoundedJson(response, limit) {
  const cl = response.headers.get('content-length');
  if (cl !== null && Number.isFinite(Number(cl)) && Number(cl) > limit) throw Error('oversize');
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
    throw Error('content_type');
  }
  const reader = response.body?.getReader();
  if (!reader) throw Error('body');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const {value,done} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {await reader.cancel();throw Error('oversize');}
      chunks.push(value);
    }
  } catch (e) {try {await reader.cancel();} catch {} throw e;}
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {bytes.set(chunk,at);at += chunk.byteLength;}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
}
async function handleVirtualTool({payload, route, headers, env, config, workspace}) {
  const id = payload.id;
  let args;
  try {
    args = config.virtualTool.buildInputs(Object.freeze({workspace}));
    if (!isObject(args) || Object.keys(args).some(k=>!['workspaceId','page','pagelen'].includes(k)) ||
        Object.keys(args).length !== 3 || args.workspaceId !== workspace ||
        args.page !== 1 || args.pagelen !== 25) throw Error('invalid_inputs');
  } catch {
    return virtualError(id,503,-32050,'Bitbucket read route not configured');
  }
  const rpc={jsonrpc:'2.0',id,method:'tools/call',
    params:{name:'executeRead',
      arguments:{name:VIRTUAL_TOOL_NAME,inputs:args}}};
  headers.set('content-type','application/json');
  headers.set('accept','application/json');
  let response;
  try {
    response = await env.ATLASSIAN_RELAY_VPC.fetch(route.url.toString(),{
      method:'POST',headers,body:JSON.stringify(rpc),redirect:'manual',
      signal:AbortSignal.timeout(30000),
    });
  } catch {
    return virtualError(id,502,-32053,'Bitbucket upstream unavailable');
  }
  if (!response || typeof response.status !== 'number') {
    return virtualError(id,502,-32053,'Bitbucket upstream unavailable');
  }
  const status = response.status;
  if (status !== 200) {
    try {await response.body?.cancel();} catch {}
    if (status === 401 || status === 403) {
      return virtualError(id,502,-32051,'Bitbucket upstream authorization failed');
    }
    if (status >= 300 && status <= 399 || status === 408 || status === 429 ||
        status >= 500 && status <= 599) {
      return virtualError(id,502,-32053,'Bitbucket upstream unavailable');
    }
    if (status >= 400 && status <= 499) {
      return virtualError(id,502,-32055,'Bitbucket operation failed');
    }
    return virtualError(id,502,-32054,'Bitbucket upstream response rejected');
  }
  let body;
  try {body=await readBoundedJson(response,MAX_VIRTUAL_REPLY_BYTES);}
  catch {return virtualError(id,502,-32054,'Bitbucket upstream response rejected');}
  if (!isObject(body) || body.jsonrpc !== '2.0' || body.id !== id ||
      Object.hasOwn(body,'result') === Object.hasOwn(body,'error')) {
    return virtualError(id,502,-32054,'Bitbucket upstream response rejected');
  }
  if (Object.hasOwn(body,'error')) {
    return virtualError(id,502,-32055,'Bitbucket operation failed');
  }
  if (!isObject(body.result)) {
    return virtualError(id,502,-32054,'Bitbucket upstream response rejected');
  }
  if (body.result.isError === true) {
    return virtualError(id,502,-32055,'Bitbucket operation failed');
  }
  let page;
  try {
    page=config.virtualTool.normalize(body.result,Object.freeze({workspace}));
    if (!isObject(page) || page.schemaVersion !== 1 || page.workspace !== workspace ||
        !Array.isArray(page.repositories) || page.repositories.length>25 ||
        typeof page.truncated !== 'boolean') throw Error('bad_projection');
  } catch {
    return virtualError(id,502,-32054,'Bitbucket upstream response rejected');
  }
  const projected={jsonrpc:'2.0',id,result:{content:[
    {type:'text',text:JSON.stringify(page)}],isError:false}};
  if (new TextEncoder().encode(JSON.stringify(projected)).length > MAX_VIRTUAL_OUTPUT_BYTES) {
    return virtualError(id,502,-32054,'Bitbucket upstream response rejected');
  }
  return json(projected);
}

/**
 * A tools/list response is a security boundary: never relay an unfiltered
 * upstream response, including SSE, malformed JSON and oversized bodies.
 * Keep pagination metadata intact; each tools/list page is filtered.
 */
async function filteredToolListResponse(response, allowedTools, extraTool = null) {
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
  if (extraTool && body.result.tools.some(t=>t?.name===extraTool.name)) {
    return json({error:'invalid_upstream_tool_list'},502);
  }
  const filtered = {
    ...body, result: {...body.result,
      tools: [...body.result.tools.filter(t =>
        t !== null && typeof t === 'object' &&
        typeof t.name === 'string' && allowedTools.has(t.name)),
        ...(extraTool ? [extraTool] : [])],
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
  // Unverified nested executeRead semantics must never be assumed safe.
  // Both tools stay unavailable unless an explicit, reviewed opt-in is set.
  const unverifiedTools = new Set(['discover','executeRead']);
  const serviceName = config.name;

  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      if (url.pathname === '/health' && request.method === 'GET') {
        return json({service: serviceName, phase: 'transport-only', status: 'alive',
          upstreamConnection: 'not_verified'});
      }
      // Authenticated operator health probe and the normal MCP route only.
      // /health/vpc cannot invoke any MCP method or forward caller secrets.
      if (url.pathname !== '/mcp' && url.pathname !== '/health/vpc') {
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
      const route = getRoute(env,upstream);
      if (!route) return json({error:'upstream_not_configured'},503);
      const permittedTools = env.ATLASSIAN_UNVERIFIED_READ_TOOLS === 'on'
        ? tools
        : new Set([...tools].filter(name => !unverifiedTools.has(name)));

      let requestBody;
      let parsedPayload;
      let isVirtual = false;
      let virtualWorkspace = null;
      let isToolList = false;
      let includeVirtualList = false;
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
            payload.jsonrpc === '2.0' &&
            payload.method === 'server/discover' &&
            (typeof payload.id === 'string' || typeof payload.id === 'number')) {
          return json({jsonrpc:'2.0', id:payload.id,
            error:{code:-32601, message:'Method not found'}});
        }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
            payload.jsonrpc !== '2.0' || !ALLOWED_METHODS.has(payload.method)) {
          return rpcError(payload,'MCP method is not allowed');
        }
        virtualWorkspace = approvedVirtualWorkspace(config, env);
        const virtualRequested = payload.method === 'tools/call' &&
          payload.params?.name === VIRTUAL_TOOL_NAME;
        if (virtualRequested && config.virtualTool) {
          if (!virtualWorkspace) {
            return virtualError(payload.id,503,-32050,'Bitbucket read route not configured');
          }
          if (!validateVirtualCall(payload)) {
            return virtualError(payload.id,400,-32602,'Invalid listBitbucketRepositories arguments');
          }
          isVirtual = true;
        } else if (payload.method === 'tools/call' &&
                   !permittedTools.has(payload.params?.name)) {
          return rpcError(payload,'MCP tool is not on the allowlist');
        }
        isToolList = payload.method === 'tools/list';
        includeVirtualList = isToolList && virtualWorkspace !== null &&
          firstToolListPage(payload);
        parsedPayload = payload;
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
        if (isVirtual) {
          return await handleVirtualTool({
            payload:parsedPayload,route,headers,env,config,workspace:virtualWorkspace,
          });
        }
        // Fixed URL; never forward caller-provided query strings or redirects.
        const fetchOptions = {
          method: request.method, headers,
          ...(request.method === 'POST' ? {body: requestBody} : {}),
          redirect:'manual',
        };
        const response = route.transport === 'vpc'
          ? await env.ATLASSIAN_RELAY_VPC.fetch(route.url.toString(),fetchOptions)
          : await fetch(route.url.toString(),fetchOptions);
        if (response.status === 401 || response.status === 403) {
          await response.body?.cancel();
          return json({error:'upstream_authorization_failed'},502);
        }
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel();
          return json({error:'unexpected_upstream_redirect'},502);
        }
        // Filtering must happen before returning any bytes to the caller.
        if (isToolList) return await filteredToolListResponse(response,permittedTools,
          includeVirtualList ? virtualDescriptor(config.virtualTool) : null);
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
