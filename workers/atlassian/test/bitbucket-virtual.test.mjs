import test from 'node:test';
import assert from 'node:assert/strict';
import {createMcpRelay} from '@mcp-bridge/core';
import liveWorker from '../src/index.mjs';
import {bitbucketVirtualTool} from '../src/bitbucket.mjs';

const portal='p'.repeat(48);
const relay='r'.repeat(48);
const vpcUrl='http://127.0.0.1/mcp';
const workspace='diamondhead';
const approval={
  slug:workspace,
  ownerDecisionRef:'https://github.com/yohi/mcp-bridge-workers/blob/'+'a'.repeat(40)+'/docs/owner-decision.md',
  ownerDecisionSha256:'b'.repeat(64),
};
const enabledSpec={...bitbucketVirtualTool,workspaceBinding:{
  approved:approval,envKey:'BITBUCKET_WORKSPACE_SLUG',
}};
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
test('unapproved production virtual tool remains invisible and fails closed',async()=>{
  let calls=0;
  const env=mockEnv(async()=>{calls++;return new Response(JSON.stringify({
    jsonrpc:'2.0',id:1,result:{tools:[{name:'executeRead'}]},
  }),{headers:{'content-type':'application/json'}});});
  const list=await invoke(liveWorker,env,rpc('tools/list',{},1));
  assert.equal(list.status,200);
  assert.equal(list.body.result.tools.length,0);
  const blocked=await invoke(liveWorker,env,rpc('tools/call',{
    name:'listBitbucketRepositories',arguments:{},
  },2));
  assert.equal(blocked.status,503);
  assert.equal(blocked.body.error.code,-32050);
  assert.equal(calls,1);
});
test('approved binding exposes one virtual definition after allowed metadata only',async()=>{
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
        inputs:{workspaceId:'diamondhead',page:1,pagelen:25},
      },
    },55));
    return result(55,{values:[
      {name:'Android App',full_name:'diamondhead/android-app'},
      {name:'Backend',full_name:'diamondhead/backend'},
    ],next:'https://api.bitbucket.org/private'});
  });
  const response=await invoke(makeWorker(),env,rpc('tools/call',{
    name:'listBitbucketRepositories',arguments:{},
  },55));
  assert.equal(response.status,200);
  assert.equal(hits,1);
  assert.equal(response.body.result.isError,false);
  assert.deepEqual(JSON.parse(response.body.result.content[0].text),{
    schemaVersion:1,workspace:'diamondhead',
    repositories:[{name:'Android App',slug:'android-app'},{name:'Backend',slug:'backend'}],
    truncated:true,
  });
  assert.equal(JSON.stringify(response.body).includes('api.bitbucket.org'),false);
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
      inputs:{workspaceId:'diamondhead'}},
  },57));
  assert.equal(direct.status,403);
  for(const overrides of [
    {BITBUCKET_WORKSPACE_SLUG:'other'},
    {BITBUCKET_WORKSPACE_SLUG:undefined},
    {BITBUCKET_WORKSPACE_SLUG:'Diamondhead'},
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
    values:[{name:'x'.repeat(263_000),full_name:'diamondhead/x'}],
  })),rpc('tools/call',{name:'listBitbucketRepositories',arguments:{}},51));
  assert.equal(giant.status,502);
  assert.equal(giant.body.error.code,-32054);
  const collision=await invoke(w,mockEnv(async()=>new Response(JSON.stringify({
    jsonrpc:'2.0',id:52,result:{tools:[{name:'listBitbucketRepositories'}]},
  }),{headers:{'content-type':'application/json'}})),rpc('tools/list',{},52));
  assert.equal(collision.status,502);
});
