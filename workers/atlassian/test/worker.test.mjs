import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.mjs';

const env = {
  PORTAL_BEARER_TOKEN: 'p'.repeat(48),
  UPSTREAM_AUTHORIZATION: 'Bearer ' + 'a'.repeat(48),
};
const request = (method, body, headers = {}) => new Request('https://bridge.example/mcp', {
  method,
  headers: {...(body ? {'content-type': 'application/json'} : {}), ...headers},
  body: body && JSON.stringify(body),
});
const call = (method, params, id=1) => ({jsonrpc:'2.0', id, method, params});
const auth = {authorization:'Bearer ' + env.PORTAL_BEARER_TOKEN};
async function withFetch(fake, run) {
  const original = globalThis.fetch;
  globalThis.fetch = fake;
  try { await run(); } finally { globalThis.fetch = original; }
}

test('health has no credentials or upstream connection claims', async () => {
  const r = await worker.fetch(new Request('https://bridge.example/health'),env);
  assert.equal(r.status,200);
  assert.equal((await r.json()).upstreamConnection,'not_verified');
});
test('unauthorized requests fail closed before contacting upstream', async () => {
  await withFetch(() => {throw Error('unexpected fetch')}, async () => {
    const r = await worker.fetch(request('POST',call('initialize')),env);
    assert.equal(r.status,401);
  });
});
test('missing portal credential fails closed', async () => {
  const r = await worker.fetch(request('POST',call('initialize'),auth),{
    ...env,PORTAL_BEARER_TOKEN:'',
  });
  assert.equal(r.status,401);
});
test('missing upstream authorization fails closed', async () => {
  const r = await worker.fetch(request('POST',call('initialize'),auth),{
    ...env,UPSTREAM_AUTHORIZATION:'',
  });
  assert.equal(r.status,503);
});
test('forwards initialize to fixed origin and replaces authorization', async () => {
  await withFetch(async (url, opts) => {
    assert.equal(String(url),'https://mcp.atlassian.com/v2/mcp');
    assert.equal(opts.headers.get('authorization'),env.UPSTREAM_AUTHORIZATION);
    assert.equal(opts.headers.get('content-type'),'application/json');
    assert.equal(opts.headers.get('cf-access-client-secret'),null);
    assert.equal(JSON.parse(await new Response(opts.body).text()).method,'initialize');
    return new Response(JSON.stringify({jsonrpc:'2.0',id:1,result:{protocolVersion:'2025-03-26'}}),{
      status:200,headers:{'content-type':'application/json','mcp-session-id':'test-session','set-cookie':'NO'},
    });
  },async () => {
    const r = await worker.fetch(request('POST',call('initialize'),{
      ...auth,'cf-access-client-secret':'SENSITIVE',
    }),env);
    assert.equal(r.status,200);
    assert.equal(r.headers.get('mcp-session-id'),'test-session');
    assert.equal(r.headers.get('set-cookie'),null);
  });
});
test('allowed tool relayed; write and unknown tool names blocked before upstream', async () => {
  let forwarded=0;
  await withFetch(async () => {
    forwarded++;
    return new Response('ok',{headers:{'content-type':'application/json'}});
  },async () => {
    const allowed = await worker.fetch(request('POST',call('tools/call',{name:'executeRead'}),auth),env);
    assert.equal(allowed.status,200);
    for (const name of ['executeWrite','executeDestructive','unknown']) {
      const denied = await worker.fetch(request('POST',call('tools/call',{name}),auth),env);
      assert.equal(denied.status,403);
      assert.equal((await denied.json()).error.code,-32001);
    }
    assert.equal(forwarded,1);
  });
});
test('rejects invalid JSON-RPC payloads and unsupported methods', async () => {
  assert.equal((await worker.fetch(request('POST',{oops:true},auth),env)).status,403);
  assert.equal((await worker.fetch(request('POST',[call('initialize')],auth),env)).status,403);
  assert.equal((await worker.fetch(new Request('https://bridge.example/mcp',{
    method:'PUT',headers:auth,
  }),env)).status,405);
  assert.equal((await worker.fetch(new Request('https://bridge.example/private',{
    headers:auth,
  }),env)).status,404);
});
test('upstream 401 does not become an OAuth challenge to Portal',async () => {
  await withFetch(async () => new Response('secret',{
    status:401, headers:{'www-authenticate':'Bearer realm="upstream"'},
  }),async () => {
    const r = await worker.fetch(request('POST',call('tools/list'),auth),env);
    assert.equal(r.status,502);
    assert.equal(r.headers.get('www-authenticate'),null);
    assert.equal((await r.json()).error,'upstream_authorization_failed');
  });
});
test('SSE GET remains streaming; only allowlisted headers are returned',async () => {
  await withFetch(async (url,opts) => {
    assert.equal(opts.method,'GET');
    assert.equal(opts.headers.get('mcp-session-id'),'s123');
    return new Response('event: message\ndata: hi\n\n',{
      headers:{'content-type':'text/event-stream','set-cookie':'X'},
    });
  },async () => {
    const r = await worker.fetch(new Request('https://bridge.example/mcp',{
      headers:{...auth,'mcp-session-id':'s123',accept:'text/event-stream'},
    }),env);
    assert.equal(r.status,200);
    assert.equal(r.headers.get('content-type'),'text/event-stream');
    assert.equal(r.headers.get('set-cookie'),null);
  });
});
test('refuses unexpected upstream redirects',async () => {
  await withFetch(async () => new Response('',{
    status:302,headers:{location:'https://evil.example/steal'},
  }),async () => {
    const r = await worker.fetch(request('POST',call('initialize'),auth),env);
    assert.equal(r.status,502);
    assert.equal(r.headers.get('location'),null);
  });
});
test('rejects oversized JSON without contacting upstream',async () => {
  await withFetch(async () => {throw Error('should not fetch')},async () => {
    const r = await worker.fetch(request('POST',call('tools/list',{padding:'x'.repeat(262_145)}),auth),env);
    assert.equal(r.status,413);
  });
});
test('caller query parameters cannot affect upstream URL',async () => {
  await withFetch(async (url) => {
    assert.equal(String(url),'https://mcp.atlassian.com/v2/mcp');
    return new Response('{}',{headers:{'content-type':'application/json'}});
  },async () => {
    const r = await worker.fetch(new Request('https://bridge.example/mcp?tools=all&target=https://evil.example',{
      method:'POST',headers:{...auth,'content-type':'application/json'},
      body:JSON.stringify(call('ping')),
    }),env);
    assert.equal(r.status,200);
  });
});
test('caller cookies and non-allowlisted headers are not forwarded',async () => {
  await withFetch(async (_,opts) => {
    assert.equal(opts.headers.get('cookie'),null);
    assert.equal(opts.headers.get('x-secret'),null);
    assert.equal(opts.headers.get('authorization'),env.UPSTREAM_AUTHORIZATION);
    return new Response('{}',{headers:{'content-type':'application/json'}});
  },async () => {
    const r = await worker.fetch(request('POST',call('ping'),{
      ...auth,cookie:'secret','x-secret':'secret',
    }),env);
    assert.equal(r.status,200);
  });
});
test('wrong Portal bearer token does not contact upstream',async () => {
  await withFetch(() => {throw Error('upstream should not be contacted')},async () => {
    const r = await worker.fetch(request('POST',call('ping'),{
      authorization:'Bearer ' + 'a'.repeat(48),
    }),env);
    assert.equal(r.status,401);
  });
});


