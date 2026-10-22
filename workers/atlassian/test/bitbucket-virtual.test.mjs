import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createMcpRelay} from '@mcp-bridge/core';
import liveWorker from '../src/index.mjs';
import {bitbucketVirtualTool} from '../src/bitbucket.mjs';

const portal='p'.repeat(48);
const relay='r'.repeat(48);
const vpcUrl='http://127.0.0.1/mcp';
const workspace='test-workspace';
const enabledSpec=bitbucketVirtualTool;
const makeWorker=()=>createMcpRelay({
  name:'test-atlassian',upstreamUrl:'https://mcp.atlassian.com/v2/mcp',
  allowedTools:['atlassianUserInfo','getAccessibleAtlassianResources','discover','executeRead'],
  virtualTool:enabledSpec,
});
const rpc=(method,params,id=123)=>({jsonrpc:'2.0',id,method,params});
const req=(body)=>new Request('https://bridge.example/mcp',{
  method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+portal},
  body:JSON.stringify(body),
});
function mockEnv(fetcher,overrides={}) {
  return {
    PORTAL_BEARER_TOKEN:portal,LOCAL_RELAY_BEARER_TOKEN:relay,
    ATLASSIAN_UPSTREAM_MODE:'local_relay_vpc',
    ATLASSIAN_UNVERIFIED_READ_TOOLS:'off',
    BITBUCKET_WORKSPACE_SLUG:workspace,
    ATLASSIAN_RELAY_VPC:{fetch:fetcher},
    ...overrides,
  };
}
function result(id,data) {
  return new Response(JSON.stringify({
    jsonrpc:'2.0',id,result:{content:[{type:'text',text:JSON.stringify(data)}]},
  }),{headers:{'content-type':'application/json'}});
}
async function invoke(worker,env,body) {
  const r=await worker.fetch(req(body),env);
  return {status:r.status,body:await r.json()};
}
test('production exposes virtual tool only with a valid Worker workspace setting',async()=>{
  let calls=0;
  const fetcher=async()=>{calls++;return new Response(JSON.stringify({
    jsonrpc:'2.0',id:1,result:{tools:[{name:'executeRead'}]},
  }),{headers:{'content-type':'application/json'}});};
  const enabled=await invoke(liveWorker,mockEnv(fetcher),rpc('tools/list',{},1));
  assert.equal(enabled.status,200);
  assert.deepEqual(enabled.body.result.tools.map(t=>t.name),['listBitbucketRepositories']);

  const missing=mockEnv(fetcher,{BITBUCKET_WORKSPACE_SLUG:undefined});
  const hidden=await invoke(liveWorker,missing,rpc('tools/list',{},1));
  assert.equal(hidden.status,200);
  assert.deepEqual(hidden.body.result.tools,[]);
  const blocked=await invoke(liveWorker,missing,rpc('tools/call',{
    name:'listBitbucketRepositories',arguments:{},
  },2));
  assert.equal(blocked.status,503);
  assert.equal(blocked.body.error.code,-32050);
  assert.equal(calls,2);
});
test('checked-in deployment config preserves VPC, nested-read denial and matching workspace',()=>{
  const config=JSON.parse(readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8'));
  assert.equal(config.vars.ATLASSIAN_UPSTREAM_MODE,'local_relay_vpc');
  assert.equal(config.vars.ATLASSIAN_UNVERIFIED_READ_TOOLS,'off');
  assert.equal(bitbucketVirtualTool.workspaceBinding.envKey,'BITBUCKET_WORKSPACE_SLUG');
  assert.equal(Object.hasOwn(bitbucketVirtualTool.workspaceBinding,'slug'),false);
  assert.equal(Object.hasOwn(config.vars,'BITBUCKET_WORKSPACE_SLUG'),false);
  const deployWorkflow=readFileSync(
    new URL('../../../.github/workflows/deploy-atlassian.yml',import.meta.url),'utf8');
  assert.match(deployWorkflow,/vars\.BITBUCKET_WORKSPACE_SLUG/);
  assert.match(deployWorkflow,/\bvars: \|\s+BITBUCKET_WORKSPACE_SLUG/);
  assert.match(deployWorkflow,/Configure a valid BITBUCKET_WORKSPACE_SLUG/);
  assert.equal(config.vpc_services[0].binding,'ATLASSIAN_RELAY_VPC');
  assert.deepEqual(config.secrets.required,['PORTAL_BEARER_TOKEN','LOCAL_RELAY_BEARER_TOKEN']);
});
test('fixed binding exposes one virtual definition after allowed metadata only',async()=>{
  const seen=[];
  const env=mockEnv(async(url,opts)=>{
    seen.push({url,body:JSON.parse(new TextDecoder().decode(opts.body))});
    return new Response(JSON.stringify({
      jsonrpc:'2.0',id:opts.body?JSON.parse(new TextDecoder().decode(opts.body)).id:123,
      result:{tools:[
        {name:'executeRead'},{name:'executeWrite'},
        {name:'atlassianUserInfo'},{name:'getAccessibleAtlassianResources'},
      ],nextCursor:'next'},
    }),{headers:{'content-type':'application/json'}});
  });
  const w=makeWorker();
  const first=await invoke(w,env,rpc('tools/list',{},77));
  assert.equal(first.status,200);
  assert.deepEqual(first.body.result.tools.map(x=>x.name),[
    'atlassianUserInfo','getAccessibleAtlassianResources','listBitbucketRepositories',
  ]);
  assert.deepEqual(first.body.result.tools[2].inputSchema,{
    type:'object',properties:{},additionalProperties:false,
  });
  assert.equal(first.body.result.nextCursor,'next');
  const second=await invoke(w,env,rpc('tools/list',{cursor:'next'},78));
  assert.deepEqual(second.body.result.tools.map(x=>x.name),[
    'atlassianUserInfo','getAccessibleAtlassianResources',
  ]);
  assert.equal(seen.length,2);
});
test('virtual read sends exactly one fixed VPC request and normalizes full_name slug',async()=>{
  let hits=0;
  const env=mockEnv(async(url,opts)=>{
    hits++;
    assert.equal(url,vpcUrl);
    assert.equal(opts.headers.get('authorization'),'Bearer '+relay);
    assert.equal(opts.headers.get('cf-access-client-id'),null);
    assert.equal(opts.redirect,'manual');
    const body=JSON.parse(opts.body);
    assert.deepEqual(body,rpc('tools/call',{
      name:'executeRead',arguments:{
        name:'listBitbucketRepositories',
        inputs:{workspaceId:'test-workspace',page:1,pagelen:25},
      },
    },55));
    return result(55,{values:[
      {name:'Android App',full_name:'test-workspace/android-app'},
      {name:'Backend',full_name:'test-workspace/backend'},
    ],next:'https://api.bitbucket.org/private'});
  });
  const response=await invoke(makeWorker(),env,rpc('tools/call',{
    name:'listBitbucketRepositories',arguments:{},
  },55));
  assert.equal(response.status,200);
  assert.equal(hits,1);
  assert.equal(response.body.result.isError,false);
  assert.deepEqual(JSON.parse(response.body.result.content[0].text),{
    schemaVersion:1,workspace:'test-workspace',
    repositories:[{name:'Android App',slug:'android-app'},{name:'Backend',slug:'backend'}],
    truncated:true,
  });
  assert.equal(JSON.stringify(response.body).includes('api.bitbucket.org'),false);
});
test('workspace is taken exclusively from validated Worker env, never from a source slug or caller',async()=>{
  const alternative='team_two';
  let upstreamCalls=0;
  const env=mockEnv(async(url,opts)=>{
    upstreamCalls++;
    assert.equal(url,vpcUrl);
    const body=JSON.parse(opts.body);
    assert.deepEqual(body.params,{
      name:'executeRead',
      arguments:{
        name:'listBitbucketRepositories',
        inputs:{workspaceId:alternative,page:1,pagelen:25},
      },
    });
    return result(62,{values:[{name:'Other Project',full_name:alternative+'/other-project'}]});
  },{BITBUCKET_WORKSPACE_SLUG:alternative});
  const good=await invoke(liveWorker,env,rpc('tools/call',{
    name:'listBitbucketRepositories',arguments:{},
  },62));
  assert.equal(good.status,200);
  assert.deepEqual(JSON.parse(good.body.result.content[0].text),{
    schemaVersion:1,workspace:alternative,
    repositories:[{name:'Other Project',slug:'other-project'}],truncated:false,
  });
  for (const arguments_ of [{workspace:'test-workspace'},{workspaceId:'test-workspace'}]) {
    const denied=await invoke(liveWorker,env,rpc('tools/call',{
      name:'listBitbucketRepositories',arguments:arguments_,
    },63));
    assert.equal(denied.status,400);
    assert.equal(denied.body.error.code,-32602);
  }
  assert.equal(upstreamCalls,1);
});
test('boolean nextPage controls truncated when next URL is absent',async()=>{
  for (const nextPage of [true,false]) {
    const response=await invoke(
      makeWorker(),
      mockEnv(async()=>result(61,{
        values:[{name:'Backend',full_name:'test-workspace/backend'}],
        nextPage,
      })),
      rpc('tools/call',{name:'listBitbucketRepositories',arguments:{}},61),
    );
    assert.equal(response.status,200);
    const page=JSON.parse(response.body.result.content[0].text);
    assert.equal(page.truncated,nextPage);
    assert.deepEqual(page.repositories,[{name:'Backend',slug:'backend'}]);
  }
});
test('invalid virtual arguments, disallowed direct read and malformed workspace do not reach upstream',async()=>{
  let calls=0;
  const w=makeWorker(),env=mockEnv(async()=>{calls++;throw Error('must not call');});
  for(const args of [undefined,null,[],{workspace:'other'},{name:'executeWrite'},{inputs:{}},{cloudId:'bad'},{page:2}]) {
    const r=await invoke(w,env,rpc('tools/call',{
      name:'listBitbucketRepositories',...(args===undefined?{}:{arguments:args}),
    },56));
    assert.equal(r.status,400);
    assert.equal(r.body.error.code,-32602);
  }
  const direct=await invoke(w,env,rpc('tools/call',{
    name:'executeRead',arguments:{name:'listBitbucketRepositories',
      inputs:{workspaceId:'test-workspace'}},
  },57));
  assert.equal(direct.status,403);
  for(const overrides of [
    {BITBUCKET_WORKSPACE_SLUG:''},
    {BITBUCKET_WORKSPACE_SLUG:undefined},
    {BITBUCKET_WORKSPACE_SLUG:'InvalidUpperCase'},
    {BITBUCKET_WORKSPACE_SLUG:'bad/workspace'},
    {BITBUCKET_WORKSPACE_SLUG:' test-workspace'},
    {ATLASSIAN_UNVERIFIED_READ_TOOLS:'on'},
    {ATLASSIAN_UPSTREAM_MODE:'direct'},
  ]) {
    const out=await invoke(w,mockEnv(async()=>{calls++;throw Error('must not');},overrides),
      rpc('tools/call',{name:'listBitbucketRepositories',arguments:{}},88));
    assert.equal(out.status,503);
  }
  assert.equal(calls,0);
});
test('wrong bearer and forged upstream tool names do not execute virtual call',async()=>{
  let calls=0;
  const w=makeWorker(),env=mockEnv(async()=>{calls++;return result(1,{values:[]});});
  const unauthorized=await w.fetch(new Request('https://bridge.example/mcp',{
    method:'POST',headers:{authorization:'Bearer '+'z'.repeat(48),'content-type':'application/json'},
    body:JSON.stringify(rpc('tools/call',{name:'listBitbucketRepositories',arguments:{}},1)),
  }),env);
  assert.equal(unauthorized.status,401);
  for(const name of ['discover','executeWrite','executeDestructive']) {
    assert.equal((await invoke(w,env,rpc('tools/call',{name,arguments:{}},1))).status,403);
  }
  assert.equal(calls,0);
});
test('virtual tool detects invalid HTTP, JSON-RPC IDs, schema drift and workspace mismatch',async()=>{
  const w=makeWorker(),call=rpc('tools/call',{
    name:'listBitbucketRepositories',arguments:{},
  },79);
  const cases=[
    [new Response('no',{status:403} ),502,-32051],
    [new Response('no',{status:429} ),502,-32053],
    [new Response('no',{status:404} ),502,-32055],
    [new Response('no',{status:302,headers:{location:'https://evil.example'}}),502,-32053],
    [new Response(null,{status:204}),502,-32054],
    [new Response('not-json',{headers:{'content-type':'application/json'}}),502,-32054],
    [result(80,{values:[]}),502,-32054],
    [result(79,{values:[{name:'x',full_name:'other/x'}]}),502,-32054],
    [result(79,{values:[{name:'x'}]}),502,-32054],
    [result(79,{next:123,values:[]}),502,-32054],
    ...[null,'true',1,{},[]].map(nextPage=>[
      result(79,{nextPage,values:[]}),502,-32054,
    ]),
  ];
  for (const [upstream,status,code] of cases) {
    const output=await invoke(w,mockEnv(async()=>upstream),call);
    assert.equal(output.status,status);
    assert.equal(output.body.error.code,code);
    assert.equal(JSON.stringify(output.body).includes('evil.example'),false);
  }
});
test('oversized response and collision in upstream list both fail closed',async()=>{
  const w=makeWorker();
  const giant=await invoke(w,mockEnv(async()=>result(51,{
    values:[{name:'x'.repeat(263_000),full_name:'test-workspace/x'}],
  })),rpc('tools/call',{name:'listBitbucketRepositories',arguments:{}},51));
  assert.equal(giant.status,502);
  assert.equal(giant.body.error.code,-32054);
  const collision=await invoke(w,mockEnv(async()=>new Response(JSON.stringify({
    jsonrpc:'2.0',id:52,result:{tools:[{name:'listBitbucketRepositories'}]},
  }),{headers:{'content-type':'application/json'}})),rpc('tools/list',{},52));
  assert.equal(collision.status,502);
});