test('local relay route sends only server-bound tunnel and Access credentials',async()=>{
 const secrets={...env,ATLASSIAN_UPSTREAM_MODE:'local_relay',
   LOCAL_RELAY_ORIGIN:'https://atlassian-relay.example.com/',
   LOCAL_RELAY_BEARER_TOKEN:'r'.repeat(48),
   CF_ACCESS_CLIENT_ID:'cf-service-id',
   CF_ACCESS_CLIENT_SECRET:'c'.repeat(48),
   UPSTREAM_AUTHORIZATION:''};
 await withFetch(async(url,opts)=>{
   assert.equal(String(url),'https://atlassian-relay.example.com/mcp');
   assert.equal(opts.headers.get('authorization'),'Bearer '+'r'.repeat(48));
   assert.equal(opts.headers.get('cf-access-client-id'),'cf-service-id');
   assert.equal(opts.headers.get('cf-access-client-secret'),'c'.repeat(48));
   assert.equal(opts.headers.get('cookie'),null);
   assert.equal(opts.headers.get('x-relay-url'),null);
   return new Response('{"jsonrpc":"2.0","id":1,"result":{}}',{headers:{'content-type':'application/json'}});
 },async()=>{
   const r=await worker.fetch(request('POST',call('ping'),{
     ...auth,'x-relay-url':'https://evil.example','cf-access-client-secret':'ATTACKER',cookie:'BAD'
   }),secrets);
   assert.equal(r.status,200);
 });
});
test('relay mode fails closed on missing or invalid credentials and URLs',async()=>{
 const b={...env,ATLASSIAN_UPSTREAM_MODE:'local_relay',
   LOCAL_RELAY_ORIGIN:'https://atlassian-relay.example.com/',
   LOCAL_RELAY_BEARER_TOKEN:'r'.repeat(48),
   CF_ACCESS_CLIENT_ID:'cf-service-id',CF_ACCESS_CLIENT_SECRET:'c'.repeat(48)};
 await withFetch(()=>{throw Error('must not contact upstream')},async()=>{
   for(const changes of [
     {LOCAL_RELAY_BEARER_TOKEN:''},
     {CF_ACCESS_CLIENT_SECRET:''},
     {CF_ACCESS_CLIENT_ID:''},
     {LOCAL_RELAY_ORIGIN:'http://atlassian-relay.example.com/'},
     {LOCAL_RELAY_ORIGIN:'https://atlassian-relay.example.com/evil'},
     {LOCAL_RELAY_ORIGIN:'https://atlassian-relay.example.com/?redirect=https://evil.example'},
     {LOCAL_RELAY_ORIGIN:'https://127.0.0.1/'},
     {ATLASSIAN_UPSTREAM_MODE:'unknown'},
   ]){
     const r=await worker.fetch(request('POST',call('initialize'),auth),{...b,...changes});
     assert.equal(r.status,503);
   }
 });
});

test('tools/list exposes only the four allowed tools and retains schema and cursor',async()=>{
  const upstreamTools=[
    {name:'atlassianUserInfo',description:'identity',inputSchema:{type:'object',properties:{}}},
    {name:'getAccessibleAtlassianResources',description:'sites',inputSchema:{type:'object'}},
    {name:'discover',description:'discovery',inputSchema:{type:'object'}},
    {name:'executeRead',description:'read',inputSchema:{type:'object'}},
    {name:'executeWrite',description:'write',inputSchema:{type:'object'}},
    {name:'executeDestructive',description:'delete',inputSchema:{type:'object'}},
    {name:'searchJiraIssuesUsingJql',description:'primary search'},
    {name:'anotherNewWriteTool'},
  ];
  await withFetch(async (_,opts)=>{
    assert.equal(JSON.parse(new TextDecoder().decode(opts.body)).method,'tools/list');
    return new Response(JSON.stringify({
      jsonrpc:'2.0',id:7,result:{tools:upstreamTools,nextCursor:'next-page'},
    }),{headers:{'content-type':'application/json; charset=utf-8',
      'mcp-session-id':'session-1','set-cookie':'secret-cookie'}});
  },async()=>{
    const r=await worker.fetch(request('POST',call('tools/list',{},7),auth),env);
    assert.equal(r.status,200);
    assert.equal(r.headers.get('mcp-session-id'),'session-1');
    assert.equal(r.headers.get('set-cookie'),null);
    assert.equal(r.headers.get('content-length'),null);
    const payload=await r.json();
    assert.equal(payload.id,7);
    assert.equal(payload.result.nextCursor,'next-page');
    assert.deepEqual(payload.result.tools.map(t=>t.name),
      ['atlassianUserInfo','getAccessibleAtlassianResources','discover','executeRead']);
    assert.deepEqual(payload.result.tools[0],upstreamTools[0]);
    assert.ok(!JSON.stringify(payload).includes('executeWrite'));
    assert.ok(!JSON.stringify(payload).includes('executeDestructive'));
  });
});

test('tools/list pagination still filters all subsequent pages',async()=>{
  let page=0;
  await withFetch(async(_,opts)=>{
    const rpc=JSON.parse(new TextDecoder().decode(opts.body));
    assert.equal(rpc.method,'tools/list');
    if(page++===0){
      return Response.json({jsonrpc:'2.0',id:rpc.id,result:{tools:[{name:'executeWrite'}],
        nextCursor:'page-2'}});
    }
    assert.deepEqual(rpc.params,{cursor:'page-2'});
    return Response.json({jsonrpc:'2.0',id:rpc.id,result:{tools:[
      {name:'executeDestructive'},{name:'executeRead'}]}});
  },async()=>{
    const first=await worker.fetch(request('POST',call('tools/list',{},9),auth),env);
    assert.deepEqual((await first.json()).result,{tools:[],nextCursor:'page-2'});
    const next=await worker.fetch(request('POST',call('tools/list',{cursor:'page-2'},10),auth),env);
    assert.deepEqual((await next.json()).result,{tools:[{name:'executeRead'}]});
    assert.equal(page,2);
  });
});

test('tools/list never exposes unfiltered SSE, malformed or oversized upstream bodies',async()=>{
  const unsafe=[
    {payload:'event: message\\ndata: {"name":"executeDestructive"}\\n\\n',
      type:'text/event-stream'},
    {payload:'{invalid',type:'application/json'},
    {payload:JSON.stringify({jsonrpc:'2.0',id:1,result:{notTools:[{name:'executeWrite'}]}}),
      type:'application/json'},
    {payload:'x'.repeat(2_097_153),type:'application/json'},
  ];
  for(const {payload,type} of unsafe){
    await withFetch(async()=>new Response(payload,{headers:{'content-type':type}}),async()=>{
      const r=await worker.fetch(request('POST',call('tools/list',{},1),auth),env);
      assert.equal(r.status,502);
      assert.equal(r.headers.get('content-type'),'application/json; charset=utf-8');
      const text=await r.text();
      assert.ok(!text.includes('executeWrite'));
      assert.ok(!text.includes('executeDestructive'));
      assert.ok(!text.includes('event:'));
    });
  }
});

test('write/destructive tools/call rejected before Access tunnel request',async()=>{
 const relayEnv={...env,ATLASSIAN_UPSTREAM_MODE:'local_relay',
   LOCAL_RELAY_ORIGIN:'https://atlassian-relay.example.com/',
   LOCAL_RELAY_BEARER_TOKEN:'r'.repeat(48),
   CF_ACCESS_CLIENT_ID:'test-service-id',
   CF_ACCESS_CLIENT_SECRET:'c'.repeat(48),
 };
 await withFetch(()=>{throw Error('blocked tool reached upstream')},async()=>{
   for(const name of ['executeWrite','executeDestructive','getJiraIssue']){
     const r=await worker.fetch(request('POST',call('tools/call',{name}),auth),relayEnv);
     assert.equal(r.status,403);
     assert.equal((await r.json()).error.code,-32001);
   }
 });
});

test('2026-07-28 server/discover probe reports legacy MCP support without HTTP auth denial', async () => {
  const probe = {
    jsonrpc:'2.0', id:'server-discover-probe-1', method:'server/discover',
    params:{_meta:{
      'io.modelcontextprotocol/protocolVersion':'2026-07-28',
      'io.modelcontextprotocol/clientInfo':{name:'portal-probe',version:'1'},
      'io.modelcontextprotocol/clientCapabilities':{},
    }},
  };
  let fetchCount=0;
  await withFetch(async () => { fetchCount++; throw Error('probe must not reach upstream'); }, async () => {
    const response = await worker.fetch(request('POST',probe,{
      ...auth,'mcp-method':'server/discover','mcp-protocol-version':'2026-07-28',
      accept:'application/json, text/event-stream',
    }),env);
    assert.equal(response.status,200);
    assert.equal(response.headers.get('content-type'),'application/json; charset=utf-8');
    assert.deepEqual(await response.json(),{jsonrpc:'2.0',id:'server-discover-probe-1',
      error:{code:-32601,message:'Method not found'}});
    assert.equal(fetchCount,0);
  });
});

test('legacy probe fallback preserves authentication, initialize and tool visibility',async()=>{
  let upstreamCalls=0;
  await withFetch(async(_,opts)=>{
    upstreamCalls++;
    const msg=JSON.parse(new TextDecoder().decode(opts.body));
    if (msg.method==='initialize') {
      return Response.json({jsonrpc:'2.0',id:msg.id,
        result:{protocolVersion:'2025-03-26',capabilities:{tools:{}},
          serverInfo:{name:'atlassian-mcp-server',version:'1.0.0'}}});
    }
    assert.equal(msg.method,'tools/list');
    return Response.json({jsonrpc:'2.0',id:msg.id,
      result:{tools:[{name:'executeWrite'},{name:'executeRead'},
        {name:'executeDestructive'},{name:'discover'}]}});
  },async()=>{
    const probe=call('server/discover',{_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28'}},
      'server-discover-probe-1');
    const denied=await worker.fetch(request('POST',probe),env);
    assert.equal(denied.status,401);
    const unsupported=await worker.fetch(request('POST',probe,auth),env);
    assert.equal(unsupported.status,200);
    assert.equal((await unsupported.json()).error.code,-32601);
    const init=await worker.fetch(request('POST',call('initialize',
      {protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'portal',version:'1'}},2),auth),env);
    assert.equal((await init.json()).result.protocolVersion,'2025-03-26');
    const list=await worker.fetch(request('POST',call('tools/list',{},3),auth),env);
    assert.deepEqual((await list.json()).result.tools.map(t=>t.name),['executeRead','discover']);
    const write=await worker.fetch(request('POST',call('tools/call',{name:'executeWrite'},4),auth),env);
    assert.equal(write.status,403);
    assert.equal(upstreamCalls,2);
  });
});

test('non-probe unknown MCP methods remain forbidden, never forwarded',async()=>{
  await withFetch(()=>{throw Error('unknown method forwarded')},async()=>{
    for(const method of ['resources/list','prompts/list','server/discover-other']) {
      const r=await worker.fetch(request('POST',call(method,{},11),auth),env);
      assert.equal(r.status,403);
      assert.equal((await r.json()).error.code,-32001);
    }
    const malformed=await worker.fetch(request('POST',{jsonrpc:'1.0',
      method:'server/discover',id:1},auth),env);
    assert.equal(malformed.status,403);
    const notification=await worker.fetch(request('POST',{jsonrpc:'2.0',
      method:'server/discover'},auth),env);
    assert.equal(notification.status,403);
  });
});


test('temporary upstream denial diagnostics contain classifications but no body or secrets',async()=>{
  const origin={...env,UPSTREAM_DENIAL_DIAGNOSTICS:'on',
    ATLASSIAN_UPSTREAM_MODE:'local_relay',
    LOCAL_RELAY_ORIGIN:'https://atlassian-relay.example/',
    LOCAL_RELAY_BEARER_TOKEN:'r'.repeat(48),
    CF_ACCESS_CLIENT_ID:'synthetic-client-id',
    CF_ACCESS_CLIENT_SECRET:'synthetic-access-secret-12345678901234567890123'};
  const originalWarn=console.warn;
  const events=[];
  console.warn=(line)=>events.push(line);
  try {
    await withFetch(async()=>new Response(
      '<html>Cloudflare Access /cdn-cgi/access/ error code: 1042 '+
      'DO_NOT_LOG_BODY_SECRET=some-credential</html>', {
        status:403, headers:{
          'content-type':'text/html; charset=utf-8',
          'cf-ray':'SENSITIVE_RAY',
          'cf-mitigated':'challenge',
          'set-cookie':'SENSITIVE_COOKIE',
        },
      }),async()=>{
        const result=await worker.fetch(request('POST',call('tools/call',
          {name:'getAccessibleAtlassianResources',arguments:{}},99),auth),origin);
        assert.equal(result.status,502);
        assert.deepEqual(await result.json(),{error:'upstream_authorization_failed'});
        assert.equal(result.headers.get('set-cookie'),null);
        assert.equal(result.headers.get('cf-ray'),null);
      });
    assert.equal(events.length,1);
    assert.ok(events[0].startsWith('MCP_UPSTREAM_DENIAL '));
    const logged=JSON.parse(events[0].slice('MCP_UPSTREAM_DENIAL '.length));
    assert.equal(logged.status,403);
    assert.equal(logged.media_type,'html');
    assert.equal(logged.cf_mitigated_challenge,true);
    assert.equal(logged.cf_ray_present,true);
    assert.equal(logged.access_marker,true);
    assert.equal(logged.error_1042,true);
    for(const privateValue of ['DO_NOT_LOG_BODY_SECRET','some-credential',
      'SENSITIVE_RAY','SENSITIVE_COOKIE',origin.CF_ACCESS_CLIENT_SECRET,
      origin.LOCAL_RELAY_BEARER_TOKEN,origin.PORTAL_BEARER_TOKEN]) {
      assert.equal(events[0].includes(privateValue),false);
    }
  } finally {console.warn=originalWarn;}
});

test('diagnostic denial inspection is bounded and opt-in',async()=>{
  const originalWarn=console.warn;
  const events=[];
  console.warn=(line)=>events.push(line);
  try {
    let consumed=0;
    await withFetch(async()=>new Response(new ReadableStream({
      pull(controller) {
        consumed++;
        controller.enqueue(new TextEncoder().encode('X'.repeat(40_000)));
      },
    }),{status:401,headers:{'content-type':'application/json'}}),async()=>{
      const r=await worker.fetch(request('POST',call('ping'),auth),
        {...env,UPSTREAM_DENIAL_DIAGNOSTICS:'on'});
      assert.equal(r.status,502);
    });
    assert.equal(events.length,1);
    const logged=JSON.parse(events[0].slice('MCP_UPSTREAM_DENIAL '.length));
    assert.equal(logged.media_type,'json');
    assert.equal(logged.inspection_limit_reached,true);
    assert.equal(logged.inspected_bytes,65_536);
    assert.ok(consumed<=3);
    events.length=0;
    await withFetch(async()=>new Response('SECRET_SHOULD_NOT_BE_LOGGED',
      {status:403,headers:{'content-type':'text/html'}}),async()=>{
      const r=await worker.fetch(request('POST',call('ping'),auth),env);
      assert.equal(r.status,502);
      assert.equal((await r.json()).error,'upstream_authorization_failed');
    });
    assert.deepEqual(events,[]);
  } finally {console.warn=originalWarn;}
});

test('successful MCP responses emit no upstream-denial diagnostic',async()=>{
  const originalWarn=console.warn;
  const events=[];
  console.warn=(line)=>events.push(line);
  try {
    await withFetch(async()=>Response.json({jsonrpc:'2.0',id:5,result:{}}),async()=>{
      const r=await worker.fetch(request('POST',call('ping',{},5),auth),
        {...env,UPSTREAM_DENIAL_DIAGNOSTICS:'on'});
      assert.equal(r.status,200);
    });
    assert.deepEqual(events,[]);
  } finally {console.warn=originalWarn;}
});


test('vpc-health-probe requires Portal bearer and never uses public fetch',async()=>{
  let used=0;
  const onlyVPC={...env,ATLASSIAN_RELAY_VPC:{fetch:async()=>{used++;return Response.json({status:'alive'});}}};
  await withFetch(async()=>{throw Error('public fetch must never be used');},async()=>{
    for(const headers of [{},{authorization:'Bearer '+ 'x'.repeat(48)}]){
      const response=await worker.fetch(new Request('https://bridge.example/health/vpc',{headers}),onlyVPC);
      assert.equal(response.status,401);
    }
    assert.equal(used,0);
    const denied=await worker.fetch(new Request('https://bridge.example/health/vpc',{
      method:'POST',headers:auth
    }),onlyVPC);
    assert.equal(denied.status,405);
    assert.equal(used,0);
  });
});

test('vpc-health-probe reports transport-only liveness without exposing relay data',async()=>{
  let vpcCalls=0;
  const secret='DO_NOT_EXPOSE_RELAY_BODY';
  const secretURL='https://attacker.invalid/health';
  const onlyVPC={...env,ATLASSIAN_RELAY_VPC:{
    async fetch(url,options) {
      vpcCalls++;
      assert.equal(url,'http://127.0.0.1/health');
      assert.equal(options.method,'GET');
      assert.equal(options.redirect,'manual');
      assert.equal(options.headers.accept,'application/json');
      assert.equal(options.headers.authorization,undefined);
      assert.equal(options.headers.cookie,undefined);
      assert.ok(options.signal);
      return new Response(JSON.stringify({secret,origin:secretURL}),{
        status:200,headers:{'content-type':'application/json','set-cookie':'private'}});
    }
  }};
  await withFetch(async()=>{throw Error('public fetch must never be used');},async()=>{
    const response=await worker.fetch(new Request('https://bridge.example/health/vpc?destination='+encodeURIComponent(secretURL),{
      headers:{...auth,cookie:secret,'cf-access-client-secret':secret}
    }),onlyVPC);
    assert.equal(response.status,200);
    assert.equal(response.headers.get('cache-control'),'no-store');
    assert.equal(response.headers.get('set-cookie'),null);
    assert.deepEqual(await response.json(),{service:'atlassian-rovo-mcp-bridge',
      phase:'vpc-transport-only',status:'reachable',upstreamConnection:'not_verified'});
  });
  assert.equal(vpcCalls,1);
});

test('vpc-health-probe fails closed for missing binding, non-200, errors',async()=>{
  const uri='https://bridge.example/health/vpc';
  const unbound=await worker.fetch(new Request(uri,{headers:auth}),env);
  assert.equal(unbound.status,503);
  assert.deepEqual(await unbound.json(),{error:'vpc_binding_not_configured'});
  for (const status of [302,401,403,404,500]) {
    const r=await worker.fetch(new Request(uri,{headers:auth}),{
      ...env,ATLASSIAN_RELAY_VPC:{fetch:async()=>new Response('SECRET_FROM_UPSTREAM',{
        status,headers:{'location':'https://attacker.invalid'}})},
    });
    assert.equal(r.status,502);
    assert.deepEqual(await r.json(),{error:'vpc_health_unavailable'});
    assert.equal(r.headers.get('location'),null);
  }
  const err=await worker.fetch(new Request(uri,{headers:auth}),{
    ...env,ATLASSIAN_RELAY_VPC:{fetch:async()=>{throw Error('SECRET_ERROR');}},
  });
  assert.equal(err.status,502);
  assert.deepEqual(await err.json(),{error:'vpc_health_unavailable'});
});

test('vpc-health-probe binding cannot alter normal MCP upstream selection',async()=>{
  let publicCalls=0,vpcCalls=0;
  await withFetch(async(url)=>{publicCalls++;assert.equal(String(url),'https://mcp.atlassian.com/v2/mcp');
    return Response.json({jsonrpc:'2.0',id:1,result:{}});},async()=>{
    const r=await worker.fetch(request('POST',call('ping'),auth),{
      ...env,ATLASSIAN_RELAY_VPC:{fetch:async()=>{vpcCalls++;throw Error('wrong path')}},
    });
    assert.equal(r.status,200);
  });
  assert.equal(publicCalls,1);
  assert.equal(vpcCalls,0);
});


test('vpc-MCP-probe sends only ping to VPC and never to the public origin',async()=>{
  let vpcCalls=0;
  const diag={...env,ATLASSIAN_RELAY_VPC:{
    async fetch(url,options) {
      vpcCalls++;
      assert.equal(url,'http://127.0.0.1/mcp');
      assert.equal(options.method,'POST');
      assert.equal(options.headers.get('authorization'),'Bearer '+'r'.repeat(48));
      assert.equal(options.headers.get('cf-access-client-id'),null);
      assert.equal(options.headers.get('cf-access-client-secret'),null);
      assert.equal(options.headers.get('cookie'),null);
      assert.equal(JSON.parse(new TextDecoder().decode(options.body)).method,'ping');
      return Response.json({jsonrpc:'2.0',id:'diag-ping',result:{}});
    }
  },LOCAL_RELAY_BEARER_TOKEN:'r'.repeat(48)};
  await withFetch(async()=>{throw Error('public origin should not be used');},async()=>{
    const ok=await worker.fetch(new Request('https://bridge.example/mcp/vpc',{
      method:'POST',headers:{...auth,'content-type':'application/json',cookie:'dont-forward'},
      body:JSON.stringify(call('ping',{},'diag-ping'))
    }),diag);
    assert.equal(ok.status,200);
    assert.equal((await ok.json()).result.constructor,Object);
  });
  assert.equal(vpcCalls,1);
});

test('vpc-MCP-probe only allows argument-free resource discovery and ping',async()=>{
  let forwardCount=0;
  const diag={...env,ATLASSIAN_RELAY_VPC:{async fetch(_url,opts){
    forwardCount++;
    const payload=JSON.parse(new TextDecoder().decode(opts.body));
    assert.equal(payload.method,'tools/call');
    assert.equal(payload.params.name,'getAccessibleAtlassianResources');
    assert.deepEqual(payload.params.arguments,{});
    return Response.json({jsonrpc:'2.0',id:payload.id,result:{resources:[]}});
  }},LOCAL_RELAY_BEARER_TOKEN:'r'.repeat(48)};
  const req=(payload,method='POST')=>new Request('https://bridge.example/mcp/vpc',{
    method,headers:{...auth,'content-type':'application/json'},
    ...(method==='POST'?{body:JSON.stringify(payload)}:{})
  });
  const denied=[
    call('tools/list',{},7),
    call('initialize',{},8),
    call('notifications/initialized',{},9),
    call('tools/call',{name:'executeRead',arguments:{}},10),
    call('tools/call',{name:'executeWrite',arguments:{}},11),
    call('tools/call',{name:'getAccessibleAtlassianResources',arguments:{unexpected:'x'}},12),
    call('tools/call',{name:'getAccessibleAtlassianResources',arguments:{},extra:'x'},13),
    call('tools/call',{name:'getAccessibleAtlassianResources'},14),
    call('server/discover',{},15),
  ];
  await withFetch(async()=>{throw Error('public fetch must not be called');},async()=>{
    for(const payload of denied){
      const res=await worker.fetch(req(payload),diag);
      assert.equal(res.status,403,payload.method);
    }
    for(const method of ['GET','DELETE']){
      const res=await worker.fetch(req(null,method),diag);
      assert.equal(res.status,405);
    }
    const good=await worker.fetch(req(call('tools/call',{
      name:'getAccessibleAtlassianResources',arguments:{}},16)),diag);
    assert.equal(good.status,200);
    assert.deepEqual((await good.json()).result,{resources:[]});
  });
  assert.equal(forwardCount,1);
});

test('vpc-MCP-probe requires bearer, VPC service and relay credential; fails closed',async()=>{
  let vpcCalls=0;
  const bound={...env,LOCAL_RELAY_BEARER_TOKEN:'r'.repeat(48),
    ATLASSIAN_RELAY_VPC:{async fetch(){vpcCalls++;return Response.json({})}}};
  const req=headers=>new Request('https://bridge.example/mcp/vpc',{
    method:'POST',headers:{'content-type':'application/json',...headers},
    body:JSON.stringify(call('ping',{},1))
  });
  assert.equal((await worker.fetch(req(),bound)).status,401);
  assert.equal((await worker.fetch(req(auth),env)).status,503);
  assert.equal((await worker.fetch(req(auth),{...bound,LOCAL_RELAY_BEARER_TOKEN:''})).status,503);
  assert.equal((await worker.fetch(req(auth),{...bound,ATLASSIAN_RELAY_VPC:null})).status,503);
  assert.equal(vpcCalls,0);
  const fault=await worker.fetch(req(auth),{...bound,
    ATLASSIAN_RELAY_VPC:{fetch:async()=>{throw Error('PRIVATE_EXCEPTION')}}});
  assert.equal(fault.status,502);
  assert.deepEqual(await fault.json(),{error:'upstream_unavailable'});
});

test('vpc-MCP-probe never passes upstream challenge or relay bearer to client',async()=>{
  const diag={...env,LOCAL_RELAY_BEARER_TOKEN:'r'.repeat(48),
    ATLASSIAN_RELAY_VPC:{fetch:async()=>new Response('SECRET_BODY',{
      status:403,headers:{'cf-mitigated':'challenge','set-cookie':'SECRET_COOKIE'}
    })}};
  const res=await worker.fetch(new Request('https://bridge.example/mcp/vpc',{
    method:'POST',headers:{...auth,'content-type':'application/json'},
    body:JSON.stringify(call('ping',{},1))}),diag);
  assert.equal(res.status,502);
  assert.deepEqual(await res.json(),{error:'upstream_authorization_failed'});
  assert.equal(res.headers.get('cf-mitigated'),null);
  assert.equal(res.headers.get('set-cookie'),null);
});

test('regular MCP transport uses fixed VPC Binding without sending Access credentials',async()=>{
  const privateEnv={...env,ATLASSIAN_UPSTREAM_MODE:'local_relay_vpc',
    LOCAL_RELAY_BEARER_TOKEN:'r'.repeat(48),
    CF_ACCESS_CLIENT_ID:'still-present-client-id',
    CF_ACCESS_CLIENT_SECRET:'still-present-but-not-forwarded-secret',
    LOCAL_RELAY_ORIGIN:'https://atlassian-relay.example.com/',
    ATLASSIAN_RELAY_VPC:{fetch:async(url,opts)=>{
      assert.equal(String(url),'http://127.0.0.1/mcp');
      assert.equal(opts.method,'POST');
      assert.equal(opts.redirect,'manual');
      assert.equal(opts.headers.get('authorization'),'Bearer '+'r'.repeat(48));
      assert.equal(opts.headers.get('cf-access-client-id'),null);
      assert.equal(opts.headers.get('cf-access-client-secret'),null);
      assert.equal(opts.headers.get('cookie'),null);
      assert.equal(JSON.parse(new TextDecoder().decode(opts.body)).method,'initialize');
      return Response.json({jsonrpc:'2.0',id:1,result:{protocolVersion:'2025-03-26'}});
    }}};
  await withFetch(async()=>{throw Error('public upstream must not be called');},async()=>{
    const r=await worker.fetch(request('POST',
      call('initialize',{protocolVersion:'2025-03-26',capabilities:{},
        clientInfo:{name:'test',version:'1'}},1),
      {...auth,cookie:'never-forward'}),privateEnv);
    assert.equal(r.status,200);
    assert.equal((await r.json()).result.protocolVersion,'2025-03-26');
  });
});

test('regular MCP VPC mode preserves tools/list filtering and blocked tools/call',async()=>{
  let count=0;
  const privateEnv={...env,ATLASSIAN_UPSTREAM_MODE:'local_relay_vpc',
    LOCAL_RELAY_BEARER_TOKEN:'r'.repeat(48),
    ATLASSIAN_RELAY_VPC:{fetch:async(_url,opts)=>{
      count++;
      assert.equal(JSON.parse(new TextDecoder().decode(opts.body)).method,'tools/list');
      return Response.json({jsonrpc:'2.0',id:1,result:{nextCursor:'p2',tools:[
        {name:'executeWrite',inputSchema:{type:'object'}},
        {name:'executeDestructive',inputSchema:{type:'object'}},
        {name:'discover',inputSchema:{type:'object'}},
        {name:'getAccessibleAtlassianResources',inputSchema:{type:'object'}},
        {name:'executeRead',inputSchema:{type:'object'}}]}});}}};
  await withFetch(async()=>{throw Error('public upstream must not be called');},async()=>{
    const list=await worker.fetch(request('POST',call('tools/list',{},1),auth),privateEnv);
    assert.equal(list.status,200);
    const payload=await list.json();
    assert.equal(payload.result.nextCursor,'p2');
    assert.deepEqual(payload.result.tools.map(t=>t.name),
      ['discover','getAccessibleAtlassianResources','executeRead']);
    for(const n of ['executeWrite','executeDestructive','unknown']){
      const denied=await worker.fetch(request('POST',
        call('tools/call',{name:n,arguments:{}},2),auth),privateEnv);
      assert.equal(denied.status,403);
    }
    const unknown=await worker.fetch(request('POST',call('resources/list',{},3),auth),privateEnv);
    assert.equal(unknown.status,403);
  });
  assert.equal(count,1);
});

test('regular MCP VPC failure is fail-closed, never falls back to public fetch',async()=>{
  const base={...env,ATLASSIAN_UPSTREAM_MODE:'local_relay_vpc',
    LOCAL_RELAY_BEARER_TOKEN:'r'.repeat(48)};
  let publicCalls=0;
  await withFetch(async()=>{publicCalls++;throw Error('public fallback forbidden');},async()=>{
    for(const broken of [
      {...base,ATLASSIAN_RELAY_VPC:null},
      {...base,ATLASSIAN_RELAY_VPC:{}},
      {...base,LOCAL_RELAY_BEARER_TOKEN:''},
    ]){
      const r=await worker.fetch(request('POST',call('ping',{},1),auth),broken);
      assert.equal(r.status,503);
      assert.equal((await r.json()).error,'upstream_not_configured');
    }
    const thrown=await worker.fetch(request('POST',call('ping',{},2),auth),{
      ...base,ATLASSIAN_RELAY_VPC:{fetch:async()=>{throw Error('internal details');}}});
    assert.equal(thrown.status,502);
    assert.equal((await thrown.json()).error,'upstream_unavailable');
    for(const status of [401,403,302]){
      const r=await worker.fetch(request('POST',call('ping',{},3),auth),{
        ...base,ATLASSIAN_RELAY_VPC:{fetch:async()=>new Response('PRIVATE',{
          status,headers:{location:'https://bad.example/','www-authenticate':'Basic realm="private"'}})}});
      assert.equal(r.status,502);
      const b=await r.json();
      assert.equal(b.error,status===302?'unexpected_upstream_redirect':'upstream_authorization_failed');
      assert.equal(r.headers.get('location'),null);
      assert.equal(r.headers.get('www-authenticate'),null);
    }
  });
  assert.equal(publicCalls,0);
});

test('legacy public relay mode remains selectable with existing Access headers',async()=>{
  const orig={...env,ATLASSIAN_UPSTREAM_MODE:'local_relay',
    LOCAL_RELAY_BEARER_TOKEN:'r'.repeat(48),
    CF_ACCESS_CLIENT_ID:'test-client-id',
    CF_ACCESS_CLIENT_SECRET:'s'.repeat(48),
    LOCAL_RELAY_ORIGIN:'https://atlassian-relay.example.com/'};
  await withFetch(async(url,opts)=>{
    assert.equal(String(url),'https://atlassian-relay.example.com/mcp');
    assert.equal(opts.headers.get('cf-access-client-id'),'test-client-id');
    assert.equal(opts.headers.get('cf-access-client-secret'),'s'.repeat(48));
    return Response.json({jsonrpc:'2.0',id:1,result:{}});
  },async()=>{
    const r=await worker.fetch(request('POST',call('ping',{},1),auth),orig);
    assert.equal(r.status,200);
  });
});
